'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extDir = path.resolve(__dirname, '../android/app/src/main/assets/kucode-tools');
const extensionPath = path.join(extDir, 'extension.js');
const acpClientPath = path.join(extDir, 'acp-client.js');
const acpWebviewPath = path.join(extDir, 'acp-webview.js');
const packageJsonPath = path.join(extDir, 'package.json');
const iconSvgPath = path.join(extDir, 'icon.svg');

function loadExtensionWithMockVscode(mockVscode) {
  delete require.cache[extensionPath];
  delete require.cache[acpWebviewPath];
  delete require.cache[acpClientPath];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require(extensionPath);
  } finally {
    Module._load = origLoad;
  }
}

function createMockVscode() {
  const commands = new Map();
  const executedCommands = [];
  const configUpdates = [];
  const openedDocs = [];
  const openedDocOptions = [];
  const clipboardWrites = [];
  let clipboardWriteError = null;
  let clipboardReadAttempts = 0;
  const infoMessages = [];
  const errorMessages = [];
  const statusMessages = [];
  const treeProviders = new Map();
  const webviewViewProviders = new Map();
  const createdTerminals = [];
  const statusItems = [];
  let quickPickResolver = null;

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    TreeItemCollapsibleState: { None: 0 },
    EndOfLine: { LF: 1, CRLF: 2 },
    TreeItem: class TreeItem {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    ThemeIcon: class ThemeIcon {
      constructor(id) {
        this.id = id;
      }
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() {} };
      },
      async executeCommand(id) {
        executedCommands.push(id);
      },
    },
    window: {
      activeTextEditor: undefined,
      activeTerminal: undefined,
      registerTreeDataProvider(viewId, provider) {
        treeProviders.set(viewId, provider);
        return { dispose() {} };
      },
      registerWebviewViewProvider(viewId, provider, options) {
        webviewViewProviders.set(viewId, { provider, options });
        return { dispose() {} };
      },
      createTerminal(opts) {
        const sent = [];
        let shown = false;
        const term = {
          name: opts && opts.name,
          sent,
          get shown() {
            return shown;
          },
          show() {
            shown = true;
          },
          sendText(text, addNewLine) {
            sent.push({ text, addNewLine });
          },
          dispose() {},
        };
        createdTerminals.push(term);
        return term;
      },
      createStatusBarItem(alignment, priority) {
        const item = { alignment, priority, shown: false, show() { this.shown = true; }, dispose() {} };
        statusItems.push(item);
        return item;
      },
      setStatusBarMessage(msg, timeout) {
        statusMessages.push({ msg, timeout });
        return { dispose() {} };
      },
      async withProgress(_opts, task) {
        return await task();
      },
      async showTextDocument(doc, options) {
        openedDocs.push(doc);
        openedDocOptions.push(options || {});
      },
      async showQuickPick(items) {
        return quickPickResolver ? quickPickResolver(items) : undefined;
      },
      showInformationMessage(msg) {
        infoMessages.push(msg);
      },
      showErrorMessage(msg) {
        errorMessages.push(msg);
      },
    },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      async openTextDocument(opts) {
        return opts;
      },
      getConfiguration() {
        return {
          get() {
            return undefined;
          },
          async update(key, value, target) {
            configUpdates.push({ key, value, target });
          },
        };
      },
    },
    env: {
      clipboard: {
        async writeText(text) {
          if (clipboardWriteError) throw clipboardWriteError;
          clipboardWrites.push(text);
        },
        async readText() {
          clipboardReadAttempts += 1;
          throw new Error('Browser clipboard.readText must not be called in Android WebView');
        },
      },
    },
  };

  return {
    vscode,
    commands,
    executedCommands,
    configUpdates,
    openedDocs,
    openedDocOptions,
    clipboardWrites,
    get clipboardReadAttempts() {
      return clipboardReadAttempts;
    },
    setClipboardWriteError(err) {
      clipboardWriteError = err;
    },
    infoMessages,
    errorMessages,
    statusMessages,
    treeProviders,
    webviewViewProviders,
    createdTerminals,
    statusItems,
    setQuickPick(fn) {
      quickPickResolver = fn;
    },
  };
}

function createMockEditor({ lines, selections, eol = 1 }) {
  const edits = [];
  const editor = {
    selections,
    document: {
      eol,
      getText(sel) {
        return sel.text || '';
      },
      lineAt(lineNum) {
        return {
          text: lines[lineNum],
          rangeIncludingLineBreak: { kind: 'lineBreakRange', line: lineNum },
        };
      },
    },
    async edit(callback) {
      const builder = {
        delete(range) {
          edits.push({ op: 'delete', range });
        },
        replace(range, text) {
          edits.push({ op: 'replace', range, text });
        },
      };
      callback(builder);
      return true;
    },
  };
  return { editor, edits };
}

test('extension.js, acp-client.js, acp-webview.js pass node --check and manifest/icon are valid', () => {
  for (const scriptPath of [extensionPath, acpClientPath, acpWebviewPath]) {
    const syntax = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${path.basename(scriptPath)}: ${syntax.stderr}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(pkg.name, 'kucode-tools');
  assert.equal(pkg.version, '0.10.1');
  assert.equal(pkg.main, './extension.js');
  assert.ok(Array.isArray(pkg.contributes.commands) && pkg.contributes.commands.length >= 17);

  const commandIds = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const required of [
    'kucode.openAcpChat',
    'kucode.sendSelectionToAcp',
    'kucode.setupAntigravityCli',
    'kucode.setupCopilotCli',
    'kucode.editorCopy',
    'kucode.editorCut',
    'kucode.editorPaste',
    'kucode.terminalCopy',
    'kucode.terminalPaste',
  ]) {
    assert.ok(commandIds.has(required), `Missing command ${required} in package.json`);
  }

  const views = pkg.contributes.views.kucode || [];
  assert.ok(views.some((v) => v.id === 'kucode.acpChatView' && v.type === 'webview'));
  const defaultAgentProp = pkg.contributes.configuration.properties['kucode.acp.defaultAgent'];
  assert.ok(defaultAgentProp);
  assert.equal(defaultAgentProp.default, 'antigravity');
  assert.equal(defaultAgentProp.enum[0], 'antigravity');
  assert.ok(pkg.contributes.configuration.properties['kucode.acp.permissionMode']);
  assert.ok(pkg.contributes.configuration.properties['kucode.acp.agents']);

  const keybindings = pkg.contributes.keybindings || [];
  assert.ok(keybindings.some((k) => k.command === 'kucode.sendSelectionToAcp' && k.key === 'ctrl+shift+i' && k.when === 'editorTextFocus'));
  assert.ok(keybindings.some((k) => k.command === 'kucode.editorCopy' && k.key === 'ctrl+c' && k.when === 'editorTextFocus'));
  assert.ok(keybindings.some((k) => k.command === 'kucode.editorCut' && k.key === 'ctrl+x' && k.when === 'editorTextFocus && !editorReadonly'));
  assert.ok(keybindings.some((k) => k.command === 'kucode.editorPaste' && k.key === 'ctrl+v' && k.when === 'editorTextFocus && !editorReadonly'));
  assert.ok(keybindings.some((k) => k.command === 'kucode.terminalPaste' && k.key === 'ctrl+shift+v' && k.when === 'terminalFocus'));
  assert.ok(keybindings.some((k) => k.command === 'kucode.terminalPaste' && k.key === 'ctrl+v' && k.when === 'terminalFocus'));
  // Ctrl+C must stay untouched in terminalFocus so SIGINT continues to work
  assert.ok(!keybindings.some((k) => k.key === 'ctrl+c' && String(k.when).includes('terminalFocus')));

  const editorCtx = pkg.contributes.menus['editor/context'].map((m) => m.command);
  assert.ok(editorCtx.includes('kucode.editorCut'));
  assert.ok(editorCtx.includes('kucode.editorCopy'));
  assert.ok(editorCtx.includes('kucode.editorPaste'));
  assert.ok(editorCtx.includes('kucode.sendSelectionToAcp'));

  const terminalCtx = pkg.contributes.menus['terminal/context'].map((m) => m.command);
  assert.ok(terminalCtx.includes('kucode.terminalCopy'));
  assert.ok(terminalCtx.includes('kucode.terminalPaste'));

  const svg = fs.readFileSync(iconSvgPath, 'utf8');
  assert.match(svg, /<svg\b/);
});

test('activate registers all manifest commands, ACP webview provider, sidebar tree provider, and status bar item', () => {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const mock = createMockVscode();
  const ext = loadExtensionWithMockVscode(mock.vscode);
  const context = { subscriptions: [] };

  ext.activate(context);

  for (const cmd of pkg.contributes.commands) {
    assert.ok(mock.commands.has(cmd.command), `Missing command handler for ${cmd.command}`);
  }
  assert.ok(mock.webviewViewProviders.has('kucode.acpChatView'));
  assert.equal(mock.webviewViewProviders.get('kucode.acpChatView').options.webviewOptions.retainContextWhenHidden, true);

  assert.ok(mock.treeProviders.has('kucode.menuView'));
  const provider = mock.treeProviders.get('kucode.menuView');
  const entries = provider.getChildren();
  assert.ok(entries.length >= 15);
  const sidebarCommands = new Set(entries.map((e) => e.command));
  for (const required of [
    'kucode.openAcpChat',
    'kucode.setupAntigravityCli',
    'kucode.setupCopilotCli',
    'kucode.editorCopy',
    'kucode.editorCut',
    'kucode.editorPaste',
    'kucode.terminalCopy',
    'kucode.terminalPaste',
  ]) {
    assert.ok(sidebarCommands.has(required), `Sidebar missing ${required}`);
  }
  for (const entry of entries) {
    const item = provider.getTreeItem(entry);
    assert.ok(mock.commands.has(item.command.command), `Sidebar entry references unknown command ${item.command.command}`);
  }
  assert.equal(mock.statusItems.length, 1);
  assert.equal(mock.statusItems[0].shown, true);
  assert.equal(mock.statusItems[0].command, 'kucode.openMenu');
});

test('commands invoke authenticated host endpoints and apply spatial scale & optical theme presets', async (t) => {
  const received = [];
  const expectedToken = 'test-admin-token-42';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.headers['x-kucode-token'] !== expectedToken) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      received.push({ method: req.method, url: req.url, body });
      if (req.method === 'GET' && req.url === '/diagnostics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('# Diagnostics OK');
      } else if (req.method === 'GET' && req.url === '/logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('boot log');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const prevPort = process.env.KUCODE_ADMIN_PORT;
  const prevToken = process.env.KUCODE_ADMIN_TOKEN;
  process.env.KUCODE_ADMIN_PORT = String(server.address().port);
  process.env.KUCODE_ADMIN_TOKEN = expectedToken;
  t.after(() => {
    if (prevPort === undefined) delete process.env.KUCODE_ADMIN_PORT;
    else process.env.KUCODE_ADMIN_PORT = prevPort;
    if (prevToken === undefined) delete process.env.KUCODE_ADMIN_TOKEN;
    else process.env.KUCODE_ADMIN_TOKEN = prevToken;
  });

  const mock = createMockVscode();
  const ext = loadExtensionWithMockVscode(mock.vscode);
  ext.activate({ subscriptions: [] });

  await mock.commands.get('kucode.runDiagnostics')();
  assert.deepEqual(mock.openedDocs[0], { content: '# Diagnostics OK', language: 'markdown' });
  assert.equal(mock.openedDocOptions[0].preview, true);
  assert.equal(mock.clipboardWrites[0], '# Diagnostics OK');
  assert.ok(received.some((r) => r.method === 'GET' && r.url === '/diagnostics'));
  assert.ok(received.some((r) => r.method === 'POST' && r.url === '/copy' && r.body === '# Diagnostics OK'));

  await mock.commands.get('kucode.openLogs')();
  assert.deepEqual(mock.openedDocs[1], { content: 'boot log', language: 'plaintext' });
  assert.equal(mock.openedDocOptions[1].preview, false);

  await mock.commands.get('kucode.setupAntigravityCli')();
  assert.equal(mock.createdTerminals.length, 1);
  assert.equal(mock.createdTerminals[0].sent[0].text, 'kucode-install-agy && agy acp --login');
  assert.equal(mock.createdTerminals[0].sent[0].addNewLine, true);

  await mock.commands.get('kucode.setupCopilotCli')();
  assert.equal(mock.createdTerminals.length, 2);
  assert.equal(mock.createdTerminals[1].sent[0].text, 'kucode-install-copilot && copilot login');
  assert.equal(mock.createdTerminals[1].sent[0].addNewLine, true);

  await mock.commands.get('kucode.openManager')();
  await mock.commands.get('kucode.requestStorage')();
  assert.ok(received.some((r) => r.method === 'POST' && r.url === '/open-boot'));
  assert.ok(received.some((r) => r.method === 'POST' && r.url === '/storage-permission'));

  mock.setQuickPick((items) => items[2]); // 特大
  await mock.commands.get('kucode.selectDisplayScale')();
  assert.ok(mock.configUpdates.some((u) => u.key === 'window.zoomLevel' && u.value === 1.0));
  assert.ok(mock.configUpdates.some((u) => u.key === 'editor.fontSize' && u.value === 18));

  mock.setQuickPick((items) => items[1]); // VST
  await mock.commands.get('kucode.selectOpticalTheme')();
  assert.ok(mock.configUpdates.some((u) => u.key === 'workbench.colorCustomizations' && u.value['editor.background'] === '#12141a'));

  // Missing port / wrong token fails cleanly
  process.env.KUCODE_ADMIN_TOKEN = 'bad-token';
  await assert.rejects(ext.callHost('GET', '/logs'), /HTTP 403/);
  delete process.env.KUCODE_ADMIN_PORT;
  await assert.rejects(ext.callHost('GET', '/logs'), /KUCODE_ADMIN_PORT is not configured/);
});

test('editor and terminal copy/cut/paste bridge uses Android host clipboard safely', async (t) => {
  let hostClipboard = '';
  let failHostCopy = false;
  let failHostRead = false;
  const expectedToken = 'clipboard-test-token';

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.headers['x-kucode-token'] !== expectedToken) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      if (req.method === 'POST' && req.url === '/copy') {
        if (failHostCopy) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('clipboard unavailable');
          return;
        }
        hostClipboard = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && req.url === '/clipboard') {
        if (failHostRead) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('clipboard unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(hostClipboard);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const prevPort = process.env.KUCODE_ADMIN_PORT;
  const prevToken = process.env.KUCODE_ADMIN_TOKEN;
  process.env.KUCODE_ADMIN_PORT = String(server.address().port);
  process.env.KUCODE_ADMIN_TOKEN = expectedToken;
  t.after(() => {
    if (prevPort === undefined) delete process.env.KUCODE_ADMIN_PORT;
    else process.env.KUCODE_ADMIN_PORT = prevPort;
    if (prevToken === undefined) delete process.env.KUCODE_ADMIN_TOKEN;
    else process.env.KUCODE_ADMIN_TOKEN = prevToken;
  });

  const mock = createMockVscode();
  const ext = loadExtensionWithMockVscode(mock.vscode);
  ext.activate({ subscriptions: [] });

  // 1. Editor copy with single selection
  const selA = { isEmpty: false, active: { line: 0 }, text: 'こんにちは KuCode' };
  let ed = createMockEditor({ lines: ['こんにちは KuCode'], selections: [selA] });
  mock.vscode.window.activeTextEditor = ed.editor;
  await mock.commands.get('kucode.editorCopy')();
  assert.equal(hostClipboard, 'こんにちは KuCode');
  assert.equal(mock.statusMessages.at(-1).msg, '$(check) コピーしました');

  // 2. Editor copy with empty selections on same line deduplicates and respects CRLF
  ed = createMockEditor({
    lines: ['line zero', 'line one'],
    selections: [
      { isEmpty: true, active: { line: 1 } },
      { isEmpty: true, active: { line: 1 } },
    ],
    eol: mock.vscode.EndOfLine.CRLF,
  });
  mock.vscode.window.activeTextEditor = ed.editor;
  await mock.commands.get('kucode.editorCopy')();
  assert.equal(hostClipboard, 'line one\r\n');

  // 3. Editor cut copies first and deletes non-empty selections
  const selCut1 = { isEmpty: false, active: { line: 0 }, text: 'alpha' };
  const selCut2 = { isEmpty: false, active: { line: 1 }, text: 'beta' };
  ed = createMockEditor({ lines: ['alpha', 'beta'], selections: [selCut1, selCut2] });
  mock.vscode.window.activeTextEditor = ed.editor;
  await mock.commands.get('kucode.editorCut')();
  assert.equal(hostClipboard, 'alpha\nbeta');
  assert.deepEqual(ed.edits, [
    { op: 'delete', range: selCut1 },
    { op: 'delete', range: selCut2 },
  ]);

  // 4. Editor cut must NOT delete document content when clipboard write fails completely
  failHostCopy = true;
  mock.setClipboardWriteError(new Error('web clipboard denied'));
  ed = createMockEditor({ lines: ['precious'], selections: [{ isEmpty: false, active: { line: 0 }, text: 'precious' }] });
  mock.vscode.window.activeTextEditor = ed.editor;
  await mock.commands.get('kucode.editorCut')();
  assert.equal(ed.edits.length, 0);
  assert.match(mock.errorMessages.at(-1), /切り取りに失敗しました/);
  failHostCopy = false;
  mock.setClipboardWriteError(null);

  // 5. Editor paste reads host clipboard (never browser readText) and distributes lines across multi-cursors
  hostClipboard = 'first\r\nsecond';
  const cur1 = { isEmpty: true, active: { line: 0 } };
  const cur2 = { isEmpty: true, active: { line: 1 } };
  ed = createMockEditor({ lines: ['', ''], selections: [cur1, cur2] });
  mock.vscode.window.activeTextEditor = ed.editor;
  await mock.commands.get('kucode.editorPaste')();
  assert.deepEqual(ed.edits, [
    { op: 'replace', range: cur1, text: 'first' },
    { op: 'replace', range: cur2, text: 'second' },
  ]);
  assert.equal(mock.clipboardReadAttempts, 0);

  // 6. Editor paste with empty clipboard shows feedback without editing
  hostClipboard = '';
  ed = createMockEditor({ lines: ['keep'], selections: [cur1] });
  mock.vscode.window.activeTextEditor = ed.editor;
  await mock.commands.get('kucode.editorPaste')();
  assert.equal(ed.edits.length, 0);
  assert.equal(mock.statusMessages.at(-1).msg, 'クリップボードは空です');

  // 7. Terminal copy delegates to VS Code selection copy command
  const terminalSent = [];
  let terminalShown = 0;
  const mockTerminal = {
    sendText(text, addNewLine) {
      terminalSent.push({ text, addNewLine });
    },
    show(preserveFocus) {
      assert.equal(preserveFocus, false);
      terminalShown += 1;
    },
  };
  mock.vscode.window.activeTerminal = mockTerminal;
  await mock.commands.get('kucode.terminalCopy')();
  assert.equal(mock.executedCommands.at(-1), 'workbench.action.terminal.copySelection');

  // 8. Terminal paste normalizes CRLF/CR to LF and never auto-appends newline
  hostClipboard = 'echo 1\r\necho 日本語\rpwd';
  await mock.commands.get('kucode.terminalPaste')();
  assert.deepEqual(terminalSent.at(-1), { text: 'echo 1\necho 日本語\npwd', addNewLine: false });
  assert.equal(terminalShown, 1);
  assert.equal(mock.clipboardReadAttempts, 0);

  // 9. editorPaste falls back to active terminal when no text editor is focused
  mock.vscode.window.activeTextEditor = undefined;
  hostClipboard = 'gh auth status';
  await mock.commands.get('kucode.editorPaste')();
  assert.deepEqual(terminalSent.at(-1), { text: 'gh auth status', addNewLine: false });

  // 10. Host clipboard 503 reports an error cleanly without touching terminal
  failHostRead = true;
  const sentBeforeErr = terminalSent.length;
  await mock.commands.get('kucode.terminalPaste')();
  assert.equal(terminalSent.length, sentBeforeErr);
  assert.match(mock.errorMessages.at(-1), /ターミナルへの貼り付けに失敗しました/);

  // 11. No active terminal notifies cleanly
  failHostRead = false;
  mock.vscode.window.activeTerminal = undefined;
  await mock.commands.get('kucode.terminalCopy')();
  assert.equal(mock.infoMessages.at(-1), 'アクティブなターミナルがありません');
});

test('openSessionLogs lists current and past abnormal sessions and opens AI bundle', async (t) => {
  const expectedToken = 'session-test-token';
  const postedEvents = [];
  let copiedBundle = '';

  const sessionsPayload = {
    schemaVersion: 'kucode-session-v1',
    currentSessionId: '20261124-010000-aa11bb',
    previousAbnormalSessionId: '20261124-003000-cc22dd',
    sessions: [
      {
        sessionId: '20261124-010000-aa11bb',
        status: 'RUNNING',
        exitCategory: 'RUNNING',
        exitSummary: 'active',
        startedAtUtc: '2026-11-24T01:00:00Z',
        durationHuman: '2m 10s',
        errorCount: 0,
        warnCount: 1,
        isCurrentSession: true,
      },
      {
        sessionId: '20261124-003000-cc22dd',
        status: 'ENDED_ABNORMALLY',
        exitCategory: 'LOW_MEMORY',
        exitSummary: 'Killed by Android LMKD',
        startedAtUtc: '2026-11-24T00:30:00Z',
        durationHuman: '18m 5s',
        errorCount: 2,
        warnCount: 3,
        isCurrentSession: false,
      },
    ],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.headers['x-kucode-token'] !== expectedToken) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (req.method === 'GET' && req.url === '/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessionsPayload));
      } else if (req.method === 'GET' && req.url === '/sessions/20261124-003000-cc22dd?format=ai') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('# AI Bundle for 20261124-003000-cc22dd\nREASON_LOW_MEMORY');
      } else if (req.method === 'POST' && req.url === '/copy') {
        copiedBundle = body;
        res.writeHead(200);
        res.end('ok');
      } else if (req.method === 'POST' && req.url === '/event') {
        postedEvents.push(JSON.parse(body));
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const prevPort = process.env.KUCODE_ADMIN_PORT;
  const prevToken = process.env.KUCODE_ADMIN_TOKEN;
  process.env.KUCODE_ADMIN_PORT = String(server.address().port);
  process.env.KUCODE_ADMIN_TOKEN = expectedToken;
  t.after(() => {
    if (prevPort === undefined) delete process.env.KUCODE_ADMIN_PORT;
    else process.env.KUCODE_ADMIN_PORT = prevPort;
    if (prevToken === undefined) delete process.env.KUCODE_ADMIN_TOKEN;
    else process.env.KUCODE_ADMIN_TOKEN = prevToken;
  });

  const mock = createMockVscode();
  let closeTerminalHandler = null;
  mock.vscode.window.onDidCloseTerminal = (fn) => {
    closeTerminalHandler = fn;
    return { dispose() {} };
  };

  const ext = loadExtensionWithMockVscode(mock.vscode);
  ext.activate({ subscriptions: [] });

  let presentedItems = [];
  mock.setQuickPick((items) => {
    presentedItems = items;
    return items[0]; // Top item should be the previous abnormal session shortcut
  });

  await mock.commands.get('kucode.openSessionLogs')();
  assert.ok(presentedItems.length >= 3);
  assert.match(presentedItems[0].label, /前回異常終了/);
  assert.equal(mock.openedDocs.at(-1).language, 'markdown');
  assert.match(mock.openedDocs.at(-1).content, /REASON_LOW_MEMORY/);
  assert.match(copiedBundle, /REASON_LOW_MEMORY/);

  assert.equal(typeof closeTerminalHandler, 'function');
  closeTerminalHandler({ name: 'bash', exitStatus: { code: 137, reason: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(postedEvents.some((e) => e.source === 'ext.terminal' && e.level === 'WARN' && e.msg.includes('code=137')));
});


