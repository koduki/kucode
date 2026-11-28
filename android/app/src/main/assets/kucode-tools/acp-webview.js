'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');
const {
  DEFAULT_AGENT_PRESETS,
  resolveExecutableOnPath,
  resolveSafeWorkspacePath,
  isAuthRequiredError,
  AcpSessionClient,
} = require('./acp-client');

function createNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0 && folders[0].uri && folders[0].uri.fsPath) {
    return folders[0].uri.fsPath;
  }
  return '/workspace';
}

function getApplicationSetting(cfg, key, fallback) {
  if (cfg && typeof cfg.inspect === 'function') {
    const inspected = cfg.inspect(key);
    if (inspected && typeof inspected === 'object') {
      if (inspected.globalValue !== undefined) return inspected.globalValue;
      if (inspected.globalRemoteValue !== undefined) return inspected.globalRemoteValue;
      if (inspected.defaultValue !== undefined) return inspected.defaultValue;
      return fallback;
    }
  }
  const value = cfg && typeof cfg.get === 'function' ? cfg.get(key) : undefined;
  return value !== undefined ? value : fallback;
}

function getConfiguredAgents() {
  const cfg = vscode.workspace.getConfiguration('kucode');
  const custom = getApplicationSetting(cfg, 'acp.agents', {}) || {};
  const merged = {};
  for (const [id, preset] of Object.entries(DEFAULT_AGENT_PRESETS)) {
    merged[id] = { ...preset };
  }
  if (custom && typeof custom === 'object') {
    for (const [id, entry] of Object.entries(custom)) {
      if (!entry || typeof entry !== 'object' || !entry.command) continue;
      merged[id] = {
        id,
        label: entry.label || id,
        command: String(entry.command),
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: entry.env && typeof entry.env === 'object' ? { ...entry.env } : {},
        installCommand: entry.installCommand || '',
        loginCommand: entry.loginCommand || '',
        description: entry.description || '',
      };
    }
  }
  return merged;
}

function redactErrorMessage(raw) {
  if (raw === undefined || raw === null) return '';
  let out = String(raw);
  const adminToken = typeof process.env.KUCODE_ADMIN_TOKEN === 'string' ? process.env.KUCODE_ADMIN_TOKEN.trim() : '';
  if (adminToken.length >= 8 && out.includes(adminToken)) {
    out = out.split(adminToken).join('[REDACTED_TOKEN]');
  }
  out = out.replace(/-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z0-9 ]*PRIVATE KEY-{5}/g, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(/\b(https?|wss?|ftp|ssh|git):\/\/([^:@\s"'/]+):([^@\s"'/]+)@/gi, '$1://$2:[REDACTED]@');
  out = out.replace(/([?&#])(tkn|token|access_token|refresh_token|id_token|client_secret|code|api_key|apikey|key|secret|password|passwd|x-amz-signature|x-amz-security-token)=([^&#\s"']+)/gi, '$1$2=[REDACTED]');
  out = out.replace(/(vscode-tkn)=([^;\s"']+)/gi, '$1=[REDACTED]');
  out = out.replace(/((?:X-KuCode-Token|X-API-Key|X-Goog-Api-Key|Anthropic-Api-Key|Proxy-Authorization)\s*:\s*)([^\r\n]+)/gim, '$1[REDACTED]');
  out = out.replace(/(Authorization\s*:\s*(?:(?:Bearer|Basic|Token|Digest|AWS4-HMAC-SHA256)\s+)?)([^\r\n"']+)/gim, '$1[REDACTED]');
  out = out.replace(/\b((?:Bearer|Basic|Token)\s+)([^\s"';,]+)/gi, '$1[REDACTED]');
  out = out.replace(/\b([A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASSWD)=)([^\s"'`]+)/gi, '$1[REDACTED]');
  out = out.replace(/("(?:access_token|refresh_token|id_token|client_secret|api_key|apiKey|password|secret|token|authorization)"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED_GH_TOKEN]');
  out = out.replace(/\b(sk-(?:proj-|ant-[A-Za-z0-9_-]*|svcacct-)?[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]');
  out = out.replace(/\b(AIza[0-9A-Za-z_-]{35})\b/g, '[REDACTED_GOOGLE_KEY]');
  out = out.replace(/\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g, '[REDACTED_SLACK_TOKEN]');
  out = out.replace(/\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '[REDACTED_AWS_KEY]');
  out = out.replace(/\b(hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]');
  return out.slice(0, 512);
}

class AcpChatViewProvider {
  constructor(options) {
    this.reportHostEvent = (options && options.reportHostEvent) || (() => {});
    this.reportHostSpan = (options && options.reportHostSpan) || null;
    this.writeHostClipboard = (options && options.writeHostClipboard) || null;
    this.extensionVersion = (options && options.extensionVersion) || '0.10.1';
    this.webviewView = null;
    this.client = null;
    this.activeAgentId = 'antigravity';
    this.permissionMode = 'ask';
    this.pendingPermissions = new Map();
    this.nextPermSeq = 1;
    this.isPrompting = false;
    this.availableCommands = [];
    this.configOptions = [];
    this.sessionTitle = '';
    this.pendingAttachments = [];
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    const cfg = vscode.workspace.getConfiguration('kucode');
    this.activeAgentId = getApplicationSetting(cfg, 'acp.defaultAgent', 'antigravity') || 'antigravity';
    this.permissionMode = getApplicationSetting(cfg, 'acp.permissionMode', 'ask') || 'ask';

    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.buildWebviewHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      this._handleWebviewMessage(msg).catch((err) => {
        this._post({ type: 'error', message: err && err.message ? err.message : String(err) });
      });
    });

    webviewView.onDidDispose(() => {
      this._cancelAllPendingPermissions();
      if (this.client) {
        this.client.dispose().catch(() => {});
        this.client = null;
      }
      this.webviewView = null;
    });
  }

  async attachActiveSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('アクティブなエディタがありません');
      return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const text = sel && !sel.isEmpty ? doc.getText(sel) : doc.getText();
    const startLine = sel && !sel.isEmpty ? sel.start.line + 1 : 1;
    const endLine = sel && !sel.isEmpty ? sel.end.line + 1 : doc.lineCount;
    const root = getWorkspaceRoot();
    const absPath = doc.uri && doc.uri.fsPath ? doc.uri.fsPath : doc.fileName;
    const relPath = absPath && root ? path.relative(root, absPath) : path.basename(absPath || 'untitled');
    const clipped = text.length > 32 * 1024 ? text.slice(0, 32 * 1024) + '\n...[truncated]' : text;
    const attachment = {
      id: 'att-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      label: `${relPath}:L${startLine}-L${endLine}`,
      path: absPath,
      startLine,
      endLine,
      text: clipped,
    };
    this.pendingAttachments.push(attachment);
    if (this.webviewView && typeof this.webviewView.show === 'function') {
      this.webviewView.show(true);
    }
    this._post({ type: 'attachments', items: this.pendingAttachments.map(({ id, label }) => ({ id, label })) });
  }

  async openInTerminal(commandText, name = 'KuCode ACP Setup') {
    const term = vscode.window.createTerminal({ name });
    term.show(false);
    term.sendText(commandText, true);
  }

  async dispose() {
    this._cancelAllPendingPermissions();
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }
  }

  _post(payload) {
    if (this.webviewView && this.webviewView.webview) {
      this.webviewView.webview.postMessage(payload);
    }
  }

  _pushBootstrapState() {
    const agentsMap = getConfiguredAgents();
    const agents = Object.values(agentsMap).map((a) => ({
      id: a.id,
      label: a.label,
      command: a.command,
      installed: Boolean(resolveExecutableOnPath(a.command, a.env && a.env.PATH, process.env.HOME)),
      installCommand: a.installCommand || '',
      loginCommand: a.loginCommand || '',
      description: a.description || '',
    }));
    if (!agentsMap[this.activeAgentId] && agents.length > 0) {
      this.activeAgentId = agents[0].id;
    }
    this._post({
      type: 'bootstrap',
      agents,
      activeAgentId: this.activeAgentId,
      permissionMode: this.permissionMode,
      connected: Boolean(this.client && this.client.connected),
      sessionId: this.client ? this.client.sessionId : null,
      agentInfo: this.client ? this.client.agentInfo : null,
      sessionTitle: this.sessionTitle,
      configOptions: this.configOptions,
      commands: this.availableCommands,
      attachments: this.pendingAttachments.map(({ id, label }) => ({ id, label })),
    });
  }

  _buildLoginDetail(spec, rawDetail) {
    const base = rawDetail || '';
    if (spec && spec.id === 'antigravity') {
      const hint = 'ターミナルで "agy acp --login" を実行して Google 認証（または環境変数 GEMINI_API_KEY）を完了後、「再検出して接続」を押してください。';
      return base ? `${base}\n${hint}` : hint;
    }
    return base || 'ターミナルで認証を完了した後、「再検出して接続」を押してください。';
  }

  async _handleWebviewMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (vscode.workspace.isTrusted === false &&
        ['connect', 'newSession', 'sendPrompt', 'runInstall', 'runLogin', 'setConfigOption'].includes(msg.type)) {
      this._post({type: 'error', message: 'Trust this workspace before starting an ACP agent.'});
      return;
    }
    switch (msg.type) {
      case 'ready':
      case 'refreshAgents':
        this._pushBootstrapState();
        return;

      case 'selectAgent': {
        const nextId = String(msg.agentId || '').trim();
        if (nextId && nextId !== this.activeAgentId) {
          this.activeAgentId = nextId;
          await this._disconnectClient();
        }
        this._pushBootstrapState();
        return;
      }

      case 'setPermissionMode':
        this.permissionMode = msg.mode === 'allowAll' ? 'allowAll' : 'ask';
        this._post({ type: 'permissionMode', mode: this.permissionMode });
        return;

      case 'setConfigOption': {
        if (!this.client || !this.client.connected) return;
        const configId = String(msg.configId || '').trim();
        if (!configId) return;
        const updated = await this.client.setConfigOption(configId, msg.value, msg.optionType);
        this.configOptions = Array.isArray(updated) ? updated : [];
        this._post({ type: 'configOptions', items: this.configOptions });
        return;
      }

      case 'connect':
        await this._ensureConnected(true);
        return;

      case 'newSession':
        await this._disconnectClient();
        this._post({ type: 'cleared' });
        await this._ensureConnected(true);
        return;

      case 'sendPrompt':
        await this._sendPrompt(String(msg.text || ''));
        return;

      case 'cancel':
        if (this.client) {
          this.client.cancel();
        }
        this._cancelAllPendingPermissions();
        return;

      case 'permissionDecision':
        this._resolvePermission(String(msg.permId || ''), msg.optionId ? String(msg.optionId) : null);
        return;

      case 'attachSelection':
        await this.attachActiveSelection();
        return;

      case 'removeAttachment':
        this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== msg.id);
        this._post({ type: 'attachments', items: this.pendingAttachments.map(({ id, label }) => ({ id, label })) });
        return;

      case 'runInstall': {
        const agent = getConfiguredAgents()[this.activeAgentId];
        const cmd = (agent && agent.installCommand) || DEFAULT_AGENT_PRESETS.antigravity.installCommand;
        await this.openInTerminal(cmd, 'KuCode: ' + (agent ? agent.label : 'Agent Setup'));
        return;
      }

      case 'runLogin': {
        const agent = getConfiguredAgents()[this.activeAgentId];
        const cmd = (agent && agent.loginCommand) || DEFAULT_AGENT_PRESETS.antigravity.loginCommand;
        await this.openInTerminal(cmd, 'KuCode: ' + (agent ? agent.label : 'Agent Login'));
        return;
      }

      case 'openLocation':
        await this._openWorkspaceFileLocation(String(msg.path || ''), Number(msg.line) || 1);
        return;

      case 'copyText':
        if (typeof this.writeHostClipboard === 'function') {
          await this.writeHostClipboard(String(msg.text || ''));
        } else if (vscode.env && vscode.env.clipboard) {
          await vscode.env.clipboard.writeText(String(msg.text || ''));
        }
        return;
    }
  }

  async _disconnectClient() {
    this._cancelAllPendingPermissions();
    this.isPrompting = false;
    this.availableCommands = [];
    this.configOptions = [];
    this.sessionTitle = '';
    if (this.client) {
      const old = this.client;
      this.client = null;
      await old.dispose();
    }
    this._post({ type: 'configOptions', items: [] });
    this._post({ type: 'status', state: 'disconnected', message: '未接続' });
  }

  async _ensureConnected(forceReconnect = false) {
    if (vscode.workspace.isTrusted === false) throw new Error('Trust this workspace before starting an ACP agent.');
    if (this.client && this.client.connected && !forceReconnect) {
      return this.client;
    }
    await this._disconnectClient();

    const agents = getConfiguredAgents();
    const spec = agents[this.activeAgentId];
    if (!spec) {
      throw new Error('エージェント設定が見つかりません: ' + this.activeAgentId);
    }

    const resolved = resolveExecutableOnPath(spec.command, spec.env && spec.env.PATH, process.env.HOME);
    if (!resolved) {
      this._post({
        type: 'needsSetup',
        agentId: spec.id,
        label: spec.label,
        command: spec.command,
        installCommand: spec.installCommand || '',
        loginCommand: spec.loginCommand || '',
      });
      return null;
    }

    this._post({ type: 'status', state: 'connecting', message: `${spec.label} へ接続中...` });
    this.reportHostEvent('INFO', 'ext.acp', `Connecting ACP agent=${spec.id} (${spec.command})`);

    const workspaceRoot = getWorkspaceRoot();
    const client = new AcpSessionClient({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      workspaceRoot,
      clientVersion: this.extensionVersion,
      onPermissionRequest: (params) => this._handlePermissionFromAgent(params),
      readOpenEditorText: async (absPath) => {
        const openDoc = (vscode.workspace.textDocuments || []).find(
          (d) => d && d.uri && d.uri.fsPath === absPath
        );
        return openDoc ? openDoc.getText() : null;
      },
      writeOpenEditorText: async (absPath, content) => {
        const openDoc = (vscode.workspace.textDocuments || []).find(
          (d) => d && d.uri && d.uri.fsPath === absPath
        );
        if (!openDoc) return false;
        const fullRange = new vscode.Range(
          openDoc.positionAt(0),
          openDoc.positionAt(openDoc.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(openDoc.uri, fullRange, content);
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied && typeof openDoc.save === 'function') {
          await openDoc.save();
        }
        return applied;
      },
    });

    client.on('sessionUpdate', (params) => {
      const update = params && params.update ? params.update : null;
      if (!update) return;
      if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
        this.availableCommands = update.availableCommands.map((c) => ({
          name: String(c.name || ''),
          description: String(c.description || ''),
        }));
      } else if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        this.configOptions = update.configOptions;
      } else if (update.sessionUpdate === 'session_info_update' && update.title) {
        this.sessionTitle = String(update.title);
      }
      this._post({ type: 'sessionUpdate', update });
    });

    client.on('stderr', (line) => {
      this._post({ type: 'stderr', text: line });
      if (isAuthRequiredError(line)) {
        this._post({
          type: 'needsLogin',
          agentId: spec.id,
          label: spec.label,
          loginCommand: spec.loginCommand || '',
          detail: this._buildLoginDetail(spec, line),
        });
      }
    });

    client.on('exit', ({ code, signal }) => {
      if (this.client === client) {
        this.client = null;
        this.isPrompting = false;
        this.configOptions = [];
        this.sessionTitle = '';
        this._cancelAllPendingPermissions();
        this._post({ type: 'configOptions', items: [] });
        this._post({
          type: 'status',
          state: 'disconnected',
          message: `切断されました (code=${code}, signal=${signal || 'none'})`,
        });
      }
    });

    client.on('error', (err) => {
      this.reportHostEvent('WARN', 'ext.acp', `ACP error (${spec.id}): ${err && err.message ? err.message : err}`);
    });

    this.client = client;
    try {
      const info = await client.connect();
      this.configOptions = Array.isArray(info.configOptions) ? info.configOptions : [];
      const title = (info.agentInfo && (info.agentInfo.title || info.agentInfo.name)) || spec.label;
      const version = info.agentInfo && info.agentInfo.version ? ' v' + info.agentInfo.version : '';
      this._post({
        type: 'status',
        state: 'connected',
        message: `${title}${version}`,
        sessionId: info.sessionId,
      });
      this._post({
        type: 'configOptions',
        items: this.configOptions,
      });
      return client;
    } catch (err) {
      await this._disconnectClient();
      const message = err && err.message ? err.message : String(err);
      this._post({ type: 'error', message: `接続失敗: ${message}` });
      if (isAuthRequiredError(err)) {
        this._post({
          type: 'needsLogin',
          agentId: spec.id,
          label: spec.label,
          loginCommand: spec.loginCommand || '',
          authMethods: Array.isArray(err && err.authMethods) ? err.authMethods : [],
          detail: this._buildLoginDetail(spec, message),
        });
      }
      return null;
    }
  }

  _reportTurnSpan({ startMs, endMs, status, statusMessage, agentId, stopReason, attachmentCount }) {
    if (typeof this.reportHostSpan !== 'function') return;
    const payload = {
      name: 'acp.turn',
      kind: 'CLIENT',
      startMs,
      endMs,
      status,
      attributes: {
        'kucode.acp.agent': String(agentId || 'unknown'),
        'kucode.acp.stop_reason': String(stopReason || ''),
        'kucode.acp.attachment_count': Number(attachmentCount) || 0,
      },
    };
    if (statusMessage) {
      payload.statusMessage = statusMessage;
    }
    Promise.resolve(this.reportHostSpan(payload, process.env.TRACEPARENT)).catch(() => {});
  }

  async _sendPrompt(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed && this.pendingAttachments.length === 0) return;
    if (this.isPrompting) return;

    const client = await this._ensureConnected(false);
    if (!client) return;

    const attachments = this.pendingAttachments.splice(0, this.pendingAttachments.length);
    const attachmentCount = attachments.length;
    const agentId = this.activeAgentId;
    this._post({ type: 'attachments', items: [] });

    const blocks = [];
    if (trimmed) {
      blocks.push({ type: 'text', text: trimmed });
    }
    for (const att of attachments) {
      blocks.push({
        type: 'text',
        text: `\n[Attached selection: ${att.label}]\n\`\`\`\n${att.text}\n\`\`\``,
      });
    }

    this.isPrompting = true;
    const turnStartMs = Date.now();
    this._post({
      type: 'turnStart',
      userText: trimmed,
      attachments: attachments.map((a) => a.label),
    });

    try {
      const result = await client.prompt(blocks);
      const stopReason = (result && result.stopReason) || 'end_turn';
      this._post({
        type: 'turnEnd',
        stopReason,
      });
      this._reportTurnSpan({
        startMs: turnStartMs,
        endMs: Math.max(turnStartMs, Date.now()),
        status: 'OK',
        agentId,
        stopReason,
        attachmentCount,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this._post({ type: 'turnError', message });
      this._reportTurnSpan({
        startMs: turnStartMs,
        endMs: Math.max(turnStartMs, Date.now()),
        status: 'ERROR',
        statusMessage: redactErrorMessage(message),
        agentId,
        stopReason: 'error',
        attachmentCount,
      });
      if (isAuthRequiredError(err)) {
        const spec = getConfiguredAgents()[this.activeAgentId];
        this._post({
          type: 'needsLogin',
          agentId: this.activeAgentId,
          label: (spec && spec.label) || this.activeAgentId,
          loginCommand: (spec && spec.loginCommand) || DEFAULT_AGENT_PRESETS.antigravity.loginCommand,
          detail: this._buildLoginDetail(spec, message),
        });
      }
    } finally {
      this.isPrompting = false;
    }
  }

  _handlePermissionFromAgent(params) {
    const options = Array.isArray(params && params.options) ? params.options : [];
    const toolCall = (params && params.toolCall) || {};
    if (this.permissionMode === 'allowAll') {
      const allow = options.find((o) => o && (o.kind === 'allow_once' || o.kind === 'allow_always'));
      if (allow) {
        return Promise.resolve({
          outcome: { outcome: 'selected', optionId: allow.optionId },
        });
      }
    }
    return new Promise((resolve) => {
      const permId = 'perm-' + this.nextPermSeq++;
      this.pendingPermissions.set(permId, resolve);
      this._post({
        type: 'permissionRequest',
        permId,
        title: toolCall.title || toolCall.name || 'ツール実行の承認',
        kind: toolCall.kind || '',
        rawInput: toolCall.rawInput !== undefined ? JSON.stringify(toolCall.rawInput, null, 2).slice(0, 1200) : '',
        options: options.map((o) => ({
          optionId: String(o.optionId || ''),
          name: String(o.name || o.optionId || ''),
          kind: String(o.kind || ''),
        })),
      });
    });
  }

  _resolvePermission(permId, optionId) {
    const resolver = this.pendingPermissions.get(permId);
    if (!resolver) return;
    this.pendingPermissions.delete(permId);
    if (optionId) {
      resolver({ outcome: { outcome: 'selected', optionId } });
    } else {
      resolver({ outcome: { outcome: 'cancelled' } });
    }
  }

  _cancelAllPendingPermissions() {
    for (const resolver of this.pendingPermissions.values()) {
      resolver({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
    this._post({ type: 'clearPermissions' });
  }

  async _openWorkspaceFileLocation(rawPath, line) {
    if (!rawPath) return;
    try {
      const safePath = resolveSafeWorkspacePath(getWorkspaceRoot(), rawPath);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(safePath));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const zeroLine = Math.max(0, (line || 1) - 1);
      const pos = new vscode.Position(Math.min(zeroLine, Math.max(0, doc.lineCount - 1)), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    } catch (err) {
      vscode.window.showErrorMessage('ファイルを開けませんでした: ' + (err && err.message ? err.message : err));
    }
  }

  buildWebviewHtml(webview) {
    const nonce = createNonce();
    const cspSource = (webview && webview.cspSource) || '';
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root {
    --bg: var(--vscode-sideBar-background, #000000);
    --surface: #0a0d12;
    --card: #0d1117;
    --fg: var(--vscode-editor-foreground, #f3f4f6);
    --muted: #9ca3af;
    --border: var(--vscode-panel-border, #1f2937);
    --accent: #38bdf8;
    --ok: #4ade80;
    --warn: #fbbf24;
    --err: #f87171;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 13px; font-weight: 500; line-height: 1.5;
    overflow: hidden;
  }
  .root { display: flex; flex-direction: column; height: 100vh; }
  .toolbar {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 8px; border-bottom: 1px solid var(--border); background: #05070a;
  }
  .toolbar select, .toolbar button, .config-bar select, .composer button, .banner button, .perm-bar button {
    background: var(--card); color: var(--fg); border: 1px solid var(--border);
    border-radius: 5px; padding: 4px 8px; font-size: 12px; font-weight: 500; cursor: pointer;
  }
  .toolbar select { flex: 1 1 130px; min-width: 110px; }
  .config-bar {
    display: none; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 5px 8px; border-bottom: 1px solid var(--border); background: #030508;
  }
  .config-bar.visible { display: flex; }
  .cfg-item {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted);
  }
  .cfg-item select { padding: 2px 6px; font-size: 11px; max-width: 210px; }
  button:hover { border-color: var(--accent); }
  button.primary { border-color: var(--accent); color: #ffffff; background: #0c2638; }
  button.danger { border-color: var(--err); color: #fecaca; }
  .status-line {
    display: flex; align-items: center; gap: 6px; padding: 4px 10px;
    font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.connected { background: var(--ok); }
  .dot.connecting { background: var(--warn); }
  .messages {
    flex: 1 1 auto; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px;
  }
  .msg {
    border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; background: var(--surface);
    word-break: break-word;
  }
  .msg.user { border-left: 3px solid var(--accent); background: #07111a; }
  .msg.assistant { border-left: 3px solid #64748b; }
  .msg.system { border-color: #374151; font-size: 12px; color: var(--muted); }
  .msg.error { border-color: var(--err); color: #fecaca; }
  .msg-role { font-size: 11px; color: var(--accent); margin-bottom: 4px; display: flex; justify-content: space-between; }
  .msg-body { white-space: pre-wrap; }
  .code-wrap { margin: 6px 0; border: 1px solid var(--border); border-radius: 5px; background: #000000; overflow: hidden; }
  .code-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 3px 8px; background: #0c1017; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted);
  }
  .code-wrap pre { margin: 0; padding: 8px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  details.thought, details.tool {
    margin-top: 6px; border: 1px solid var(--border); border-radius: 5px; padding: 4px 8px; background: #040609;
  }
  details summary { cursor: pointer; font-size: 12px; color: var(--muted); }
  .tool-status { font-size: 11px; margin-left: 6px; color: var(--accent); }
  .tool-loc {
    display: inline-block; margin: 4px 6px 0 0; font-size: 11px; color: var(--accent);
    text-decoration: underline; cursor: pointer; background: none; border: none; padding: 0;
  }
  .banner {
    margin: 8px 10px 0 10px; padding: 9px 10px; border: 1px solid var(--accent);
    border-radius: 6px; background: #061522; display: none; flex-direction: column; gap: 6px;
  }
  .banner.visible { display: flex; }
  .banner-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .perm-bar {
    display: none; flex-direction: column; gap: 6px; padding: 8px 10px;
    border-top: 2px solid var(--warn); background: #161105;
  }
  .perm-bar.visible { display: flex; }
  .perm-input {
    max-height: 110px; overflow: auto; font-family: monospace; font-size: 11px;
    background: #000; border: 1px solid var(--border); padding: 6px; white-space: pre-wrap;
  }
  .perm-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px 0 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
    background: #0c2638; border: 1px solid var(--accent); border-radius: 12px; padding: 2px 8px;
  }
  .chip button { border: none; background: transparent; color: var(--fg); padding: 0 2px; font-size: 12px; }
  .slash-hints {
    display: none; flex-wrap: wrap; gap: 4px; padding: 4px 8px;
    border-top: 1px solid var(--border); background: #05070a;
  }
  .slash-hints.visible { display: flex; }
  .composer {
    border-top: 1px solid var(--border); padding: 8px; background: #05070a;
    display: flex; flex-direction: column; gap: 6px;
  }
  .composer textarea {
    width: 100%; min-height: 62px; max-height: 180px; resize: vertical;
    background: #000000; color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px; font-family: inherit; font-size: 13px; font-weight: 500;
  }
  .composer textarea:focus { outline: none; border-color: var(--accent); }
  .composer-row { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
  .composer-left, .composer-right { display: flex; gap: 6px; align-items: center; }
</style>
</head>
<body>
<div class="root">
  <div class="toolbar">
    <select id="agentSelect" title="ACP エージェント切替"></select>
    <select id="permSelect" title="ツール権限モード">
      <option value="ask">承認: 確認</option>
      <option value="allowAll">承認: 自動許可</option>
    </select>
    <button id="connectBtn" title="エージェント接続 / 再接続">接続</button>
    <button id="newBtn" title="新規セッション">新規</button>
  </div>
  <div id="configBar" class="config-bar"></div>
  <div class="status-line">
    <span id="statusDot" class="dot"></span>
    <span id="statusText">待機中</span>
  </div>
  <div id="setupBanner" class="banner">
    <div id="setupTitle"></div>
    <div id="setupDesc" style="font-size:12px;color:#9ca3af;white-space:pre-wrap;"></div>
    <div class="banner-actions">
      <button id="installBtn" class="primary">ターミナルで自動導入 &amp; ログイン</button>
      <button id="loginBtn">ターミナルでログイン</button>
      <button id="recheckBtn">再検出して接続</button>
    </div>
  </div>
  <div id="messages" class="messages"></div>
  <div id="permBar" class="perm-bar">
    <div id="permTitle" style="color:#fbbf24;font-weight:600;"></div>
    <div id="permInput" class="perm-input"></div>
    <div id="permActions" class="perm-actions"></div>
  </div>
  <div id="slashHints" class="slash-hints"></div>
  <div id="chips" class="chips"></div>
  <div class="composer">
    <textarea id="promptInput" placeholder="エージェントへ指示を入力... (Enter: 送信 / Shift+Enter: 改行 / 日本語変換確定 Enter は安全)"></textarea>
    <div class="composer-row">
      <div class="composer-left">
        <button id="attachBtn" title="アクティブエディタの選択範囲を添付 (Ctrl+Shift+I)">+ 選択範囲</button>
      </div>
      <div class="composer-right">
        <button id="stopBtn" class="danger" style="display:none;">停止</button>
        <button id="sendBtn" class="primary">送信</button>
      </div>
    </div>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const agentSelect = document.getElementById('agentSelect');
  const permSelect = document.getElementById('permSelect');
  const connectBtn = document.getElementById('connectBtn');
  const newBtn = document.getElementById('newBtn');
  const configBar = document.getElementById('configBar');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const setupBanner = document.getElementById('setupBanner');
  const setupTitle = document.getElementById('setupTitle');
  const setupDesc = document.getElementById('setupDesc');
  const installBtn = document.getElementById('installBtn');
  const loginBtn = document.getElementById('loginBtn');
  const recheckBtn = document.getElementById('recheckBtn');
  const messagesEl = document.getElementById('messages');
  const permBar = document.getElementById('permBar');
  const permTitle = document.getElementById('permTitle');
  const permInput = document.getElementById('permInput');
  const permActions = document.getElementById('permActions');
  const slashHints = document.getElementById('slashHints');
  const chipsEl = document.getElementById('chips');
  const promptInput = document.getElementById('promptInput');
  const attachBtn = document.getElementById('attachBtn');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');

  let currentAssistantCard = null;
  let currentTextBuf = '';
  let currentThoughtBuf = '';
  let toolCards = new Map();
  let availableCommands = [];
  let isComposingIme = false;
  let isPrompting = false;
  let agentsCache = [];
  let baseStatusText = '';

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(state, text) {
    baseStatusText = text || '';
    statusDot.className = 'dot ' + (state || '');
    statusText.textContent = baseStatusText;
  }

  function renderConfigOptions(items) {
    configBar.textContent = '';
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      configBar.classList.remove('visible');
      return;
    }
    for (const opt of list) {
      if (!opt || !opt.id) continue;
      const wrap = document.createElement('label');
      wrap.className = 'cfg-item';
      if (opt.description) wrap.title = opt.description;
      const lbl = document.createElement('span');
      lbl.textContent = (opt.name || opt.id) + ':';
      wrap.appendChild(lbl);

      if (opt.type === 'boolean') {
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = Boolean(opt.currentValue);
        chk.addEventListener('change', () => {
          vscode.postMessage({
            type: 'setConfigOption',
            configId: opt.id,
            value: chk.checked,
            optionType: 'boolean',
          });
        });
        wrap.appendChild(chk);
      } else {
        const sel = document.createElement('select');
        const entries = Array.isArray(opt.options) ? opt.options : [];
        for (const item of entries) {
          if (!item) continue;
          if (Array.isArray(item.options)) {
            const grp = document.createElement('optgroup');
            grp.label = item.name || item.group || '';
            for (const sub of item.options) {
              if (!sub) continue;
              const o = document.createElement('option');
              o.value = String(sub.value || '');
              o.textContent = sub.name || sub.value || '';
              if (String(sub.value) === String(opt.currentValue)) o.selected = true;
              grp.appendChild(o);
            }
            sel.appendChild(grp);
          } else {
            const o = document.createElement('option');
            o.value = String(item.value || '');
            o.textContent = item.name || item.value || '';
            if (String(item.value) === String(opt.currentValue)) o.selected = true;
            sel.appendChild(o);
          }
        }
        sel.addEventListener('change', () => {
          vscode.postMessage({
            type: 'setConfigOption',
            configId: opt.id,
            value: sel.value,
            optionType: 'select',
          });
        });
        wrap.appendChild(sel);
      }
      configBar.appendChild(wrap);
    }
    if (configBar.childElementCount > 0) {
      configBar.classList.add('visible');
    } else {
      configBar.classList.remove('visible');
    }
  }

  function renderRichContent(container, text) {
    container.textContent = '';
    const parts = String(text || '').split(/(\`\`\`[\\s\\S]*?\`\`\`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('\`\`\`') && part.endsWith('\`\`\`') && part.length >= 6) {
        const inner = part.slice(3, -3);
        const firstNl = inner.indexOf('\\n');
        const lang = firstNl >= 0 ? inner.slice(0, firstNl).trim() : '';
        const code = firstNl >= 0 ? inner.slice(firstNl + 1) : inner;
        const wrap = document.createElement('div');
        wrap.className = 'code-wrap';
        const head = document.createElement('div');
        head.className = 'code-head';
        const langSpan = document.createElement('span');
        langSpan.textContent = lang || 'code';
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'コピー';
        copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copyText', text: code }));
        head.appendChild(langSpan);
        head.appendChild(copyBtn);
        const pre = document.createElement('pre');
        pre.textContent = code;
        wrap.appendChild(head);
        wrap.appendChild(pre);
        container.appendChild(wrap);
      } else {
        const span = document.createElement('span');
        span.textContent = part;
        container.appendChild(span);
      }
    }
  }

  function appendSimpleCard(kind, role, text) {
    const card = document.createElement('div');
    card.className = 'msg ' + kind;
    if (role) {
      const r = document.createElement('div');
      r.className = 'msg-role';
      r.textContent = role;
      card.appendChild(r);
    }
    const body = document.createElement('div');
    body.className = 'msg-body';
    renderRichContent(body, text);
    card.appendChild(body);
    messagesEl.appendChild(card);
    scrollBottom();
    return card;
  }

  function ensureAssistantCard() {
    if (currentAssistantCard) return currentAssistantCard;
    const card = document.createElement('div');
    card.className = 'msg assistant';
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = 'Agent (ACP)';
    const thoughtDetails = document.createElement('details');
    thoughtDetails.className = 'thought';
    thoughtDetails.style.display = 'none';
    const thoughtSummary = document.createElement('summary');
    thoughtSummary.textContent = '思考プロセス';
    const thoughtBody = document.createElement('div');
    thoughtBody.className = 'msg-body';
    thoughtBody.style.marginTop = '4px';
    thoughtBody.style.color = '#9ca3af';
    thoughtDetails.appendChild(thoughtSummary);
    thoughtDetails.appendChild(thoughtBody);

    const body = document.createElement('div');
    body.className = 'msg-body';
    const toolsWrap = document.createElement('div');

    card.appendChild(role);
    card.appendChild(thoughtDetails);
    card.appendChild(body);
    card.appendChild(toolsWrap);
    messagesEl.appendChild(card);
    currentAssistantCard = { card, thoughtDetails, thoughtBody, body, toolsWrap };
    currentTextBuf = '';
    currentThoughtBuf = '';
    toolCards = new Map();
    scrollBottom();
    return currentAssistantCard;
  }

  function appendLocButton(locsEl, seenPaths, locPath, line) {
    if (!locPath) return;
    const key = locPath + ':' + (line || 1);
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    const btn = document.createElement('button');
    btn.className = 'tool-loc';
    btn.textContent = locPath + (line ? ':' + line : '');
    btn.addEventListener('click', () => vscode.postMessage({ type: 'openLocation', path: locPath, line: line || 1 }));
    locsEl.appendChild(btn);
  }

  function upsertToolCall(update) {
    const target = ensureAssistantCard();
    const id = String(update.toolCallId || ('tool-' + Date.now()));
    let entry = toolCards.get(id);
    if (!entry) {
      const details = document.createElement('details');
      details.className = 'tool';
      const summary = document.createElement('summary');
      const titleSpan = document.createElement('span');
      const statusSpan = document.createElement('span');
      statusSpan.className = 'tool-status';
      summary.appendChild(titleSpan);
      summary.appendChild(statusSpan);
      const locs = document.createElement('div');
      const out = document.createElement('pre');
      out.style.whiteSpace = 'pre-wrap';
      out.style.fontSize = '11px';
      out.style.margin = '6px 0 0 0';
      details.appendChild(summary);
      details.appendChild(locs);
      details.appendChild(out);
      target.toolsWrap.appendChild(details);
      entry = { titleSpan, statusSpan, locs, out, seenPaths: new Set() };
      toolCards.set(id, entry);
    }
    if (update.title || update.name) {
      entry.titleSpan.textContent = String(update.title || update.name);
    }
    if (update.status) {
      entry.statusSpan.textContent = '[' + update.status + ']';
    }
    if (Array.isArray(update.locations) && update.locations.length > 0) {
      entry.locs.textContent = '';
      entry.seenPaths = new Set();
      for (const loc of update.locations) {
        if (!loc || !loc.path) continue;
        appendLocButton(entry.locs, entry.seenPaths, loc.path, loc.line);
      }
    }
    const textPieces = [];
    if (update.rawInput !== undefined) {
      textPieces.push('input: ' + (typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput)));
    }
    if (update.rawOutput !== undefined) {
      textPieces.push('output: ' + (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)));
    }
    if (Array.isArray(update.content)) {
      for (const c of update.content) {
        if (!c) continue;
        if (c.type === 'diff') {
          if (c.path) appendLocButton(entry.locs, entry.seenPaths, c.path, 1);
          const diffLines = ['diff: ' + (c.path || '')];
          if (typeof c.oldText === 'string' && c.oldText.length > 0) {
            diffLines.push('- ' + c.oldText.slice(0, 400));
          }
          if (typeof c.newText === 'string' && c.newText.length > 0) {
            diffLines.push('+ ' + c.newText.slice(0, 400));
          }
          textPieces.push(diffLines.join('\\n'));
        } else if (c.type === 'content' && c.content && c.content.text) {
          textPieces.push(c.content.text);
        } else if (c.text) {
          textPieces.push(c.text);
        }
      }
    }
    if (textPieces.length > 0) {
      entry.out.textContent = textPieces.join('\\n').slice(0, 2000);
    }
    scrollBottom();
  }

  function renderAttachments(items) {
    chipsEl.textContent = '';
    for (const item of items || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const label = document.createElement('span');
      label.textContent = item.label;
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: item.id }));
      chip.appendChild(label);
      chip.appendChild(rm);
      chipsEl.appendChild(chip);
    }
  }

  function renderSlashHints() {
    const val = promptInput.value || '';
    if (!val.startsWith('/') || availableCommands.length === 0) {
      slashHints.classList.remove('visible');
      slashHints.textContent = '';
      return;
    }
    const q = val.slice(1).toLowerCase();
    const matches = availableCommands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
    if (matches.length === 0) {
      slashHints.classList.remove('visible');
      slashHints.textContent = '';
      return;
    }
    slashHints.textContent = '';
    for (const cmd of matches) {
      const btn = document.createElement('button');
      btn.textContent = '/' + cmd.name;
      btn.title = cmd.description || '';
      btn.addEventListener('click', () => {
        promptInput.value = '/' + cmd.name + ' ';
        promptInput.focus();
        renderSlashHints();
      });
      slashHints.appendChild(btn);
    }
    slashHints.classList.add('visible');
  }

  function showSetupBanner(title, desc, showInstall, showLogin) {
    setupTitle.textContent = title;
    setupDesc.textContent = desc;
    installBtn.style.display = showInstall ? '' : 'none';
    loginBtn.style.display = showLogin ? '' : 'none';
    setupBanner.classList.add('visible');
  }

  function hideSetupBanner() {
    setupBanner.classList.remove('visible');
  }

  function setPromptingUi(active) {
    isPrompting = active;
    sendBtn.disabled = active;
    stopBtn.style.display = active ? '' : 'none';
  }

  function doSend() {
    if (isPrompting) return;
    const text = promptInput.value;
    if (!text.trim() && chipsEl.childElementCount === 0) return;
    promptInput.value = '';
    renderSlashHints();
    vscode.postMessage({ type: 'sendPrompt', text });
  }

  promptInput.addEventListener('compositionstart', () => { isComposingIme = true; });
  promptInput.addEventListener('compositionend', () => { isComposingIme = false; });
  promptInput.addEventListener('input', renderSlashHints);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isComposingIme && e.keyCode !== 229) {
      e.preventDefault();
      doSend();
    }
  });

  agentSelect.addEventListener('change', () => {
    hideSetupBanner();
    vscode.postMessage({ type: 'selectAgent', agentId: agentSelect.value });
  });
  permSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setPermissionMode', mode: permSelect.value });
  });
  connectBtn.addEventListener('click', () => {
    hideSetupBanner();
    vscode.postMessage({ type: 'connect' });
  });
  newBtn.addEventListener('click', () => {
    hideSetupBanner();
    vscode.postMessage({ type: 'newSession' });
  });
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachSelection' }));
  sendBtn.addEventListener('click', doSend);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  installBtn.addEventListener('click', () => vscode.postMessage({ type: 'runInstall' }));
  loginBtn.addEventListener('click', () => vscode.postMessage({ type: 'runLogin' }));
  recheckBtn.addEventListener('click', () => {
    hideSetupBanner();
    vscode.postMessage({ type: 'refreshAgents' });
    vscode.postMessage({ type: 'connect' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'bootstrap': {
        agentsCache = msg.agents || [];
        agentSelect.textContent = '';
        for (const a of agentsCache) {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = (a.installed ? '● ' : '○ ') + a.label;
          if (a.id === msg.activeAgentId) opt.selected = true;
          agentSelect.appendChild(opt);
        }
        permSelect.value = msg.permissionMode || 'ask';
        availableCommands = msg.commands || [];
        renderConfigOptions(msg.configOptions || []);
        renderAttachments(msg.attachments || []);
        const current = agentsCache.find((a) => a.id === msg.activeAgentId);
        if (msg.connected) {
          hideSetupBanner();
          const titleSuffix = msg.sessionTitle ? ' — ' + msg.sessionTitle : '';
          setStatus('connected', (current ? current.label : msg.activeAgentId) + ' (接続中)' + titleSuffix);
        } else if (current && !current.installed) {
          setStatus('', current.command + ' 未導入');
          showSetupBanner(
            current.label + ' が未導入です',
            'コマンド "' + current.command + '" が見つかりません。下のボタンからターミナルで自動導入＆ログインできます。',
            Boolean(current.installCommand),
            Boolean(current.loginCommand)
          );
        } else {
          hideSetupBanner();
          setStatus('', (current ? current.label : '') + ' 準備完了（メッセージ送信で自動接続）');
        }
        break;
      }
      case 'configOptions':
        renderConfigOptions(msg.items || []);
        break;
      case 'status':
        setStatus(msg.state, msg.message);
        if (msg.state === 'connected') hideSetupBanner();
        break;
      case 'needsSetup':
        setStatus('', msg.command + ' 未導入');
        showSetupBanner(
          msg.label + ' が未導入です',
          '下のボタンからターミナルで導入・ログイン後、「再検出して接続」を押してください。',
          Boolean(msg.installCommand),
          Boolean(msg.loginCommand)
        );
        break;
      case 'needsLogin':
        showSetupBanner(
          msg.label + ' のログインが必要です',
          msg.detail || 'ターミナルで認証を完了した後、「再検出して接続」を押してください。',
          false,
          true
        );
        break;
      case 'cleared':
        messagesEl.textContent = '';
        currentAssistantCard = null;
        setPromptingUi(false);
        break;
      case 'attachments':
        renderAttachments(msg.items || []);
        break;
      case 'turnStart': {
        currentAssistantCard = null;
        const suffix = (msg.attachments && msg.attachments.length > 0)
          ? '\\n[添付: ' + msg.attachments.join(', ') + ']'
          : '';
        appendSimpleCard('user', 'You', (msg.userText || '') + suffix);
        setPromptingUi(true);
        break;
      }
      case 'sessionUpdate': {
        const u = msg.update;
        if (!u) break;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content) {
          const textChunk = u.content.text || (u.content.resource && u.content.resource.text) || '';
          if (textChunk) {
            const card = ensureAssistantCard();
            currentTextBuf += textChunk;
            renderRichContent(card.body, currentTextBuf);
            scrollBottom();
          }
        } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && u.content.text) {
          const card = ensureAssistantCard();
          currentThoughtBuf += u.content.text;
          card.thoughtDetails.style.display = '';
          card.thoughtBody.textContent = currentThoughtBuf;
          scrollBottom();
        } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          upsertToolCall(u);
        } else if (u.sessionUpdate === 'plan' && Array.isArray(u.entries)) {
          const lines = u.entries.map((e) => '[' + (e.status || 'pending') + '] ' + (e.content || '')).join('\\n');
          appendSimpleCard('system', 'Plan', lines);
        } else if (u.sessionUpdate === 'available_commands_update' && Array.isArray(u.availableCommands)) {
          availableCommands = u.availableCommands;
          renderSlashHints();
        } else if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) {
          renderConfigOptions(u.configOptions);
        } else if (u.sessionUpdate === 'session_info_update' && u.title) {
          statusText.textContent = (baseStatusText ? baseStatusText + ' — ' : '') + u.title;
        }
        break;
      }
      case 'turnEnd':
        currentAssistantCard = null;
        setPromptingUi(false);
        if (msg.stopReason && msg.stopReason !== 'end_turn') {
          appendSimpleCard('system', 'Status', '停止理由: ' + msg.stopReason);
        }
        break;
      case 'turnError':
        currentAssistantCard = null;
        setPromptingUi(false);
        appendSimpleCard('error', 'Error', msg.message || '不明なエラー');
        break;
      case 'error':
        appendSimpleCard('error', 'Error', msg.message || 'エラー');
        break;
      case 'permissionRequest': {
        permTitle.textContent = '権限承認: ' + (msg.title || 'ツール実行');
        permInput.textContent = msg.rawInput || '(詳細パラメータなし)';
        permInput.style.display = msg.rawInput ? '' : 'none';
        permActions.textContent = '';
        for (const opt of msg.options || []) {
          const btn = document.createElement('button');
          btn.textContent = opt.name;
          if (opt.kind && opt.kind.startsWith('allow')) btn.className = 'primary';
          else if (opt.kind && opt.kind.startsWith('reject')) btn.className = 'danger';
          btn.addEventListener('click', () => {
            permBar.classList.remove('visible');
            vscode.postMessage({ type: 'permissionDecision', permId: msg.permId, optionId: opt.optionId });
          });
          permActions.appendChild(btn);
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.addEventListener('click', () => {
          permBar.classList.remove('visible');
          vscode.postMessage({ type: 'permissionDecision', permId: msg.permId, optionId: null });
        });
        permActions.appendChild(cancelBtn);
        permBar.classList.add('visible');
        break;
      }
      case 'clearPermissions':
        permBar.classList.remove('visible');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

module.exports = {
  AcpChatViewProvider,
  getConfiguredAgents,
};
