'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '../..');
const POSIX_RUNTIME_CONFIG_PATH = path.join(
  REPO_ROOT,
  'android/app/src/main/java/dev/koduki/kucode/PosixRuntimeConfig.kt'
);
const BUILD_GRADLE_PATH = path.join(REPO_ROOT, 'android/app/build.gradle.kts');
const TOOLS_PACKAGE_JSON_PATH = path.join(
  REPO_ROOT,
  'android/app/src/main/assets/kucode-tools/package.json'
);
const TOOLS_EXTENSION_JS_PATH = path.join(
  REPO_ROOT,
  'android/app/src/main/assets/kucode-tools/extension.js'
);
const TOOLS_ACP_WEBVIEW_JS_PATH = path.join(
  REPO_ROOT,
  'android/app/src/main/assets/kucode-tools/acp-webview.js'
);
const TOOLS_ACP_CLIENT_JS_PATH = path.join(
  REPO_ROOT,
  'android/app/src/main/assets/kucode-tools/acp-client.js'
);

/**
 * Extracts result["kucode-install-agy"] = """ ... """.trimIndent() + "\n"
 * from PosixRuntimeConfig.kt, reproducing Kotlin's trimIndent() and ${'$'} interpolation.
 */
function extractInstallAgyScript() {
  const ktSource = fs.readFileSync(POSIX_RUNTIME_CONFIG_PATH, 'utf8').replace(/\r\n/g, '\n');
  const match = ktSource.match(
    /result\["kucode-install-agy"\]\s*=\s*"""\n([\s\S]*?)"""\.trimIndent\(\)\s*\+\s*"\\n"/
  );
  assert.ok(match, 'PosixRuntimeConfig.kt must define result["kucode-install-agy"] = """...""".trimIndent() + "\\n"');

  const rawBody = match[1];
  const lines = rawBody.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^(\s*)/);
    const indentLen = indentMatch ? indentMatch[1].length : 0;
    if (indentLen < minIndent) minIndent = indentLen;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  const dedented = lines
    .map((line) => (line.trim() === '' ? '' : line.slice(minIndent)))
    .join('\n');

  // Unescape Kotlin raw-string dollar interpolation: ${'$'} -> $
  return dedented.replace(/\$\{'\$'\}/g, '$') + '\n';
}

function makeSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const tmpDir = path.join(root, 'tmp');
  const mockBin = path.join(root, 'mock-bin');
  const customToolBin = path.join(root, 'custom-toolchain', 'bin');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });
  fs.mkdirSync(customToolBin, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, home, tmpDir, mockBin, customToolBin, stateDir };
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

/**
 * Writes a PATH-prepended mock `curl` that:
 * - Asserts `https://antigravity.google/cli/install.sh` is requested.
 * - Optionally exits with a failure code (e.g., 22) when `MOCK_CURL_FAIL_RC` is set.
 * - Otherwise prints a strict mock `install.sh` modeling the real official upstream script:
 *   * Accepts ONLY `-d|--dir <path>` and `-h|--help`; exits 1 with `[ERROR] Unknown parameter: <arg>` on anything else.
 *   * Exits 0 early if `$BINARY_PATH` already exists (`if [ -f "$BINARY_PATH" ]; then exit 0; fi`).
 *   * Writes an executable mock `agy` binary into `$TARGET_DIR/agy`.
 *   * Runs `"$BINARY_PATH" install [--dir "$CUSTOM_DIR"] || true` at the end (mutating `$HOME/.bashrc`, `.profile`, `.zshrc`).
 */
function setupMockCurl(sandbox, options = {}) {
  const {
    versionLabel = 'agy 1.2.3',
    versionExitCode = 0,
    acpHelpExitCode = 0,
    curlExitCode = 0,
  } = options;

  const mockAgyBody = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  --version)
    if [ "${versionExitCode}" -ne 0 ]; then
      echo "mock agy --version failed (rc=${versionExitCode})" >&2
      exit ${versionExitCode}
    fi
    echo "${versionLabel}"
    exit 0
    ;;
  acp)
    if [ "\${2:-}" = "--help" ]; then
      if [ "${acpHelpExitCode}" -ne 0 ]; then
        exit ${acpHelpExitCode}
      fi
      echo "agy acp v1 server help"
      exit 0
    fi
    ;;
  install)
    # Models upstream \`agy install\` attempting to mutate shell RC files in $HOME
    mkdir -p "$HOME"
    printf '\\n# added by agy install\\nexport PATH="%s:$PATH"\\n' "\${3:-$HOME/.local/bin}" >> "$HOME/.bashrc"
    printf '\\n# added by agy install\\nexport PATH="%s:$PATH"\\n' "\${3:-$HOME/.local/bin}" >> "$HOME/.profile"
    printf '\\n# added by agy install\\nexport PATH="%s:$PATH"\\n' "\${3:-$HOME/.local/bin}" >> "$HOME/.zshrc"
    exit 0
    ;;
esac
echo "unexpected mock agy args: $*" >&2
exit 1
`;

  const agyPayloadPath = path.join(sandbox.stateDir, 'mock-agy-payload.sh');
  fs.writeFileSync(agyPayloadPath, mockAgyBody, 'utf8');

  const installShBody = `#!/usr/bin/env bash
set -euo pipefail
CUSTOM_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d|--dir)
      if [ "$#" -lt 2 ] || [ -z "\${2:-}" ]; then
        echo "[ERROR] Missing argument for $1" >&2
        exit 1
      fi
      CUSTOM_DIR="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: install.sh [-d|--dir <path>] [-h|--help]"
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown parameter: $1" >&2
      exit 1
      ;;
  esac
done

TARGET_DIR="\${CUSTOM_DIR:-$HOME/.local/bin}"
BINARY_PATH="$TARGET_DIR/agy"

# Upstream behavior: early exit if $BINARY_PATH already exists
if [ -f "$BINARY_PATH" ]; then
  echo "[INFO] agy already exists at $BINARY_PATH; skipping download"
  exit 0
fi

mkdir -p "$TARGET_DIR"
cp "${agyPayloadPath}" "$BINARY_PATH"
chmod 755 "$BINARY_PATH"

if [ -n "$CUSTOM_DIR" ]; then
  "$BINARY_PATH" install --dir "$CUSTOM_DIR" || true
else
  "$BINARY_PATH" install || true
fi
`;

  const installShPath = path.join(sandbox.stateDir, 'upstream-install.sh');
  fs.writeFileSync(installShPath, installShBody, 'utf8');

  const curlLogPath = path.join(sandbox.stateDir, 'curl-calls.log');
  const mockCurl = `#!/usr/bin/env bash
set -euo pipefail
url=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      url="$arg"
      ;;
  esac
done
printf '%s\\n' "$*" >> "${curlLogPath}"
if [ "$url" != "https://antigravity.google/cli/install.sh" ]; then
  echo "Unexpected curl URL: '$url' (args: $*)" >&2
  exit 99
fi
if [ "${curlExitCode}" -ne 0 ]; then
  echo "curl: (22) Mock download error" >&2
  exit ${curlExitCode}
fi
cat "${installShPath}"
`;

  writeExecutable(path.join(sandbox.mockBin, 'curl'), mockCurl);
  return { curlLogPath };
}

async function runInstaller(scriptPath, sandbox, extraEnv = {}) {
  const basePath = [
    sandbox.mockBin,
    sandbox.customToolBin,
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ].join(':');

  try {
    const res = await execFileAsync('bash', [scriptPath], {
      env: {
        HOME: sandbox.home,
        TMPDIR: sandbox.tmpDir,
        PATH: basePath,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        ...extraEnv,
      },
      timeout: 15000,
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

// ---------------------------------------------------------------------------
// AC-1: Syntax, official URL, no unsupported flags, E2E fresh install & cleanup
// ---------------------------------------------------------------------------
test('[AC-1] kucode-install-agy passes bash -n, omits --skip-path/--skip-aliases, keeps official URL hardcoded, and completes fresh E2E install with temp cleanup', async () => {
  const script = extractInstallAgyScript();
  assert.match(script, /^#!\/usr\/bin\/env bash\n/, 'Script must start with #!/usr/bin/env bash');
  assert.match(script, /\bset -euo pipefail\b/, 'Script must enable strict bash mode');
  assert.equal(/--skip-path/.test(script), false, 'Script MUST NOT contain unsupported --skip-path flag');
  assert.equal(/--skip-aliases/.test(script), false, 'Script MUST NOT contain unsupported --skip-aliases flag');
  assert.match(
    script,
    /https:\/\/antigravity\.google\/cli\/install\.sh/,
    'Script must hardcode https://antigravity.google/cli/install.sh'
  );
  // Ensure no untrusted URL override env var substitution around the official URL
  assert.equal(
    /\$\{?[A-Z0-9_]*INSTALL[A-Z0-9_]*URL/.test(script),
    false,
    'Script MUST NOT introduce an untrusted installer URL override env var'
  );

  const sandbox = makeSandbox('kucode-agy-ac1-');
  try {
    const scriptPath = path.join(sandbox.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    const syntax = await execFileAsync('bash', ['-n', scriptPath]);
    assert.equal(syntax.stderr, '', 'bash -n must pass cleanly');

    const { curlLogPath } = setupMockCurl(sandbox, { versionLabel: 'agy 1.2.3-ac1' });
    const res = await runInstaller(scriptPath, sandbox);
    assert.equal(
      res.code,
      0,
      `Expected fresh install to exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const installedBin = path.join(sandbox.home, '.local/bin/agy');
    assert.equal(fs.existsSync(installedBin), true, '$HOME/.local/bin/agy must exist after install');
    const stat = fs.statSync(installedBin);
    assert.ok((stat.mode & 0o111) !== 0, '$HOME/.local/bin/agy must be executable');

    const versionOut = await execFileAsync(installedBin, ['--version']);
    assert.equal(versionOut.stdout.trim(), 'agy 1.2.3-ac1');

    assert.match(res.stdout, /\[kucode\] Installed:.*agy 1\.2\.3-ac1/);
    assert.match(res.stdout, /\[kucode\] Verified: 'agy acp' ACP v1 server subcommand is ready\./);
    assert.match(res.stdout, /\[kucode\] Next step: run 'agy acp --login'/);

    const curlLog = fs.readFileSync(curlLogPath, 'utf8');
    assert.match(curlLog, /https:\/\/antigravity\.google\/cli\/install\.sh/);

    // Verify no leftover temp staging directories remain inside TMPDIR
    const leftoverTmp = fs.readdirSync(sandbox.tmpDir);
    assert.deepEqual(leftoverTmp, [], `Expected TMPDIR to be cleaned up, found: ${JSON.stringify(leftoverTmp)}`);
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-2: Isolated HOME prevents RC mutation & PATH ordering preserves user entries
// ---------------------------------------------------------------------------
test('[AC-2] kucode-install-agy isolates HOME during install.sh so ~/.bashrc, ~/.profile, ~/.zshrc stay byte-identical and preserves user-first PATH ordering', async () => {
  const script = extractInstallAgyScript();
  const sandbox = makeSandbox('kucode-agy-ac2-');
  try {
    const scriptPath = path.join(sandbox.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    const bashrcContent = '# user custom bashrc\nexport FOO="bar"\n';
    const profileContent = '# user custom profile\nexport BAZ="qux"\n';
    const zshrcContent = '# user custom zshrc\nexport ZDOT="keep"\n';

    const bashrcPath = path.join(sandbox.home, '.bashrc');
    const profilePath = path.join(sandbox.home, '.profile');
    const zshrcPath = path.join(sandbox.home, '.zshrc');
    fs.writeFileSync(bashrcPath, bashrcContent, 'utf8');
    fs.writeFileSync(profilePath, profileContent, 'utf8');
    fs.writeFileSync(zshrcPath, zshrcContent, 'utf8');

    // Verify custom toolchain entry before /usr/local/bin:/usr/bin is NOT clobbered
    // Place a helper script in customToolBin that logs PATH as seen inside curl/subprocesses
    const pathTraceFile = path.join(sandbox.stateDir, 'observed-path.txt');
    writeExecutable(
      path.join(sandbox.customToolBin, 'custom-sdk-tool'),
      '#!/usr/bin/env bash\necho ok\n'
    );

    setupMockCurl(sandbox, { versionLabel: 'agy 1.2.3-ac2' });
    // Wrap mock curl to also record PATH visible during script execution
    const originalMockCurl = fs.readFileSync(path.join(sandbox.mockBin, 'curl'), 'utf8');
    writeExecutable(
      path.join(sandbox.mockBin, 'curl'),
      originalMockCurl.replace(
        'printf \'%s\\n\' "$*" >>',
        `printf '%s\\n' "$PATH" > "${pathTraceFile}"\nprintf '%s\\n' "$*" >>`
      )
    );

    const res = await runInstaller(scriptPath, sandbox);
    assert.equal(
      res.code,
      0,
      `Expected install to exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    assert.equal(fs.readFileSync(bashrcPath, 'utf8'), bashrcContent, '~/.bashrc must remain byte-for-byte identical');
    assert.equal(fs.readFileSync(profilePath, 'utf8'), profileContent, '~/.profile must remain byte-for-byte identical');
    assert.equal(fs.readFileSync(zshrcPath, 'utf8'), zshrcContent, '~/.zshrc must remain byte-for-byte identical');

    assert.equal(fs.existsSync(pathTraceFile), true, 'mock curl must have recorded PATH');
    const observedPath = fs.readFileSync(pathTraceFile, 'utf8').trim();
    const parts = observedPath.split(':');
    const customIdx = parts.indexOf(sandbox.customToolBin);
    const usrLocalBinIdx = parts.indexOf('/usr/local/bin');
    const usrBinIdx = parts.indexOf('/usr/bin');
    assert.ok(customIdx !== -1, `Expected user PATH entry ${sandbox.customToolBin} to be preserved in PATH: ${observedPath}`);
    assert.ok(
      usrLocalBinIdx === -1 || customIdx < usrLocalBinIdx,
      `User toolchain ${sandbox.customToolBin} must precede /usr/local/bin in PATH: ${observedPath}`
    );
    assert.ok(
      usrBinIdx === -1 || customIdx < usrBinIdx,
      `User toolchain ${sandbox.customToolBin} must precede /usr/bin in PATH: ${observedPath}`
    );
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-3: Broken/empty file recovery & wrapped agy + agy.real clean upgrade
// ---------------------------------------------------------------------------
test('[AC-3] kucode-install-agy recovers from broken/empty ~/.local/bin/agy and upgrades wrapped agy + agy.real cleanly without double-wrapping or stale agy.real', async () => {
  const script = extractInstallAgyScript();

  // Case (a): Pre-existing broken/empty/non-executable ~/.local/bin/agy
  const sandboxA = makeSandbox('kucode-agy-ac3a-');
  try {
    const scriptPath = path.join(sandboxA.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    const localBin = path.join(sandboxA.home, '.local/bin');
    fs.mkdirSync(localBin, { recursive: true });
    const targetAgy = path.join(localBin, 'agy');
    fs.writeFileSync(targetAgy, '', { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(targetAgy, 0o644);

    setupMockCurl(sandboxA, { versionLabel: 'agy 2.0.0-recovered' });
    const res = await runInstaller(scriptPath, sandboxA);
    assert.equal(
      res.code,
      0,
      `Expected recovery install to exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const stat = fs.statSync(targetAgy);
    assert.ok((stat.mode & 0o111) !== 0, 'Recovered ~/.local/bin/agy must be executable');
    const ver = await execFileAsync(targetAgy, ['--version']);
    assert.equal(ver.stdout.trim(), 'agy 2.0.0-recovered');
  } finally {
    fs.rmSync(sandboxA.root, { recursive: true, force: true });
  }

  // Case (b): Pre-existing wrapped ~/.local/bin/agy + ~/.local/bin/agy.real (older version)
  const sandboxB = makeSandbox('kucode-agy-ac3b-');
  try {
    const scriptPath = path.join(sandboxB.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    const localBin = path.join(sandboxB.home, '.local/bin');
    fs.mkdirSync(localBin, { recursive: true });
    const agyReal = path.join(localBin, 'agy.real');
    const agyWrapper = path.join(localBin, 'agy');
    writeExecutable(
      agyReal,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo "agy 0.9.0-old-real"; exit 0; fi\nexit 0\n'
    );
    writeExecutable(
      agyWrapper,
      `#!/bin/sh\nexec "${agyReal}" "$@"\n`
    );

    setupMockCurl(sandboxB, { versionLabel: 'agy 2.1.0-upgraded' });
    const res = await runInstaller(scriptPath, sandboxB);
    assert.equal(
      res.code,
      0,
      `Expected upgrade over wrapped agy+agy.real to exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const ver = await execFileAsync(agyWrapper, ['--version']);
    assert.equal(
      ver.stdout.trim(),
      'agy 2.1.0-upgraded',
      'Upgraded agy must invoke new version, not old agy.real'
    );
    assert.equal(
      fs.existsSync(agyReal),
      false,
      'Stale ~/.local/bin/agy.real must be removed when direct execution of upgraded binary succeeds'
    );
    const installedContents = fs.readFileSync(agyWrapper, 'utf8');
    assert.equal(
      installedContents.includes('agy.real'),
      false,
      'Upgraded agy must not be a wrapper referencing agy.real'
    );
  } finally {
    fs.rmSync(sandboxB.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-4: Atomic failure preservation on download failure and SIGSYS (159)
// ---------------------------------------------------------------------------
test('[AC-4] kucode-install-agy preserves pre-existing working ~/.local/bin/agy untouched on curl download failure and on staged --version SIGSYS (159)', async () => {
  const script = extractInstallAgyScript();
  const workingAgyScript =
    '#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo "agy 1.0.0-working"; exit 0; fi\nexit 0\n';

  // Case (a): curl fails (exit 22)
  const sandboxDownloadFail = makeSandbox('kucode-agy-ac4a-');
  try {
    const scriptPath = path.join(sandboxDownloadFail.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    const existingAgy = path.join(sandboxDownloadFail.home, '.local/bin/agy');
    writeExecutable(existingAgy, workingAgyScript);

    setupMockCurl(sandboxDownloadFail, { curlExitCode: 22 });
    const res = await runInstaller(scriptPath, sandboxDownloadFail);
    assert.notEqual(res.code, 0, 'Download failure must exit non-zero');

    assert.equal(
      fs.readFileSync(existingAgy, 'utf8'),
      workingAgyScript,
      'Existing working ~/.local/bin/agy must remain byte-for-byte intact on download failure'
    );
    const leftoverTmp = fs.readdirSync(sandboxDownloadFail.tmpDir);
    assert.deepEqual(
      leftoverTmp,
      [],
      `Staging dir in TMPDIR must be cleaned up on download failure, found: ${JSON.stringify(leftoverTmp)}`
    );
  } finally {
    fs.rmSync(sandboxDownloadFail.root, { recursive: true, force: true });
  }

  // Case (b): newly staged agy fails --version with exit 159 (SIGSYS)
  const sandboxSigsys = makeSandbox('kucode-agy-ac4b-');
  try {
    const scriptPath = path.join(sandboxSigsys.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    const existingAgy = path.join(sandboxSigsys.home, '.local/bin/agy');
    writeExecutable(existingAgy, workingAgyScript);

    setupMockCurl(sandboxSigsys, { versionExitCode: 159 });
    const res = await runInstaller(scriptPath, sandboxSigsys);
    assert.equal(
      res.code,
      159,
      `Expected SIGSYS probe failure to exit 159, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.match(res.stderr, /SIGSYS \(159\)/, 'Stderr must report SIGSYS (159)');
    assert.match(res.stderr, /PROOT_NO_SECCOMP/, 'Stderr must include PROOT_NO_SECCOMP guidance');

    assert.equal(
      fs.readFileSync(existingAgy, 'utf8'),
      workingAgyScript,
      'Existing working ~/.local/bin/agy must remain untouched when staged binary fails --version with 159'
    );
    const leftoverTmp = fs.readdirSync(sandboxSigsys.tmpDir);
    assert.deepEqual(
      leftoverTmp,
      [],
      `Staging dir in TMPDIR must be cleaned up after SIGSYS exit, found: ${JSON.stringify(leftoverTmp)}`
    );
  } finally {
    fs.rmSync(sandboxSigsys.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-5: ld-linux-aarch64.so.1 exec wrapper contract, prerequisites, non-fatal acp --help
// ---------------------------------------------------------------------------
test('[AC-5] kucode-install-agy verifies curl/git/tar/gzip/sha512sum, preserves ld-linux-aarch64.so.1 wrapper fallback contract, and treats acp --help failure as non-fatal warning', async () => {
  const script = extractInstallAgyScript();

  // Contract checks for prerequisite tools and ld-linux-aarch64.so.1 fallback + safe re-probe
  const hasExplicitChecks = ['curl', 'git', 'tar', 'gzip', 'sha512sum'].every((tool) =>
    new RegExp(`command\\s+-v\\s+${tool}\\b`).test(script)
  );
  const hasLoopCheck =
    /for\s+\w+\s+in\s+[^\n]*\bcurl\b[^\n]*\bgit\b[^\n]*\btar\b[^\n]*\bgzip\b[^\n]*\bsha512sum\b|for\s+\w+\s+in\s+.*\b(curl|git|tar|gzip|sha512sum)\b[\s\S]*command\s+-v/.test(
      script
    ) &&
    ['curl', 'git', 'tar', 'gzip', 'sha512sum'].every((tool) => new RegExp(`\\b${tool}\\b`).test(script)) &&
    /command\s+-v\s+/.test(script);
  assert.ok(
    hasExplicitChecks || hasLoopCheck,
    'Script must check prerequisite tools curl, git, tar, gzip, and sha512sum via command -v'
  );

  assert.match(script, /\/lib\/ld-linux-aarch64\.so\.1/);
  assert.match(script, /agy\.real/);
  assert.match(script, /chmod 755/);
  assert.match(script, /#!\/bin\/sh/);
  assert.match(script, /exec \/lib\/ld-linux-aarch64\.so\.1 "\$HOME\/\.local\/bin\/agy\.real" "\$@"/);
  assert.match(
    script,
    /apt-get install -y --no-install-recommends[^\n]*\bca-certificates\b[^\n]*\bcurl\b[^\n]*\bgit\b[^\n]*\btar\b[^\n]*\bgzip\b[^\n]*\bcoreutils\b/,
    'Missing prerequisite fallback must install ca-certificates curl git tar gzip coreutils via apt-get'
  );
  // Ensure wrapper re-probe is protected under set +e with explicit failure reporting
  const setPlusEBlocks = script.match(/set \+e[\s\S]*?set -e/g) || [];
  const hasCombinedWrapReprobe = setPlusEBlocks.some(
    (blk) => /agy\.real/.test(blk) && /--version/.test(blk)
  );
  const hasSeparatePostWrapProbe =
    /agy\.real[\s\S]*?set \+e[\s\S]*?--version[\s\S]*?set -e/.test(script);
  assert.ok(
    hasCombinedWrapReprobe || hasSeparatePostWrapProbe,
    'Post-wrap re-probe must run under set +e before restoring set -e'
  );

  // Live behavioral check: agy --version passes, agy acp --help exits 1 -> script exits 0 with WARNING
  const sandbox = makeSandbox('kucode-agy-ac5-');
  try {
    const scriptPath = path.join(sandbox.root, 'kucode-install-agy');
    writeExecutable(scriptPath, script);

    setupMockCurl(sandbox, {
      versionLabel: 'agy 1.2.3-ac5',
      acpHelpExitCode: 1,
    });
    const res = await runInstaller(scriptPath, sandbox);
    assert.equal(
      res.code,
      0,
      `Expected acp --help failure to be non-fatal (exit 0), got ${res.code}\nstderr:\n${res.stderr}`
    );
    assert.match(res.stdout, /\[kucode\] Installed:.*agy 1\.2\.3-ac5/);
    assert.match(
      res.stderr,
      /\[kucode\] WARNING: 'agy acp --help' did not succeed/,
      'Expected non-fatal WARNING on stderr when agy acp --help fails'
    );
    assert.equal(
      /\[kucode\] Verified: 'agy acp'/.test(res.stdout),
      false,
      'Verified message must not print when agy acp --help fails'
    );
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-6: Consistent release version parity 0.10.1 (versionCode = 12)
// ---------------------------------------------------------------------------
test('[AC-6] Release version metadata is consistently bumped to 0.10.1 (versionCode = 12) across Gradle, PosixRuntimeConfig, and kucode-tools assets', () => {
  const buildGradle = fs.readFileSync(BUILD_GRADLE_PATH, 'utf8');
  assert.match(buildGradle, /\bversionCode\s*=\s*12\b/, 'build.gradle.kts must set versionCode = 12');
  assert.match(buildGradle, /\bversionName\s*=\s*"0\.10\.1"/, 'build.gradle.kts must set versionName = "0.10.1"');

  const posixRuntimeConfig = fs.readFileSync(POSIX_RUNTIME_CONFIG_PATH, 'utf8');
  assert.match(
    posixRuntimeConfig,
    /const val RUNTIME_VERSION\s*=\s*"0\.10\.1-debian12-openvscode-1\.109\.5"/,
    'PosixRuntimeConfig.RUNTIME_VERSION must be "0.10.1-debian12-openvscode-1.109.5"'
  );

  const toolsPkg = JSON.parse(fs.readFileSync(TOOLS_PACKAGE_JSON_PATH, 'utf8'));
  assert.equal(toolsPkg.version, '0.10.1', 'kucode-tools/package.json version must be 0.10.1');

  const extensionJs = fs.readFileSync(TOOLS_EXTENSION_JS_PATH, 'utf8');
  assert.match(
    extensionJs,
    /extensionVersion\s*:\s*['"]0\.10\.1['"]/,
    "kucode-tools/extension.js must pass extensionVersion: '0.10.1'"
  );

  const acpWebviewJs = fs.readFileSync(TOOLS_ACP_WEBVIEW_JS_PATH, 'utf8');
  assert.match(
    acpWebviewJs,
    /this\.extensionVersion\s*=\s*\(options\s*&&\s*options\.extensionVersion\)\s*\|\|\s*['"]0\.10\.1['"]/,
    "kucode-tools/acp-webview.js must default extensionVersion fallback to '0.10.1'"
  );

  const acpClientJs = fs.readFileSync(TOOLS_ACP_CLIENT_JS_PATH, 'utf8');
  assert.match(
    acpClientJs,
    /this\.clientVersion\s*=\s*options\.clientVersion\s*\|\|\s*['"]0\.10\.1['"]/,
    "kucode-tools/acp-client.js must default clientVersion fallback to '0.10.1'"
  );
});
