'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = 1;
const DEFAULT_INIT_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_TERMINALS = 8;
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 256 * 1024;

const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function parseTraceParent(raw) {
  if (typeof raw !== 'string') return null;
  const match = TRACEPARENT_RE.exec(raw.trim());
  if (!match) return null;
  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const parentSpanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  if (version === 'ff' || traceId === ZERO_TRACE_ID || parentSpanId === ZERO_SPAN_ID) {
    return null;
  }
  return {
    version,
    traceId,
    parentSpanId,
    traceFlags,
    normalized: `${version}-${traceId}-${parentSpanId}-${traceFlags}`,
  };
}

function deriveChildTraceParent(raw) {
  const parsed = parseTraceParent(raw);
  if (!parsed) return null;
  let spanId = ZERO_SPAN_ID;
  while (spanId === ZERO_SPAN_ID || spanId === parsed.parentSpanId) {
    spanId = crypto.randomBytes(8).toString('hex');
  }
  return `00-${parsed.traceId}-${spanId}-${parsed.traceFlags}`;
}

const DEFAULT_AGENT_PRESETS = {
  antigravity: {
    id: 'antigravity',
    label: 'Google Antigravity (agy acp)',
    command: 'agy',
    args: ['acp', '--disable-telemetry'],
    env: {},
    installCommand: 'kucode-install-agy && agy acp --login',
    loginCommand: 'agy acp --login',
    description: 'Google 公式 Antigravity CLI の ACP v1 サーバー（モデル・思考レベル切替・ツール承認対応）',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI (ACP)',
    command: 'copilot',
    args: ['--acp', '--stdio'],
    env: {},
    installCommand: 'kucode-install-copilot && copilot login',
    loginCommand: 'copilot login',
    description: 'GitHub 公式 Copilot CLI の ACP サーバー（既存 Copilot 契約で利用可能）',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI (ACP)',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: {},
    installCommand: 'apt-get update && apt-get install -y npm && npm install -g @google/gemini-cli',
    loginCommand: 'gemini',
    description: 'Google Gemini CLI の ACP モード',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code (ACP)',
    command: 'claude-agent-acp',
    args: [],
    env: {},
    installCommand: 'apt-get update && apt-get install -y npm && npm install -g @agentclientprotocol/claude-agent-acp',
    loginCommand: 'claude',
    description: 'Anthropic Claude Code 用 ACP アダプター',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI (ACP)',
    command: 'codex-acp',
    args: [],
    env: {},
    installCommand: 'apt-get update && apt-get install -y npm && npm install -g @zed-industries/codex-acp',
    loginCommand: 'codex',
    description: 'OpenAI Codex CLI 用 ACP アダプター',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode (ACP)',
    command: 'opencode',
    args: ['acp'],
    env: {},
    installCommand: 'apt-get update && apt-get install -y npm && npm install -g opencode-ai',
    loginCommand: 'opencode',
    description: 'OpenCode マルチプロバイダ ACP エージェント',
  },
};

function buildAugmentedPath(rawPath, homeDir, envVars) {
  const env = envVars || process.env;
  const home = homeDir || env.HOME || '/root';
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const androidHome = env.ANDROID_HOME || path.join(home, 'Android', 'Sdk');
  const userDirs = [
    path.join(home, '.local', 'bin'),
    path.join(xdgData, 'mise', 'shims'),
    path.join(home, '.cargo', 'bin'),
    path.join(androidHome, 'cmdline-tools', 'latest', 'bin'),
    path.join(androidHome, 'platform-tools'),
  ];
  const systemDirs = [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];
  const existing = String(rawPath || env.PATH || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && path.isAbsolute(p));
  const merged = [];
  for (const dir of [...userDirs, ...existing, ...systemDirs]) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged.join(path.delimiter);
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveExecutableOnPath(command, envPath, homeDir) {
  if (!command || typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) {
    const resolved = path.resolve(trimmed);
    return isExecutableFile(resolved) ? resolved : null;
  }
  const searchPath = buildAugmentedPath(envPath, homeDir);
  for (const dir of searchPath.split(path.delimiter)) {
    const candidate = path.join(dir, trimmed);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves a requested path strictly inside [workspaceRoot], rejecting traversal (`..`)
 * and symlink escapes outside the canonical workspace root.
 */
function resolveSafeWorkspacePath(workspaceRoot, requestedPath) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('Workspace root is not configured');
  }
  if (!requestedPath || typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    throw new Error('Invalid file path');
  }
  const canonicalRoot = fs.realpathSync(workspaceRoot);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(canonicalRoot, requestedPath);

  const relCheck = path.relative(canonicalRoot, candidate);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error('Path escapes workspace root: ' + requestedPath);
  }

  // Walk up to the deepest existing ancestor and resolve symlinks
  let probe = candidate;
  const trailing = [];
  while (true) {
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      const realRel = path.relative(canonicalRoot, realProbe);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error('Symlink escapes workspace root: ' + requestedPath);
      }
      return trailing.length > 0 ? path.join(realProbe, ...trailing.reverse()) : realProbe;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error('Invalid path: ' + requestedPath);
    }
    trailing.push(path.basename(probe));
    probe = parent;
  }
}

function sliceLines(text, startLine1Based, limit) {
  if (startLine1Based === undefined && limit === undefined) return text;
  const lines = String(text).split(/\r?\n/);
  const startIdx = Math.max(0, (Number(startLine1Based) || 1) - 1);
  if (limit !== undefined && limit !== null) {
    const count = Math.max(0, Number(limit) || 0);
    return lines.slice(startIdx, startIdx + count).join('\n');
  }
  return lines.slice(startIdx).join('\n');
}

function createJsonRpcError(code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return err;
}

function isAuthRequiredError(err) {
  if (!err) return false;
  if (Number(err.code) === -32000) return true;
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  return /auth|login|token|401|not logged in|unauthorized|sign in|credentials/i.test(msg);
}

class AcpSessionClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.command
   * @param {string[]} [options.args]
   * @param {Record<string, string>} [options.env]
   * @param {string} options.workspaceRoot
   * @param {(params: object) => Promise<object>} [options.onPermissionRequest]
   * @param {(absPath: string) => Promise<string|null>} [options.readOpenEditorText]
   * @param {(absPath: string, content: string) => Promise<boolean>} [options.writeOpenEditorText]
   * @param {number} [options.initTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {string} [options.clientVersion]
   */
  constructor(options) {
    super();
    this.command = options.command;
    this.args = Array.isArray(options.args) ? [...options.args] : [];
    this.extraEnv = options.env && typeof options.env === 'object' ? { ...options.env } : {};
    this.workspaceRoot = options.workspaceRoot;
    this.onPermissionRequest = options.onPermissionRequest || null;
    this.readOpenEditorText = options.readOpenEditorText || null;
    this.writeOpenEditorText = options.writeOpenEditorText || null;
    this.initTimeoutMs = options.initTimeoutMs || DEFAULT_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.clientVersion = options.clientVersion || '0.10.1';

    this.proc = null;
    this.connected = false;
    this.sessionId = null;
    this.agentInfo = null;
    this.agentCapabilities = {};
    this.authMethods = [];
    this.modes = null;
    this.configOptions = [];
    this.sessionTitle = null;
    this.nextRpcId = 1;
    this.pendingRequests = new Map();
    this.stdoutBuffer = '';
    this.terminals = new Map();
    this.nextTerminalSeq = 1;
    this.agentTraceParent = null;
    this.disposed = false;
  }

  async connect() {
    if (this.disposed) throw new Error('ACP client is disposed');
    if (this.proc) throw new Error('ACP client already started');

    const augmentedPath = buildAugmentedPath(this.extraEnv.PATH || process.env.PATH, process.env.HOME);
    const resolvedCmd = resolveExecutableOnPath(this.command, augmentedPath, process.env.HOME);
    if (!resolvedCmd) {
      const err = new Error('Agent executable not found on PATH: ' + this.command);
      err.code = 'ENOENT_AGENT';
      throw err;
    }

    const env = {
      ...process.env,
      ...this.extraEnv,
      PATH: augmentedPath,
    };
    const derivedTp = deriveChildTraceParent(this.extraEnv.TRACEPARENT || process.env.TRACEPARENT);
    if (derivedTp) {
      env.TRACEPARENT = derivedTp;
      this.agentTraceParent = derivedTp;
    } else {
      delete env.TRACEPARENT;
      this.agentTraceParent = null;
    }

    const proc = spawn(resolvedCmd, this.args, {
      cwd: this.workspaceRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.emit('stderr', text);
    });
    proc.on('error', (err) => {
      this._rejectAllPending(err);
      this.connected = false;
      this.emit('error', err);
    });
    proc.on('exit', (code, signal) => {
      this.connected = false;
      this.proc = null;
      const err = new Error(`ACP agent exited (code=${code}, signal=${signal})`);
      this._rejectAllPending(err);
      this._cleanupAllTerminals();
      this.emit('exit', { code, signal });
    });

    const initResp = await this.sendRequest(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: 'kucode-acp',
          version: this.clientVersion,
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      },
      this.initTimeoutMs
    );

    this.agentInfo = initResp && initResp.agentInfo ? initResp.agentInfo : null;
    this.agentCapabilities = initResp && initResp.agentCapabilities ? initResp.agentCapabilities : {};
    this.authMethods = Array.isArray(initResp && initResp.authMethods) ? initResp.authMethods : [];
    this.connected = true;

    let sessionResp;
    try {
      sessionResp = await this.sendRequest(
        'session/new',
        {
          cwd: this.workspaceRoot,
          mcpServers: [],
        },
        this.initTimeoutMs
      );
    } catch (err) {
      if (err && typeof err === 'object' && this.authMethods.length > 0 && !err.authMethods) {
        err.authMethods = this.authMethods;
      }
      throw err;
    }
    this.sessionId = sessionResp && sessionResp.sessionId ? String(sessionResp.sessionId) : null;
    this.modes = sessionResp && sessionResp.modes ? sessionResp.modes : null;
    this.configOptions = Array.isArray(sessionResp && sessionResp.configOptions)
      ? sessionResp.configOptions
      : [];
    if (!this.sessionId) {
      throw new Error('ACP session/new returned empty sessionId');
    }

    this.emit('ready', {
      sessionId: this.sessionId,
      agentInfo: this.agentInfo,
      agentCapabilities: this.agentCapabilities,
      modes: this.modes,
      configOptions: this.configOptions,
      authMethods: this.authMethods,
    });
    return {
      sessionId: this.sessionId,
      agentInfo: this.agentInfo,
      modes: this.modes,
      configOptions: this.configOptions,
      authMethods: this.authMethods,
    };
  }

  async prompt(promptBlocks) {
    if (!this.connected || !this.sessionId) {
      throw new Error('ACP session is not connected');
    }
    const blocks = Array.isArray(promptBlocks)
      ? promptBlocks
      : [{ type: 'text', text: String(promptBlocks) }];
    return await this.sendRequest(
      'session/prompt',
      {
        sessionId: this.sessionId,
        prompt: blocks,
      },
      this.requestTimeoutMs
    );
  }

  async setMode(modeId) {
    if (!this.connected || !this.sessionId) {
      throw new Error('ACP session is not connected');
    }
    return await this.sendRequest('session/set_mode', {
      sessionId: this.sessionId,
      modeId: String(modeId),
    });
  }

  async setConfigOption(configId, value, optionType) {
    if (!this.connected || !this.sessionId) {
      throw new Error('ACP session is not connected');
    }
    const params = {
      sessionId: this.sessionId,
      configId: String(configId),
      value: optionType === 'boolean' ? Boolean(value) : String(value),
    };
    if (optionType === 'boolean') {
      params.type = 'boolean';
    }
    const resp = await this.sendRequest('session/set_config_option', params);
    if (resp && Array.isArray(resp.configOptions)) {
      this.configOptions = resp.configOptions;
    }
    return this.configOptions;
  }

  async authenticate(methodId) {
    if (!this.connected) {
      throw new Error('ACP client is not connected');
    }
    return await this.sendRequest(
      'authenticate',
      { methodId: String(methodId) },
      this.initTimeoutMs
    );
  }

  cancel() {
    if (!this.connected || !this.sessionId) return;
    this.sendNotification('session/cancel', { sessionId: this.sessionId });
  }

  sendNotification(method, params) {
    this._writeJson({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  sendRequest(method, params, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
        reject(new Error('ACP agent process is not running'));
        return;
      }
      const id = this.nextRpcId++;
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`ACP request timed out (${method}, ${timeoutMs}ms)`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        this._writeJson({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  async disconnect() {
    this.connected = false;
    this.sessionId = null;
    this.configOptions = [];
    this.sessionTitle = null;
    this._cleanupAllTerminals();
    const proc = this.proc;
    this.proc = null;
    this._rejectAllPending(new Error('ACP session disconnected'));
    if (!proc) return;
    try {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
    } catch (_) {}
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      proc.once('exit', done);
      try {
        proc.kill('SIGTERM');
      } catch (_) {}
      setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        } catch (_) {}
        done();
      }, 1500);
    });
  }

  async dispose() {
    this.disposed = true;
    await this.disconnect();
    this.removeAllListeners();
  }

  _writeJson(msg) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('ACP stdin is closed');
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n', 'utf8');
  }

  _onStdoutData(chunk) {
    this.stdoutBuffer += chunk;
    let nlIdx;
    while ((nlIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, nlIdx).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (_) {
        this.emit('stderr', '[non-json stdout] ' + trimmed);
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Response to our outgoing request
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || 'ACP error');
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Incoming notification from agent
    if (msg.id === undefined && typeof msg.method === 'string') {
      if (msg.method === 'session/update' && msg.params) {
        const update = msg.params.update;
        if (update && update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions;
        } else if (update && update.sessionUpdate === 'session_info_update' && update.title) {
          this.sessionTitle = String(update.title);
        }
        this.emit('sessionUpdate', msg.params);
      } else {
        this.emit('notification', msg);
      }
      return;
    }

    // Incoming request from agent (must reply with result or error)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this._handleAgentRequest(msg.id, msg.method, msg.params || {});
    }
  }

  async _handleAgentRequest(id, method, params) {
    try {
      let result;
      switch (method) {
        case 'session/request_permission':
          result = await this._handlePermissionRequest(params);
          break;
        case 'fs/read_text_file':
          result = await this._handleReadTextFile(params);
          break;
        case 'fs/write_text_file':
          result = await this._handleWriteTextFile(params);
          break;
        case 'terminal/create':
          result = await this._handleTerminalCreate(params);
          break;
        case 'terminal/output':
          result = this._handleTerminalOutput(params);
          break;
        case 'terminal/wait_for_exit':
          result = await this._handleTerminalWaitForExit(params);
          break;
        case 'terminal/kill':
          result = this._handleTerminalKill(params);
          break;
        case 'terminal/release':
          result = this._handleTerminalRelease(params);
          break;
        default:
          this._writeJson({
            jsonrpc: '2.0',
            id,
            error: createJsonRpcError(-32601, 'Method not supported by KuCode ACP client: ' + method),
          });
          return;
      }
      this._writeJson({ jsonrpc: '2.0', id, result: result === undefined ? {} : result });
    } catch (err) {
      try {
        this._writeJson({
          jsonrpc: '2.0',
          id,
          error: createJsonRpcError(-32000, err && err.message ? err.message : String(err)),
        });
      } catch (_) {}
    }
  }

  async _handlePermissionRequest(params) {
    if (typeof this.onPermissionRequest === 'function') {
      return await this.onPermissionRequest(params);
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  async _handleReadTextFile(params) {
    const safePath = resolveSafeWorkspacePath(this.workspaceRoot, params.path);
    let content = null;
    if (typeof this.readOpenEditorText === 'function') {
      content = await this.readOpenEditorText(safePath);
    }
    if (content === null || content === undefined) {
      const stat = fs.statSync(safePath);
      if (stat.size > MAX_READ_BYTES) {
        throw new Error(`File exceeds ${MAX_READ_BYTES} byte read limit`);
      }
      content = fs.readFileSync(safePath, 'utf8');
    }
    return {
      content: sliceLines(content, params.line, params.limit),
    };
  }

  async _handleWriteTextFile(params) {
    const safePath = resolveSafeWorkspacePath(this.workspaceRoot, params.path);
    const content = String(params.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
      throw new Error(`Write exceeds ${MAX_READ_BYTES} byte limit`);
    }
    let handledByEditor = false;
    if (typeof this.writeOpenEditorText === 'function') {
      handledByEditor = Boolean(await this.writeOpenEditorText(safePath, content));
    }
    if (!handledByEditor) {
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, content, 'utf8');
    }
    this.emit('fileWritten', { path: safePath });
    return {};
  }

  async _handleTerminalCreate(params) {
    if (this.terminals.size >= MAX_TERMINALS) {
      throw new Error(`Maximum concurrent ACP terminals (${MAX_TERMINALS}) reached`);
    }
    const command = String(params.command || '').trim();
    if (!command) throw new Error('terminal/create requires command');
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const cwd = params.cwd
      ? resolveSafeWorkspacePath(this.workspaceRoot, params.cwd)
      : this.workspaceRoot;

    const env = { ...process.env, PATH: buildAugmentedPath(process.env.PATH, process.env.HOME) };
    let explicitTp = null;
    if (Array.isArray(params.env)) {
      for (const item of params.env) {
        if (item && typeof item.name === 'string' && typeof item.value === 'string') {
          env[item.name] = item.value;
          if (item.name === 'TRACEPARENT') explicitTp = item.value;
        }
      }
    }
    const derivedTp = deriveChildTraceParent(explicitTp || this.agentTraceParent || process.env.TRACEPARENT);
    if (derivedTp) {
      env.TRACEPARENT = derivedTp;
    } else {
      delete env.TRACEPARENT;
    }

    const byteLimit = Math.min(
      Math.max(1024, Number(params.outputByteLimit) || DEFAULT_TERMINAL_OUTPUT_LIMIT),
      2 * 1024 * 1024
    );
    const terminalId = 'term-' + this.nextTerminalSeq++;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const record = {
      id: terminalId,
      child,
      chunks: [],
      byteCount: 0,
      byteLimit,
      truncated: false,
      exitStatus: null,
      exitPromise: null,
    };

    const appendOutput = (buf) => {
      const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
      if (record.byteCount + data.length <= record.byteLimit) {
        record.chunks.push(data);
        record.byteCount += data.length;
      } else {
        const remaining = record.byteLimit - record.byteCount;
        if (remaining > 0) {
          record.chunks.push(data.subarray(0, remaining));
          record.byteCount += remaining;
        }
        record.truncated = true;
      }
    };

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    record.exitPromise = new Promise((resolve) => {
      const finish = (exitCode, signal) => {
        if (!record.exitStatus) {
          record.exitStatus = {
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            signal: signal ? String(signal) : null,
          };
          resolve(record.exitStatus);
        }
      };
      child.on('exit', (code, signal) => finish(code, signal));
      child.on('error', (err) => {
        appendOutput(Buffer.from('\n' + err.message + '\n', 'utf8'));
        finish(127, null);
      });
    });

    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  _handleTerminalOutput(params) {
    const record = this.terminals.get(String(params.terminalId || ''));
    if (!record) throw new Error('Unknown terminalId: ' + params.terminalId);
    const res = {
      output: Buffer.concat(record.chunks).toString('utf8'),
      truncated: record.truncated,
    };
    if (record.exitStatus) {
      res.exitStatus = record.exitStatus;
    }
    return res;
  }

  async _handleTerminalWaitForExit(params) {
    const record = this.terminals.get(String(params.terminalId || ''));
    if (!record) throw new Error('Unknown terminalId: ' + params.terminalId);
    return await record.exitPromise;
  }

  _killTerminalRecord(record) {
    if (!record || !record.child || record.exitStatus) return;
    const pid = record.child.pid;
    try {
      if (pid) process.kill(-pid, 'SIGTERM');
      else record.child.kill('SIGTERM');
    } catch (_) {
      try {
        record.child.kill('SIGTERM');
      } catch (_) {}
    }
    setTimeout(() => {
      if (!record.exitStatus) {
        try {
          if (pid) process.kill(-pid, 'SIGKILL');
          else record.child.kill('SIGKILL');
        } catch (_) {
          try {
            record.child.kill('SIGKILL');
          } catch (_) {}
        }
      }
    }, 1000).unref();
  }

  _handleTerminalKill(params) {
    const record = this.terminals.get(String(params.terminalId || ''));
    if (!record) throw new Error('Unknown terminalId: ' + params.terminalId);
    this._killTerminalRecord(record);
    return {};
  }

  _handleTerminalRelease(params) {
    const id = String(params.terminalId || '');
    const record = this.terminals.get(id);
    if (record) {
      this._killTerminalRecord(record);
      this.terminals.delete(id);
    }
    return {};
  }

  _cleanupAllTerminals() {
    for (const record of this.terminals.values()) {
      this._killTerminalRecord(record);
    }
    this.terminals.clear();
  }

  _rejectAllPending(err) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}

module.exports = {
  PROTOCOL_VERSION,
  DEFAULT_AGENT_PRESETS,
  buildAugmentedPath,
  resolveExecutableOnPath,
  resolveSafeWorkspacePath,
  sliceLines,
  isAuthRequiredError,
  parseTraceParent,
  deriveChildTraceParent,
  AcpSessionClient,
};
