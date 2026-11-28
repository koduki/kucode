'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const extDir = path.resolve(__dirname, '../android/app/src/main/assets/kucode-tools');
const acpClientPath = path.join(extDir, 'acp-client.js');
const acpWebviewPath = path.join(extDir, 'acp-webview.js');

const {
  PROTOCOL_VERSION,
  DEFAULT_AGENT_PRESETS,
  resolveSafeWorkspacePath,
  sliceLines,
  isAuthRequiredError,
  AcpSessionClient,
} = require(acpClientPath);

/**
 * Writes a self-contained mock ACP v1 agent script to disk.
 * Exercises initialize, authenticate, session/new (with configOptions),
 * session/set_config_option, session/prompt, streaming session/update
 * (including config_option_update & session_info_update),
 * session/request_permission, fs/read_text_file, fs/write_text_file,
 * terminal/{create,wait_for_exit,output,release}, session/cancel, and -32000 auth errors.
 */
function createMockAcpAgentScript(tempDir) {
  const scriptPath = path.join(tempDir, 'mock-acp-agent.cjs');
  const script = `'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let nextReqId = 1;
const pendingClientCalls = new Map();
let activePromptId = null;
let activeCancelTimer = null;
let cancelledCurrent = false;
let authenticated = process.env.MOCK_REQUIRE_AUTH !== '1';
let currentModel = 'gemini-4-hydrogen';
let currentThinking = 'Medium';

function buildConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        {
          group: 'gemini',
          name: 'Gemini',
          options: [
            { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
            { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
          ],
        },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking level',
      category: 'thought_level',
      type: 'select',
      currentValue: currentThinking,
      options: [
        { value: 'Low', name: 'Low' },
        { value: 'Medium', name: 'Medium' },
        { value: 'High', name: 'High' },
        { value: 'Max', name: 'Max' },
      ],
    },
  ];
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

function callClient(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'agent-' + (nextReqId++);
    pendingClientCalls.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  // Client response to an agent-initiated request
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pendingClientCalls.get(msg.id);
    if (p) {
      pendingClientCalls.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.16' },
        agentCapabilities: { loadSession: true },
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google' },
          { id: 'terminal-login', name: 'Log in from the terminal' },
        ],
      },
    });
    return;
  }

  if (msg.method === 'authenticate') {
    authenticated = true;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/new') {
    if (!authenticated) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Authentication required' },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'sess-mock-001',
        modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
        configOptions: buildConfigOptions(),
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-mock-001',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review', description: 'Code review' }],
        },
      },
    });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    const cid = msg.params && msg.params.configId;
    const val = msg.params && msg.params.value;
    if (cid === 'model') currentModel = String(val);
    if (cid === 'thought_level') currentThinking = String(val);
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { configOptions: buildConfigOptions() },
    });
    return;
  }

  if (msg.method === 'session/cancel') {
    cancelledCurrent = true;
    if (activeCancelTimer) {
      clearTimeout(activeCancelTimer);
      activeCancelTimer = null;
    }
    if (activePromptId !== null) {
      const id = activePromptId;
      activePromptId = null;
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    }
    return;
  }

  if (msg.method === 'session/prompt') {
    cancelledCurrent = false;
    const text = (msg.params && msg.params.prompt || []).map((b) => b.text || '').join('\\n');

    if (text.includes('TRIGGER_CANCEL')) {
      activePromptId = msg.id;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-001',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } },
        },
      });
      activeCancelTimer = setTimeout(() => {
        if (activePromptId !== null) {
          const id = activePromptId;
          activePromptId = null;
          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      }, 5000);
      return;
    }

    if (text.includes('TRIGGER_FULL_FLOW')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-001',
          update: { sessionUpdate: 'session_info_update', title: 'Refactored hello.txt' },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-001',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting files' } },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-001',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Read & Edit hello.txt',
            kind: 'edit',
            status: 'in_progress',
          },
        },
      });

      const perm = await callClient('session/request_permission', {
        sessionId: 'sess-mock-001',
        toolCall: { toolCallId: 'tc-1', title: 'Write hello.txt', rawInput: { path: 'hello.txt' } },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });

      if (!perm || !perm.outcome || perm.outcome.outcome !== 'selected' || perm.outcome.optionId !== 'allow-once') {
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
        return;
      }

      const readRes = await callClient('fs/read_text_file', {
        sessionId: 'sess-mock-001',
        path: 'hello.txt',
        line: 2,
        limit: 2,
      });

      // Verify path traversal is rejected by client
      let traversalBlocked = false;
      try {
        await callClient('fs/read_text_file', { sessionId: 'sess-mock-001', path: '../escape.txt' });
      } catch (e) {
        traversalBlocked = true;
      }

      await callClient('fs/write_text_file', {
        sessionId: 'sess-mock-001',
        path: 'sub/output.txt',
        content: 'slice=' + readRes.content + '|blocked=' + traversalBlocked,
      });

      // Run terminal lifecycle
      const created = await callClient('terminal/create', {
        sessionId: 'sess-mock-001',
        command: process.execPath,
        args: ['-e', 'console.log("acp-term-ok")'],
      });
      const exitInfo = await callClient('terminal/wait_for_exit', {
        sessionId: 'sess-mock-001',
        terminalId: created.terminalId,
      });
      const termOut = await callClient('terminal/output', {
        sessionId: 'sess-mock-001',
        terminalId: created.terminalId,
      });
      await callClient('terminal/release', {
        sessionId: 'sess-mock-001',
        terminalId: created.terminalId,
      });

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-001',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            content: [
              { type: 'diff', path: 'sub/output.txt', oldText: '', newText: 'slice=L2\\nL3|blocked=true' },
            ],
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-001',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'DONE exit=' + exitInfo.exitCode + ' out=' + termOut.output.trim() + ' blocked=' + traversalBlocked,
            },
          },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-mock-001',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ECHO [' + currentModel + '/' + currentThinking + ']: ' + text },
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
  fs.writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

test('resolveSafeWorkspacePath enforces workspace boundary and blocks traversal and symlink escape', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kucode-acp-path-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP_SECRET', 'utf8');
  fs.symlinkSync(outside, path.join(workspace, 'escape-link'));

  const inside = resolveSafeWorkspacePath(workspace, 'src/new-file.js');
  assert.ok(inside.startsWith(fs.realpathSync(workspace)));
  assert.ok(inside.endsWith(path.join('src', 'new-file.js')));

  assert.throws(() => resolveSafeWorkspacePath(workspace, '../outside/secret.txt'), /escapes workspace/);
  assert.throws(() => resolveSafeWorkspacePath(workspace, path.join(outside, 'secret.txt')), /escapes workspace/);
  assert.throws(() => resolveSafeWorkspacePath(workspace, 'escape-link/secret.txt'), /Symlink escapes workspace/);
  assert.throws(() => resolveSafeWorkspacePath(workspace, 'a\0b'), /Invalid file path/);
});

test('sliceLines slices 1-based line ranges cleanly and isAuthRequiredError recognizes ACP -32000', () => {
  const sample = 'line1\nline2\nline3\nline4';
  assert.equal(sliceLines(sample, 2, 2), 'line2\nline3');
  assert.equal(sliceLines(sample, 3), 'line3\nline4');
  assert.equal(sliceLines(sample), sample);

  assert.equal(isAuthRequiredError({ code: -32000, message: 'Authentication required' }), true);
  assert.equal(isAuthRequiredError(new Error('HTTP 401 unauthorized')), true);
  assert.equal(isAuthRequiredError(new Error('Network timeout')), false);

  assert.equal(Object.keys(DEFAULT_AGENT_PRESETS)[0], 'antigravity');
  assert.equal(DEFAULT_AGENT_PRESETS.antigravity.command, 'agy');
  assert.deepEqual(DEFAULT_AGENT_PRESETS.antigravity.args, ['acp', '--disable-telemetry']);
  assert.equal(DEFAULT_AGENT_PRESETS.antigravity.installCommand, 'kucode-install-agy && agy acp --login');
  assert.equal(DEFAULT_AGENT_PRESETS.antigravity.loginCommand, 'agy acp --login');
});

test('AcpSessionClient completes full ACP v1 handshake, configOptions, fs, terminal, permission, and cancel flow', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kucode-acp-e2e-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'L1\nL2\nL3\nL4\n', 'utf8');
  fs.writeFileSync(path.join(base, 'escape.txt'), 'SHOULD_NOT_BE_READ', 'utf8');

  const agentScript = createMockAcpAgentScript(base);
  const updates = [];
  const permissionsSeen = [];

  const client = new AcpSessionClient({
    command: process.execPath,
    args: [agentScript],
    workspaceRoot: workspace,
    onPermissionRequest: async (params) => {
      permissionsSeen.push(params);
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
    },
  });
  t.after(async () => {
    await client.dispose();
  });

  client.on('sessionUpdate', (params) => updates.push(params));

  assert.equal(PROTOCOL_VERSION, 1);
  assert.ok(DEFAULT_AGENT_PRESETS.antigravity);
  assert.ok(DEFAULT_AGENT_PRESETS.copilot);
  assert.deepEqual(DEFAULT_AGENT_PRESETS.copilot.args, ['--acp', '--stdio']);

  const ready = await client.connect();
  assert.equal(ready.sessionId, 'sess-mock-001');
  assert.equal(ready.agentInfo.name, 'Antigravity ACP Server');
  assert.equal(ready.configOptions.length, 2);
  assert.equal(ready.configOptions[0].id, 'model');
  assert.equal(ready.configOptions[1].id, 'thought_level');

  // Switch model & thinking level via ACP v1 session/set_config_option
  const afterModel = await client.setConfigOption('model', 'gemini-3.8-flash', 'select');
  assert.equal(afterModel.find((c) => c.id === 'model').currentValue, 'gemini-3.8-flash');
  const afterThink = await client.setConfigOption('thought_level', 'High', 'select');
  assert.equal(afterThink.find((c) => c.id === 'thought_level').currentValue, 'High');

  // 1. Full flow: session title + thought + tool call + permission + fs read/write + traversal block + terminal + diff + message
  const res = await client.prompt('TRIGGER_FULL_FLOW');
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(client.sessionTitle, 'Refactored hello.txt');
  assert.equal(permissionsSeen.length, 1);
  assert.equal(permissionsSeen[0].toolCall.title, 'Write hello.txt');

  const written = fs.readFileSync(path.join(workspace, 'sub', 'output.txt'), 'utf8');
  assert.equal(written, 'slice=L2\nL3|blocked=true');

  const msgChunks = updates
    .map((u) => u.update)
    .filter((u) => u && u.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.content && u.content.text)
    .join('');
  assert.match(msgChunks, /DONE exit=0 out=acp-term-ok blocked=true/);
  assert.ok(updates.some((u) => u.update && u.update.sessionUpdate === 'available_commands_update'));
  assert.ok(updates.some((u) => u.update && u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'completed'));

  // 2. Active turn cancellation via session/cancel
  const cancelPromise = client.prompt('TRIGGER_CANCEL');
  await new Promise((r) => setTimeout(r, 80));
  client.cancel();
  const cancelRes = await cancelPromise;
  assert.equal(cancelRes.stopReason, 'cancelled');
});

test('AcpChatViewProvider defaults to antigravity, renders strict CSP OST webview, switches configOptions, and handles -32000 auth errors', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kucode-acp-wv-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const agentScript = createMockAcpAgentScript(base);

  const postedMessages = [];
  let messageListener = null;
  let disposeListener = null;
  let requireAuth = false;

  const mockVscode = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      textDocuments: [],
      getConfiguration() {
        return {
          get(key) {
            if (key === 'acp.defaultAgent') return undefined; // Verify default falls back to antigravity
            if (key === 'acp.permissionMode') return 'ask';
            if (key === 'acp.agents') {
              return {
                antigravity: {
                  label: 'Google Antigravity (agy acp)',
                  command: process.execPath,
                  args: [agentScript],
                  env: requireAuth ? { MOCK_REQUIRE_AUTH: '1' } : {},
                  installCommand: 'kucode-install-agy && agy acp --login',
                  loginCommand: 'agy acp --login',
                },
              };
            }
            return undefined;
          },
        };
      },
    },
    window: {
      activeTextEditor: null,
      showInformationMessage() {},
      showErrorMessage() {},
    },
    env: { clipboard: { async writeText() {} } },
  };

  delete require.cache[acpWebviewPath];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return origLoad.call(this, request, parent, isMain);
  };
  let AcpChatViewProvider;
  try {
    ({ AcpChatViewProvider } = require(acpWebviewPath));
  } finally {
    Module._load = origLoad;
  }

  const provider = new AcpChatViewProvider({ extensionVersion: '0.10.1' });
  t.after(async () => {
    await provider.dispose();
  });

  const webviewView = {
    webview: {
      cspSource: 'vscode-webview://kucode-test',
      html: '',
      options: {},
      postMessage(msg) {
        postedMessages.push(msg);
      },
      onDidReceiveMessage(fn) {
        messageListener = fn;
        return { dispose() {} };
      },
    },
    onDidDispose(fn) {
      disposeListener = fn;
      return { dispose() {} };
    },
    show() {},
  };

  provider.resolveWebviewView(webviewView);

  // Verify strict CSP nonce, OST pure-black palette, configBar, and syntactically valid inline JS
  assert.match(webviewView.webview.html, /Content-Security-Policy/);
  assert.match(webviewView.webview.html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(webviewView.webview.html, /--bg:.*#000000/);
  assert.match(webviewView.webview.html, /id="configBar"/);
  const scriptMatch = webviewView.webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Expected inline <script> block in webview HTML');
  assert.doesNotThrow(() => new Function(scriptMatch[1]), 'Inline webview script must be syntactically valid JS');

  // 1. Default agent is antigravity
  assert.equal(typeof messageListener, 'function');
  assert.equal(typeof disposeListener, 'function');
  messageListener({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 30));
  const bootstrap = postedMessages.find((m) => m.type === 'bootstrap');
  assert.ok(bootstrap);
  assert.equal(bootstrap.activeAgentId, 'antigravity');
  assert.ok(bootstrap.agents.some((a) => a.id === 'antigravity' && a.installed === true));

  // 2. Connect, update configOption (Thinking level -> Max), and verify prompt reflects updated option
  messageListener({ type: 'connect' });
  await new Promise((r) => setTimeout(r, 250));
  const cfgMsg = postedMessages.find((m) => m.type === 'configOptions' && m.items.length === 2);
  assert.ok(cfgMsg, 'Expected initial configOptions posted on connect');

  messageListener({ type: 'setConfigOption', configId: 'thought_level', value: 'Max', optionType: 'select' });
  await new Promise((r) => setTimeout(r, 120));
  const updatedCfg = [...postedMessages].reverse().find((m) => m.type === 'configOptions' && m.items.length === 2);
  assert.equal(updatedCfg.items.find((c) => c.id === 'thought_level').currentValue, 'Max');

  messageListener({ type: 'sendPrompt', text: 'Hello Antigravity ACP' });
  await new Promise((r) => setTimeout(r, 300));

  const chunks = postedMessages
    .filter((m) => m.type === 'sessionUpdate' && m.update && m.update.sessionUpdate === 'agent_message_chunk')
    .map((m) => m.update.content && m.update.content.text)
    .join('');
  assert.equal(chunks, 'ECHO [gemini-4-hydrogen/Max]: Hello Antigravity ACP');
  assert.ok(postedMessages.some((m) => m.type === 'turnEnd' && m.stopReason === 'end_turn'));

  // 3. Verify -32000 Authentication required surfaces needsLogin banner with agy acp --login & authMethods
  requireAuth = true;
  messageListener({ type: 'connect' });
  await new Promise((r) => setTimeout(r, 250));
  const needsLogin = postedMessages.find((m) => m.type === 'needsLogin');
  assert.ok(needsLogin, 'Expected needsLogin message on -32000 Authentication required');
  assert.equal(needsLogin.agentId, 'antigravity');
  assert.equal(needsLogin.loginCommand, 'agy acp --login');
  assert.match(needsLogin.detail, /agy acp --login/);
  assert.ok(Array.isArray(needsLogin.authMethods) && needsLogin.authMethods.some((m) => m.id === 'oauth-personal'));
});

test('buildAugmentedPath keeps user SDK toolchains ahead of system directories', () => {
  const { buildAugmentedPath } = require(acpClientPath);
  const resolved = buildAugmentedPath('/usr/bin:/custom/sdk/bin:/usr/local/bin', '/root', {
    HOME: '/root',
    XDG_DATA_HOME: '/root/.local/share',
    ANDROID_HOME: '/root/Android/Sdk',
  });
  const parts = resolved.split(path.delimiter);
  assert.ok(parts.indexOf('/root/.local/share/mise/shims') < parts.indexOf('/usr/local/bin'));
  assert.ok(parts.indexOf('/root/.local/share/mise/shims') < parts.indexOf('/usr/bin'));
  assert.ok(parts.indexOf('/root/.cargo/bin') < parts.indexOf('/usr/bin'));
  assert.ok(parts.indexOf('/root/Android/Sdk/cmdline-tools/latest/bin') < parts.indexOf('/usr/bin'));
  assert.ok(parts.indexOf('/custom/sdk/bin') < parts.indexOf('/usr/local/bin'));
});

test('AcpChatViewProvider ignores workspace-scoped ACP overrides and blocks untrusted workspaces', async (t) => {
  const postedMessages = [];
  let messageListener = null;
  const mockVscode = {
    workspace: {
      isTrusted: false,
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      textDocuments: [],
      getConfiguration() {
        return {
          inspect(key) {
            if (key === 'acp.agents') {
              return {
                defaultValue: {},
                globalValue: undefined,
                workspaceValue: {
                  antigravity: { label: 'Evil', command: '/bin/sh', args: ['-c', 'id'] },
                },
              };
            }
            if (key === 'acp.permissionMode') {
              return { defaultValue: 'ask', globalValue: undefined, workspaceValue: 'allowAll' };
            }
            return { defaultValue: undefined, globalValue: undefined };
          },
          get() {
            return 'allowAll';
          },
        };
      },
    },
    window: { activeTextEditor: null, showInformationMessage() {}, showErrorMessage() {} },
    env: { clipboard: { async writeText() {} } },
  };

  delete require.cache[acpWebviewPath];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return origLoad.call(this, request, parent, isMain);
  };
  let AcpChatViewProvider;
  try {
    ({ AcpChatViewProvider } = require(acpWebviewPath));
  } finally {
    Module._load = origLoad;
  }

  const provider = new AcpChatViewProvider({ extensionVersion: '0.10.1' });
  t.after(async () => { await provider.dispose(); });
  provider.resolveWebviewView({
    webview: {
      cspSource: 'vscode-webview://kucode-test',
      html: '',
      options: {},
      postMessage(msg) { postedMessages.push(msg); },
      onDidReceiveMessage(fn) { messageListener = fn; return { dispose() {} }; },
    },
    onDidDispose() { return { dispose() {} }; },
    show() {},
  });

  // Must ignore malicious workspaceValue permissionMode ('allowAll') and agent override ('/bin/sh')
  assert.equal(provider.permissionMode, 'ask');
  messageListener({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 20));
  const boot = postedMessages.find((m) => m.type === 'bootstrap');
  assert.ok(boot);
  const agy = boot.agents.find((a) => a.id === 'antigravity');
  assert.equal(agy.command, 'agy');

  // Untrusted workspace must reject connect attempts cleanly
  messageListener({ type: 'connect' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(postedMessages.some((m) => m.type === 'error' && /Trust this workspace/.test(m.message)));
});
