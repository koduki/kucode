'use strict';
const vscode = require('vscode');
const http = require('http');
const { AcpChatViewProvider } = require('./acp-webview');
const { parseTraceParent } = require('./acp-client');

let acpProviderInstance = null;

const OST_COLORS = {
  'editor.background': '#000000',
  'editor.foreground': '#f3f4f6',
  'editorGutter.background': '#000000',
  'editorLineNumber.foreground': '#6b7280',
  'editorLineNumber.activeForeground': '#f9fafb',
  'editorCursor.foreground': '#38bdf8',
  'sideBar.background': '#050505',
  'sideBar.foreground': '#e5e7eb',
  'sideBar.border': '#1f2937',
  'sideBarSectionHeader.background': '#0a0a0c',
  'activityBar.background': '#000000',
  'activityBar.foreground': '#f3f4f6',
  'activityBar.activeBorder': '#38bdf8',
  'panel.background': '#000000',
  'panel.border': '#1f2937',
  'terminal.background': '#000000',
  'terminal.foreground': '#f3f4f6',
  'terminalCursor.foreground': '#38bdf8',
  'titleBar.activeBackground': '#000000',
  'titleBar.inactiveBackground': '#000000',
  'statusBar.background': '#08080a',
  'statusBar.foreground': '#e5e7eb',
  'statusBar.border': '#1f2937',
  'tab.activeBackground': '#0d1117',
  'tab.activeForeground': '#ffffff',
  'tab.activeBorderTop': '#38bdf8',
  'tab.inactiveBackground': '#000000',
  'tab.inactiveForeground': '#9ca3af',
  'editorGroupHeader.tabsBackground': '#000000',
};

const VST_COLORS = {
  'editor.background': '#12141a',
  'editor.foreground': '#f3f4f6',
  'editorGutter.background': '#12141a',
  'editorLineNumber.foreground': '#64748b',
  'editorLineNumber.activeForeground': '#f8fafc',
  'editorCursor.foreground': '#38bdf8',
  'sideBar.background': '#171a22',
  'sideBar.foreground': '#e2e8f0',
  'sideBar.border': '#283040',
  'sideBarSectionHeader.background': '#1c202b',
  'activityBar.background': '#0f1117',
  'activityBar.foreground': '#f1f5f9',
  'activityBar.activeBorder': '#38bdf8',
  'panel.background': '#14171f',
  'panel.border': '#283040',
  'terminal.background': '#12141a',
  'terminal.foreground': '#f3f4f6',
  'terminalCursor.foreground': '#38bdf8',
  'titleBar.activeBackground': '#0f1117',
  'titleBar.inactiveBackground': '#0f1117',
  'statusBar.background': '#171a22',
  'statusBar.foreground': '#e2e8f0',
  'statusBar.border': '#283040',
  'tab.activeBackground': '#1e2430',
  'tab.activeForeground': '#ffffff',
  'tab.activeBorderTop': '#38bdf8',
  'tab.inactiveBackground': '#12141a',
  'tab.inactiveForeground': '#94a3b8',
  'editorGroupHeader.tabsBackground': '#12141a',
};

function callHost(method, path, body, options) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.KUCODE_ADMIN_PORT || 0);
    const token = process.env.KUCODE_ADMIN_TOKEN || '';
    if (!port) {
      reject(new Error('KUCODE_ADMIN_PORT is not configured'));
      return;
    }
    const opts = options && typeof options === 'object' ? options : {};
    const payload = body !== undefined && body !== null ? Buffer.from(body, 'utf8') : null;
    const headers = { 'X-KuCode-Token': token };
    const parsedTp = parseTraceParent(opts.traceparent || process.env.TRACEPARENT);
    if (parsedTp) {
      headers.traceparent = parsedTp.normalized;
    }
    if (payload) {
      headers['Content-Type'] = opts.contentType || 'text/plain; charset=utf-8';
      headers['Content-Length'] = String(payload.length);
    }
    const timeout = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(text);
          } else {
            reject(new Error('Host API HTTP ' + res.statusCode + ': ' + text));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Host API timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function setStatusFeedback(message) {
  if (typeof vscode.window.setStatusBarMessage === 'function') {
    vscode.window.setStatusBarMessage(message, 1800);
  }
}

async function writeHostClipboard(text) {
  let hostOk = false;
  let lastError = null;
  try {
    await callHost('POST', '/copy', text);
    hostOk = true;
  } catch (err) {
    lastError = err;
  }
  let webOk = false;
  try {
    await vscode.env.clipboard.writeText(text);
    webOk = true;
  } catch (err) {
    if (!lastError) lastError = err;
  }
  if (!hostOk && !webOk) {
    throw lastError || new Error('Clipboard write failed');
  }
}

async function readHostClipboard() {
  // Always read via Android host ClipboardManager (`GET /clipboard`) instead of
  // `vscode.env.clipboard.readText()`, which throws NotAllowedError and opens a
  // sticky permission prompt in Android WebView.
  return await callHost('GET', '/clipboard');
}

function getDocumentEol(document) {
  const crlfValue = vscode.EndOfLine ? vscode.EndOfLine.CRLF : 2;
  return document && document.eol === crlfValue ? '\r\n' : '\n';
}

function extractEditorCopyPlan(editor) {
  const document = editor.document;
  const selections = editor.selections || [];
  const eol = getDocumentEol(document);
  const nonEmpty = selections.filter((sel) => !sel.isEmpty);
  if (nonEmpty.length > 0) {
    return {
      text: selections.map((sel) => document.getText(sel)).join(eol),
      deleteRanges: nonEmpty,
      lineCopy: false,
    };
  }
  const lineNums = Array.from(new Set(selections.map((sel) => sel.active.line))).sort((a, b) => a - b);
  const lines = lineNums.map((num) => document.lineAt(num));
  return {
    text: lines.map((line) => line.text + eol).join(''),
    deleteRanges: lines.map((line) => line.rangeIncludingLineBreak),
    lineCopy: true,
  };
}

function normalizeTerminalPasteText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function editorCopyCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('アクティブなエディタがありません');
    return;
  }
  try {
    const { text } = extractEditorCopyPlan(editor);
    await writeHostClipboard(text);
    setStatusFeedback('$(check) コピーしました');
  } catch (err) {
    vscode.window.showErrorMessage('コピーに失敗しました: ' + err.message);
  }
}

async function editorCutCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('アクティブなエディタがありません');
    return;
  }
  try {
    const { text, deleteRanges } = extractEditorCopyPlan(editor);
    await writeHostClipboard(text);
    if (deleteRanges.length > 0) {
      await editor.edit((editBuilder) => {
        for (const range of deleteRanges) {
          editBuilder.delete(range);
        }
      });
    }
    setStatusFeedback('$(check) 切り取りました');
  } catch (err) {
    vscode.window.showErrorMessage('切り取りに失敗しました: ' + err.message);
  }
}

async function editorPasteCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    if (vscode.window.activeTerminal) {
      await terminalPasteCommand();
      return;
    }
    vscode.window.showInformationMessage('アクティブなエディタがありません');
    return;
  }
  try {
    const text = await readHostClipboard();
    if (!text) {
      setStatusFeedback('クリップボードは空です');
      return;
    }
    const selections = editor.selections || [];
    const splitLines = selections.length > 1 ? text.split(/\r?\n/) : null;
    const pasteLinePerCursor = Boolean(splitLines && splitLines.length === selections.length);
    await editor.edit((editBuilder) => {
      selections.forEach((sel, idx) => {
        editBuilder.replace(sel, pasteLinePerCursor ? splitLines[idx] : text);
      });
    });
    setStatusFeedback('$(check) 貼り付けました');
  } catch (err) {
    vscode.window.showErrorMessage('貼り付けに失敗しました: ' + err.message);
  }
}

async function terminalCopyCommand() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('アクティブなターミナルがありません');
    return;
  }
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    setStatusFeedback('$(check) ターミナル選択をコピーしました');
  } catch (err) {
    vscode.window.showErrorMessage('ターミナルのコピーに失敗しました: ' + err.message);
  }
}

async function terminalPasteCommand() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('アクティブなターミナルがありません');
    return;
  }
  try {
    const text = await readHostClipboard();
    if (!text) {
      setStatusFeedback('クリップボードは空です');
      return;
    }
    terminal.sendText(normalizeTerminalPasteText(text), false);
    if (typeof terminal.show === 'function') {
      terminal.show(false);
    }
    setStatusFeedback('$(check) ターミナルへ貼り付けました');
  } catch (err) {
    vscode.window.showErrorMessage('ターミナルへの貼り付けに失敗しました: ' + err.message);
  }
}

async function openTextTabAndCopy(content, language, copiedMessage, options) {
  const preview = Boolean(options && options.preview);
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { preview });
  let copied = false;
  try {
    await writeHostClipboard(content);
    copied = true;
  } catch (_) {
    // Ignore when clipboard is unavailable
  }
  if (copied) {
    vscode.window.showInformationMessage(copiedMessage);
  }
}

async function runDiagnosticsCommand() {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'KuCode: 実機チェックを実行中（PRoot / PTY / マウント / 疎通）...',
      cancellable: false,
    },
    async () => {
      try {
        const report = await callHost('GET', '/diagnostics');
        await openTextTabAndCopy(
          report,
          'markdown',
          '実機診断レポートを開き、クリップボードへコピーしました（そのまま貼り付けできます）',
          { preview: true }
        );
      } catch (err) {
        vscode.window.showErrorMessage('実機チェックに失敗しました: ' + err.message);
      }
    }
  );
}

function reportHostEvent(level, source, msg, traceparent) {
  if (!process.env.KUCODE_ADMIN_PORT) return;
  callHost('POST', '/event', JSON.stringify({ level, source, msg }), {
    contentType: 'application/json; charset=utf-8',
    traceparent,
  }).catch(() => {});
}

function reportHostSpan(spanPayload, traceparent) {
  if (!process.env.KUCODE_ADMIN_PORT || !spanPayload || typeof spanPayload !== 'object') {
    return Promise.resolve(null);
  }
  return callHost('POST', '/span', JSON.stringify(spanPayload), {
    contentType: 'application/json; charset=utf-8',
    traceparent,
    timeoutMs: 3000,
  }).catch(() => null);
}

async function openSessionLogsCommand() {
  try {
    const rawJson = await callHost('GET', '/sessions');
    const parsed = JSON.parse(rawJson || '{}');
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('記録されたセッション診断履歴がまだありません');
      return;
    }

    const items = [];
    if (parsed.previousAbnormalSessionId) {
      const abn = sessions.find((s) => s.sessionId === parsed.previousAbnormalSessionId);
      if (abn) {
        items.push({
          label: '$(warning) 前回異常終了の AI 診断レポートを開く (' + abn.exitCategory + ')',
          description: abn.sessionId + ' | ' + (abn.durationHuman || ''),
          detail: abn.exitSummary || '',
          selector: abn.sessionId,
          format: 'ai',
        });
      }
    }

    for (const s of sessions) {
      const icon = s.isCurrentSession
        ? '$(record)'
        : s.status === 'ENDED_ABNORMALLY'
          ? '$(error)'
          : '$(pass)';
      const badge = s.isCurrentSession
        ? '現在稼働中'
        : s.status === 'ENDED_ABNORMALLY'
          ? '異常終了: ' + s.exitCategory
          : '正常終了: ' + s.exitCategory;
      items.push({
        label: icon + ' [' + badge + '] ' + s.sessionId,
        description: (s.startedAtUtc || '') + ' | ' + (s.durationHuman || '') + ' | err=' + (s.errorCount || 0) + ' warn=' + (s.warnCount || 0),
        detail: s.exitSummary || '',
        selector: s.sessionId,
        format: 'ai',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'KuCode セッション診断履歴 & AI インプット取得（起動〜終了単位）',
      placeHolder: '閲覧・コピーするセッションを選択してください（Markdown を開きクリップボードへ自動コピーします）',
    });
    if (!picked) return;

    const bundle = await callHost(
      'GET',
      '/sessions/' + encodeURIComponent(picked.selector) + '?format=' + encodeURIComponent(picked.format)
    );
    await openTextTabAndCopy(
      bundle || '(データなし)',
      'markdown',
      'セッション診断レポート (' + picked.selector + ') を開き、AI インプット用にコピーしました'
    );
  } catch (err) {
    vscode.window.showErrorMessage('セッション診断履歴の取得に失敗しました: ' + err.message);
  }
}

async function openLogsCommand() {
  try {
    const logs = await callHost('GET', '/logs');
    await openTextTabAndCopy(
      logs || '(ログなし)',
      'plaintext',
      '起動・エラーログを開き、クリップボードへコピーしました'
    );
  } catch (err) {
    vscode.window.showErrorMessage('ログ取得に失敗しました: ' + err.message);
  }
}

async function toggleTerminalCommand() {
  await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
}

async function selectDisplayScaleCommand() {
  const presets = [
    { label: '標準（情報量重視）', description: 'zoom 0 / font 15px', zoom: 0, font: 15, line: 24, term: 14 },
    { label: '大（XREAL AURA 推奨）', description: 'zoom 0.5 / font 16px', zoom: 0.5, font: 16, line: 26, term: 15 },
    { label: '特大（遠距離・高視認性）', description: 'zoom 1.0 / font 18px', zoom: 1.0, font: 18, line: 29, term: 16 },
  ];
  const picked = await vscode.window.showQuickPick(presets, {
    title: 'KuCode 表示サイズ・ズーム',
    placeHolder: 'XR 空間での見やすいサイズを選択してください',
  });
  if (!picked) return;
  const cfg = vscode.workspace.getConfiguration();
  await cfg.update('window.zoomLevel', picked.zoom, vscode.ConfigurationTarget.Global);
  await cfg.update('editor.fontSize', picked.font, vscode.ConfigurationTarget.Global);
  await cfg.update('editor.lineHeight', picked.line, vscode.ConfigurationTarget.Global);
  await cfg.update('terminal.integrated.fontSize', picked.term, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('表示サイズを「' + picked.label + '」に変更しました');
}

async function selectOpticalThemeCommand() {
  const themes = [
    {
      label: '$(eye) OST 純黒モード（XREAL AURA 光学シースルー向け）',
      description: '#000000 背景透過 + 高コントラスト枠線',
      colors: OST_COLORS,
      name: 'OST 純黒モード',
    },
    {
      label: '$(device-camera-video) VST 暗灰モード（パススルー・暗室向け）',
      description: '#12141a 不透明ダークスレート背景',
      colors: VST_COLORS,
      name: 'VST 暗灰モード',
    },
  ];
  const picked = await vscode.window.showQuickPick(themes, {
    title: 'KuCode 光学テーマ切替',
    placeHolder: 'デバイスの光学方式に合わせて選択してください',
  });
  if (!picked) return;
  const cfg = vscode.workspace.getConfiguration();
  await cfg.update('workbench.colorCustomizations', picked.colors, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('光学テーマを「' + picked.name + '」に切り替えました');
}

async function openManagerCommand() {
  try {
    await callHost('POST', '/open-boot');
  } catch (err) {
    vscode.window.showErrorMessage('管理画面への切替に失敗しました: ' + err.message);
  }
}

async function requestStorageCommand() {
  try {
    await callHost('POST', '/storage-permission');
    vscode.window.showInformationMessage(
      'Android ストレージ許可後に「管理画面 → サーバー再起動」を実行すると /workspace/android/sdcard が有効になります'
    );
  } catch (err) {
    vscode.window.showErrorMessage('権限画面を開けませんでした: ' + err.message);
  }
}

async function openAcpChatCommand() {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.kucode');
  } catch (_) {
    // Ignore when workbench view container command is unavailable
  }
  try {
    await vscode.commands.executeCommand('kucode.acpChatView.focus');
  } catch (_) {
    // Ignore when webview view focus command is unavailable
  }
}

async function sendSelectionToAcpCommand() {
  await openAcpChatCommand();
  if (acpProviderInstance) {
    await acpProviderInstance.attachActiveSelection();
  } else {
    vscode.window.showInformationMessage('AI エージェント (ACP) パネルを初期化中です');
  }
}

async function setupAntigravityCliCommand() {
  if (acpProviderInstance) {
    await acpProviderInstance.openInTerminal('kucode-install-agy && agy acp --login', 'KuCode: Antigravity CLI (agy) Setup');
    return;
  }
  if (typeof vscode.window.createTerminal === 'function') {
    const term = vscode.window.createTerminal({ name: 'KuCode: Antigravity CLI (agy) Setup' });
    term.show(false);
    term.sendText('kucode-install-agy && agy acp --login', true);
  }
}

async function setupCopilotCliCommand() {
  if (acpProviderInstance) {
    await acpProviderInstance.openInTerminal('kucode-install-copilot && copilot login', 'KuCode: Copilot CLI Setup');
    return;
  }
  if (typeof vscode.window.createTerminal === 'function') {
    const term = vscode.window.createTerminal({ name: 'KuCode: Copilot CLI Setup' });
    term.show(false);
    term.sendText('kucode-install-copilot && copilot login', true);
  }
}

async function openMenuCommand() {
  const items = [
    {
      label: '$(comment-discussion) AI エージェント (ACP) チャットを開く',
      description: 'Google Antigravity (agy acp) / Copilot / Gemini / Claude / Codex / OpenCode を OST 純黒チャットで利用',
      action: openAcpChatCommand,
    },
    {
      label: '$(rocket) Google Antigravity CLI (agy) をインストール / ログイン',
      description: '統合ターミナルで kucode-install-agy && agy acp --login を実行',
      action: setupAntigravityCliCommand,
    },
    {
      label: '$(sparkle) GitHub Copilot CLI (ACP) をインストール / ログイン',
      description: '統合ターミナルで kucode-install-copilot && copilot login を実行',
      action: setupCopilotCliCommand,
    },
    {
      label: '$(copy) エディタをコピー (Ctrl+C)',
      description: '選択テキストまたは現在行を Android クリップボードへコピー',
      action: editorCopyCommand,
    },
    {
      label: '$(scissors) エディタを切り取り (Ctrl+X)',
      description: '選択テキストまたは現在行をコピーして削除',
      action: editorCutCommand,
    },
    {
      label: '$(clippy) エディタへ貼り付け (Ctrl+V)',
      description: 'Android クリップボードの内容をエディタへ貼り付け',
      action: editorPasteCommand,
    },
    {
      label: '$(copy) ターミナル選択をコピー (Ctrl+Shift+C)',
      description: '統合ターミナルの選択範囲をクリップボードへコピー',
      action: terminalCopyCommand,
    },
    {
      label: '$(terminal) ターミナルへ貼り付け (Ctrl+Shift+V)',
      description: 'Android クリップボードの内容をアクティブなターミナルへ貼り付け',
      action: terminalPasteCommand,
    },
    {
      label: '$(checklist) 実機チェックを実行（レポートを開く & 自動コピー）',
      description: '端末情報・PRoot・node-pty・マウント・疎通・エラーログを一括確認',
      action: runDiagnosticsCommand,
    },
    {
      label: '$(history) セッション診断履歴 & AI レポートを開く（現在・過去・異常終了）',
      description: '起動〜終了単位の全ログ・メトリクス・クラッシュ情報を AI インプット形式で取得',
      action: openSessionLogsCommand,
    },
    {
      label: '$(terminal) 統合ターミナルを開閉',
      description: 'Debian POSIX bash / apt / git / gh（JISキーボード補助）',
      action: toggleTerminalCommand,
    },
    {
      label: '$(zoom-in) 表示サイズ・ズームを変更（標準 / 大 / 特大）',
      description: 'XREAL AURA 70° FOV 向け文字サイズ調整',
      action: selectDisplayScaleCommand,
    },
    {
      label: '$(color-mode) 光学テーマを切替（OST 純黒 / VST 暗灰）',
      description: 'シースルー透過黒と不透明ダークをワンクリック切替',
      action: selectOpticalThemeCommand,
    },
    {
      label: '$(output) 起動・エラーログを開く（自動コピー）',
      description: 'openvscode-server と PRoot の最新ログを表示',
      action: openLogsCommand,
    },
    {
      label: '$(tools) 管理画面を開く（ミニCLI / 再起動）',
      description: '非PTYフォールバックターミナル・進捗・サーバー再起動画面へ切替',
      action: openManagerCommand,
    },
    {
      label: '$(folder-opened) Android ストレージアクセスを許可',
      description: '/workspace/android/sdcard マウント用の権限設定を開く',
      action: requestStorageCommand,
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'KuCode 実機チェック & 空間設定メニュー',
    placeHolder: '実行する項目を選択してください',
  });
  if (picked) {
    await picked.action();
  }
}

function createSidebarMenuProvider() {
  const entries = [
    {
      label: 'AI エージェント (ACP)',
      description: 'Antigravity (agy) / Copilot / Gemini',
      icon: 'comment-discussion',
      command: 'kucode.openAcpChat',
    },
    {
      label: 'Antigravity (agy) セットアップ',
      description: 'インストール & ログイン',
      icon: 'rocket',
      command: 'kucode.setupAntigravityCli',
    },
    {
      label: 'Copilot CLI セットアップ',
      description: 'インストール & ログイン',
      icon: 'sparkle',
      command: 'kucode.setupCopilotCli',
    },
    {
      label: 'エディタをコピー',
      description: 'Ctrl+C',
      icon: 'copy',
      command: 'kucode.editorCopy',
    },
    {
      label: 'エディタを切り取り',
      description: 'Ctrl+X',
      icon: 'scissors',
      command: 'kucode.editorCut',
    },
    {
      label: 'エディタへ貼り付け',
      description: 'Ctrl+V',
      icon: 'clippy',
      command: 'kucode.editorPaste',
    },
    {
      label: 'ターミナル選択をコピー',
      description: 'Ctrl+Shift+C',
      icon: 'copy',
      command: 'kucode.terminalCopy',
    },
    {
      label: 'ターミナルへ貼り付け',
      description: 'Ctrl+Shift+V',
      icon: 'terminal',
      command: 'kucode.terminalPaste',
    },
    {
      label: '実機チェックを実行',
      description: 'レポート表示 & 自動コピー',
      icon: 'checklist',
      command: 'kucode.runDiagnostics',
    },
    {
      label: 'セッション診断履歴 (AI用)',
      description: '現在・過去・異常終了ログ',
      icon: 'history',
      command: 'kucode.openSessionLogs',
    },
    {
      label: 'ターミナル開閉',
      description: 'POSIX bash / gh',
      icon: 'terminal',
      command: 'kucode.toggleTerminal',
    },
    {
      label: '表示サイズ変更',
      description: '標準 / 大 / 特大',
      icon: 'zoom-in',
      command: 'kucode.selectDisplayScale',
    },
    {
      label: '光学テーマ切替',
      description: 'OST 純黒 / VST 暗灰',
      icon: 'color-mode',
      command: 'kucode.selectOpticalTheme',
    },
    {
      label: '起動・エラーログを開く',
      description: '自動コピー',
      icon: 'output',
      command: 'kucode.openLogs',
    },
    {
      label: '管理画面を開く',
      description: 'ミニCLI / 再起動',
      icon: 'tools',
      command: 'kucode.openManager',
    },
    {
      label: 'Android ストレージ許可',
      description: '/android/sdcard マウント',
      icon: 'folder-opened',
      command: 'kucode.requestStorage',
    },
  ];

  return {
    getTreeItem(entry) {
      const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
      item.description = entry.description;
      item.iconPath = new vscode.ThemeIcon(entry.icon);
      item.command = { command: entry.command, title: entry.label };
      return item;
    },
    getChildren(element) {
      return element ? [] : entries;
    },
  };
}

function activate(context) {
  acpProviderInstance = new AcpChatViewProvider({
    reportHostEvent,
    reportHostSpan,
    writeHostClipboard,
    extensionVersion: '0.10.1',
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('kucode.openAcpChat', openAcpChatCommand),
    vscode.commands.registerCommand('kucode.sendSelectionToAcp', sendSelectionToAcpCommand),
    vscode.commands.registerCommand('kucode.setupAntigravityCli', setupAntigravityCliCommand),
    vscode.commands.registerCommand('kucode.setupCopilotCli', setupCopilotCliCommand),
    vscode.commands.registerCommand('kucode.openMenu', openMenuCommand),
    vscode.commands.registerCommand('kucode.editorCopy', editorCopyCommand),
    vscode.commands.registerCommand('kucode.editorCut', editorCutCommand),
    vscode.commands.registerCommand('kucode.editorPaste', editorPasteCommand),
    vscode.commands.registerCommand('kucode.terminalCopy', terminalCopyCommand),
    vscode.commands.registerCommand('kucode.terminalPaste', terminalPasteCommand),
    vscode.commands.registerCommand('kucode.runDiagnostics', runDiagnosticsCommand),
    vscode.commands.registerCommand('kucode.openSessionLogs', openSessionLogsCommand),
    vscode.commands.registerCommand('kucode.openLogs', openLogsCommand),
    vscode.commands.registerCommand('kucode.toggleTerminal', toggleTerminalCommand),
    vscode.commands.registerCommand('kucode.selectDisplayScale', selectDisplayScaleCommand),
    vscode.commands.registerCommand('kucode.selectOpticalTheme', selectOpticalThemeCommand),
    vscode.commands.registerCommand('kucode.openManager', openManagerCommand),
    vscode.commands.registerCommand('kucode.requestStorage', requestStorageCommand),
    vscode.window.registerTreeDataProvider('kucode.menuView', createSidebarMenuProvider()),
    {
      dispose() {
        if (acpProviderInstance) {
          acpProviderInstance.dispose().catch(() => {});
          acpProviderInstance = null;
        }
      },
    }
  );

  if (typeof vscode.window.registerWebviewViewProvider === 'function') {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('kucode.acpChatView', acpProviderInstance, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
  }

  if (typeof vscode.window.onDidChangeWindowState === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        reportHostEvent(
          'INFO',
          'ext.window',
          'VS Code window state: focused=' + Boolean(state && state.focused) + ', active=' + Boolean(state && state.active)
        );
      })
    );
  }
  if (typeof vscode.window.onDidOpenTerminal === 'function') {
    context.subscriptions.push(
      vscode.window.onDidOpenTerminal((term) => {
        reportHostEvent('INFO', 'ext.terminal', 'Terminal opened: ' + ((term && term.name) || 'shell'));
      })
    );
  }
  if (typeof vscode.window.onDidCloseTerminal === 'function') {
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((term) => {
        const status = term && term.exitStatus;
        const code = status ? status.code : undefined;
        const reason = status ? status.reason : undefined;
        const lvl = typeof code === 'number' && code !== 0 ? 'WARN' : 'INFO';
        reportHostEvent(
          lvl,
          'ext.terminal',
          'Terminal closed: name=' + ((term && term.name) || 'shell') + ', code=' + code + ', reason=' + reason
        );
      })
    );
  }

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = '$(pulse) KuCode';
  statusItem.tooltip = 'KuCode AI エージェント (ACP)・コピー/貼り付け・実機チェック・セッション診断履歴・表示サイズ・光学テーマ・管理画面を開く';
  statusItem.command = 'kucode.openMenu';
  statusItem.show();
  context.subscriptions.push(statusItem);
}

function deactivate() {
  if (acpProviderInstance) {
    const inst = acpProviderInstance;
    acpProviderInstance = null;
    return inst.dispose().catch(() => {});
  }
}

module.exports = {
  activate,
  deactivate,
  OST_COLORS,
  VST_COLORS,
  AcpChatViewProvider,
  callHost,
  reportHostEvent,
  reportHostSpan,
  writeHostClipboard,
  readHostClipboard,
  extractEditorCopyPlan,
  normalizeTerminalPasteText,
  createSidebarMenuProvider,
};
