package dev.koduki.kucode

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PosixRuntimeConfigTest {

    @Test
    fun buildProotCommand_includesDecoupledWorkspaceHomeAndAndroidMounts() {
        val paths = PosixRuntimeConfig.Paths(
            runtimeRoot = File("/data/user/0/dev.koduki.kucode/files/runtime"),
            workspaceDir = File("/data/user/0/dev.koduki.kucode/files/workspace"),
            homeDir = File("/data/user/0/dev.koduki.kucode/files/home"),
            nativeLibDir = File("/data/app/kucode/lib/arm64"),
            androidSharedDir = File("/sdcard/Android/data/dev.koduki.kucode/files/shared"),
            androidSdcardDir = File("/storage/emulated/0"),
        )

        assertEquals(File(paths.rootfsDir, ".kucode-runtime-version"), paths.versionMarker)
        assertEquals(File(paths.vscodeDataDir, "user/Machine/settings.json"), paths.machineSettingsFile)
        assertEquals(File(paths.vscodeDataDir, "data/Machine/settings.json"), paths.legacyMachineSettingsFile)
        assertEquals(File(paths.vscodeDataDir, ".server-pid"), paths.serverPidFile)

        val cmd = PosixRuntimeConfig.buildProotCommand(
            paths = paths,
            guestCommand = PosixRuntimeConfig.buildOpenVsCodeServerCommand(PosixRuntimeConfig.PREFERRED_SERVER_PORT),
        )
        assertEquals("/data/app/kucode/lib/arm64/libproot.so", cmd.first())
        assertTrue(cmd.contains("--link2symlink"))
        assertTrue(cmd.contains("--kill-on-exit"))
        assertTrue(cmd.contains("/data/user/0/dev.koduki.kucode/files/workspace:/workspace"))
        assertTrue(cmd.contains("/data/user/0/dev.koduki.kucode/files/home:/root"))
        assertTrue(cmd.contains("/data/user/0/dev.koduki.kucode/files/diagnostics:/var/log/kucode"))
        assertTrue(cmd.contains("/sdcard/Android/data/dev.koduki.kucode/files/shared:/android/shared"))
        assertTrue(cmd.contains("/storage/emulated/0:/android/sdcard"))
        assertFalse(cmd.contains("--without-connection-token"))
        assertTrue(cmd.contains("--without-browser-env-var"))
        assertEquals("/var/lib/kucode-vscode/.editor-token", cmd[cmd.indexOf("--connection-token-file") + 1])
        assertTrue(cmd.contains("18765"))

        val env = PosixRuntimeConfig.buildProotEnvironment(
            paths = paths,
            disableSeccomp = true,
            adminPort = 43210,
            adminToken = "secret-token",
            includeNodeExtraCaCerts = false,
        )
        assertEquals("/data/app/kucode/lib/arm64/libproot-loader.so", env["PROOT_LOADER"])
        assertEquals("1", env["PROOT_NO_SECCOMP"])
        assertEquals("43210", env["KUCODE_ADMIN_PORT"])
        assertEquals("secret-token", env["KUCODE_ADMIN_TOKEN"])
        assertEquals("/usr/local/bin/kucode-open", env["BROWSER"])
        assertEquals("/usr/local/bin/kucode-open", env["GH_BROWSER"])
        assertTrue(env["PATH"]!!.startsWith("/root/.local/bin:"))
        assertEquals("/tmp", env["TMPDIR"])
        assertEquals("/etc/ssl/certs/ca-certificates.crt", env["SSL_CERT_FILE"])
        assertEquals("/etc/ssl/certs", env["SSL_CERT_DIR"])
        assertEquals("/etc/ssl/certs/ca-certificates.crt", env["CURL_CA_BUNDLE"])
        assertEquals("/etc/ssl/certs/ca-certificates.crt", env["GIT_SSL_CAINFO"])
        assertEquals("/etc/ssl/certs/ca-certificates.crt", env["REQUESTS_CA_BUNDLE"])
        assertEquals("/etc/ssl/certs/ca-certificates.crt", env["PIP_CERT"])
        assertFalse(env.containsKey("NODE_EXTRA_CA_CERTS"))

        val envWithUserCa = PosixRuntimeConfig.buildProotEnvironment(
            paths = paths,
            includeNodeExtraCaCerts = true,
        )
        assertEquals(PosixRuntimeConfig.GUEST_ANDROID_USER_CA_BUNDLE, envWithUserCa["NODE_EXTRA_CA_CERTS"])
    }

    @Test
    fun shouldKeepInsideWebView_routesOtherLocalhostPortsToExternalBrowserAndAllowsVsCodeSubframes() {
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("file", "", -1, 18765))
        assertTrue(PosixRuntimeConfig.shouldKeepInsideWebView("http", "127.0.0.1", 18765, 18765))
        assertTrue(PosixRuntimeConfig.shouldKeepInsideWebView("http", "localhost", 18765, 18765))

        // Main-frame dev servers on other ports and external websites must open in sibling XR browser
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("http", "127.0.0.1", 3000, 18765))
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("http", "localhost", 5173, 18765))
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("https", "github.com", -1, 18765))

        // Loopback dev-server iframes stay inside WebView (except adminServerPort!)
        assertTrue(PosixRuntimeConfig.shouldKeepInsideWebView("http", "127.0.0.1", 3000, 18765, isForMainFrame = false, adminServerPort = 39049))
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("http", "127.0.0.1", 39049, 18765, isForMainFrame = false, adminServerPort = 39049))
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("http", "localhost", 39049, 18765, isForMainFrame = false, adminServerPort = 39049))

        // VS Code webview subframes (*.vscode-cdn.net, about:blank, blob:) stay inside iframe ONLY when !isForMainFrame
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("https", "abc123.vscode-cdn.net", -1, 18765, isForMainFrame = true))
        assertTrue(PosixRuntimeConfig.shouldKeepInsideWebView("https", "abc123.vscode-cdn.net", -1, 18765, isForMainFrame = false))
        assertTrue(PosixRuntimeConfig.shouldKeepInsideWebView("about", null, -1, 18765, isForMainFrame = false))
        assertFalse(PosixRuntimeConfig.shouldKeepInsideWebView("https", "github.com", -1, 18765, isForMainFrame = false))
    }

    @Test
    fun isSafeExternalBrowserUri_allowsHttpHttpsDevAndAuthUrlsWhileBlockingTokensFilesAndEditorPort() {
        assertTrue(PosixRuntimeConfig.isSafeExternalBrowserUri("https", "github.com", -1, "foo=1", 18765))
        assertTrue(PosixRuntimeConfig.isSafeExternalBrowserUri("http", "127.0.0.1", 3000, null, 18765))
        assertTrue(PosixRuntimeConfig.isSafeExternalBrowserUri("http", "localhost", 5173, null, 18765))

        assertFalse(PosixRuntimeConfig.isSafeExternalBrowserUri("file", "", -1, null, 18765))
        assertFalse(PosixRuntimeConfig.isSafeExternalBrowserUri("javascript", "", -1, null, 18765))
        assertFalse(PosixRuntimeConfig.isSafeExternalBrowserUri("http", "127.0.0.1", 18765, "folder=/workspace", 18765))
        assertFalse(PosixRuntimeConfig.isSafeExternalBrowserUri("https", "example.com", -1, "a=1&tkn=secret", 18765))
    }

    @Test
    fun buildMinimalVsCodeSettingsJson_setsOstHighContrastCursorZoomAndTerminalDom() {
        val json = JSONObject(PosixRuntimeConfig.buildMinimalVsCodeSettingsJson())
        assertEquals(false, json.getBoolean("editor.minimap.enabled"))
        assertEquals(false, json.getBoolean("breadcrumbs.enabled"))
        assertEquals(true, json.getBoolean("security.workspace.trust.enabled"))
        assertEquals(true, json.getBoolean("chat.disableAIFeatures"))
        assertEquals("off", json.getString("telemetry.telemetryLevel"))
        assertEquals("off", json.getString("files.autoSave"))
        assertEquals("off", json.getString("terminal.integrated.gpuAcceleration"))
        assertEquals("500", json.getString("editor.fontWeight"))
        assertEquals(3, json.getInt("editor.cursorWidth"))
        assertEquals("solid", json.getString("editor.cursorBlinking"))
        assertEquals(0.5, json.getDouble("window.zoomLevel"), 0.001)
        assertEquals("bash", json.getString("terminal.integrated.defaultProfile.linux"))

        val colors = json.getJSONObject("workbench.colorCustomizations")
        assertEquals("#000000", colors.getString("editor.background"))
        assertEquals("#000000", colors.getString("terminal.background"))
        assertEquals("#38bdf8", colors.getString("tab.activeBorderTop"))

        val skipShell = json.getJSONArray("terminal.integrated.commandsToSkipShell")
        val skipList = (0 until skipShell.length()).map { skipShell.getString(it) }
        assertTrue(skipList.contains("kucode.terminalCopy"))
        assertTrue(skipList.contains("kucode.terminalPaste"))
        assertEquals("copyPaste", json.getString("terminal.integrated.rightClickBehavior"))
    }

    @Test
    fun mergeDefaultVsCodeSettings_preservesUserOverridesAndAddsMissingDefaults() {
        val existing = """{"editor.fontSize": 20, "custom.flag": true}"""
        val mergedJson = PosixRuntimeConfig.mergeDefaultVsCodeSettings(existing)
        assertNotNull(mergedJson)
        val merged = JSONObject(mergedJson!!)
        assertEquals(20, merged.getInt("editor.fontSize"))
        assertEquals(true, merged.getBoolean("custom.flag"))
        assertEquals("off", merged.getString("terminal.integrated.gpuAcceleration"))
        assertEquals("500", merged.getString("editor.fontWeight"))
        assertEquals(3, merged.getInt("editor.cursorWidth"))
        assertEquals("copyPaste", merged.getString("terminal.integrated.rightClickBehavior"))
        assertTrue(merged.has("terminal.integrated.commandsToSkipShell"))
    }

    @Test
    fun mergeDefaultVsCodeSettings_returnsDefaultsWhenNullOrBlank() {
        val fromNull = PosixRuntimeConfig.mergeDefaultVsCodeSettings(null)
        val fromBlank = PosixRuntimeConfig.mergeDefaultVsCodeSettings("   \n\t ")
        assertNotNull(fromNull)
        assertEquals(fromNull, fromBlank)
        assertEquals(16, JSONObject(fromNull!!).getInt("editor.fontSize"))
    }

    @Test
    fun mergeDefaultVsCodeSettings_returnsNullOnJsoncOrMalformedInput() {
        assertNull(PosixRuntimeConfig.mergeDefaultVsCodeSettings("""{"editor.fontSize": 20,}"""))
        assertNull(PosixRuntimeConfig.mergeDefaultVsCodeSettings("""{"arr": [1, 2,]}"""))
        assertNull(PosixRuntimeConfig.mergeDefaultVsCodeSettings("// user comment\n{\"editor.fontSize\": 20}"))
        assertNull(PosixRuntimeConfig.mergeDefaultVsCodeSettings("""{"editor.fontSize": 20 /* inline */}"""))
        assertNull(PosixRuntimeConfig.mergeDefaultVsCodeSettings("{broken json"))
        assertNull(PosixRuntimeConfig.mergeDefaultVsCodeSettings("""{"editor.fontSize": 20} trailing"""))
    }

    @Test
    fun mergeDefaultVsCodeSettings_allowsCommentLikeSequencesInsideJsonStrings() {
        val existing = """{"custom.url": "https://example.com/a,}", "custom.escaped": "quote \" // ok"}"""
        val mergedJson = PosixRuntimeConfig.mergeDefaultVsCodeSettings(existing)
        assertNotNull(mergedJson)
        val merged = JSONObject(mergedJson!!)
        assertEquals("https://example.com/a,}", merged.getString("custom.url"))
        assertEquals("quote \" // ok", merged.getString("custom.escaped"))
        assertEquals(16, merged.getInt("editor.fontSize"))
    }

    @Test
    fun mergeDefaultVsCodeSettings_returnsOriginalStringWhenNoKeysMissing() {
        val complete = PosixRuntimeConfig.buildMinimalVsCodeSettingsObject()
            .put("custom.keep", "yes")
            .toString()
        assertEquals(complete, PosixRuntimeConfig.mergeDefaultVsCodeSettings(complete))
    }

    @Test
    fun buildResolvConf_prefersSystemDnsAndFiltersLoopback() {
        val dynamic = PosixRuntimeConfig.buildResolvConf(listOf("127.0.0.1", "100.100.100.100", "192.168.1.1%wlan0", "100.100.100.100"))
        assertEquals("nameserver 100.100.100.100\nnameserver 192.168.1.1\n", dynamic)

        val fallback = PosixRuntimeConfig.buildResolvConf(listOf("127.0.0.53", "::1"))
        assertEquals("nameserver 1.1.1.1\nnameserver 8.8.8.8\n", fallback)
    }

    @Test
    fun buildAptProotConf_configuresRootSandboxNoSeccompAndCaInfo() {
        val conf = PosixRuntimeConfig.buildAptProotConf()
        assertTrue(conf.contains("""APT::Sandbox::User "root";"""))
        assertTrue(conf.contains("""APT::Sandbox::Seccomp "false";"""))
        assertTrue(conf.contains("""Acquire::https::CaInfo "/etc/ssl/certs/ca-certificates.crt";"""))
    }

    @Test
    fun buildClipboardHelperScripts_providesCopyAndPasteCliScripts() {
        val scripts = PosixRuntimeConfig.buildClipboardHelperScripts()
        assertEquals(setOf("kucode-copy", "kucode-paste"), scripts.keys)
        val copy = scripts.getValue("kucode-copy")
        val paste = scripts.getValue("kucode-paste")
        assertTrue(copy.startsWith("#!/opt/openvscode-server/node\n"))
        assertTrue(paste.startsWith("#!/opt/openvscode-server/node\n"))
        assertTrue(copy.contains("path: '/copy'"))
        assertTrue(paste.contains("path: '/clipboard'"))
    }

    @Test
    fun buildFakeSysdataFiles_providesRequiredProcEntries() {
        val files = PosixRuntimeConfig.buildFakeSysdataFiles(cpuCount = 4)
        assertTrue(files.containsKey("stat"))
        assertTrue(files.containsKey("loadavg"))
        assertTrue(files.containsKey("uptime"))
        assertTrue(files.containsKey("version"))
        assertTrue(files.containsKey("vmstat"))
        assertTrue(files.getValue("stat").contains("cpu3 "))
        assertFalse(files.getValue("stat").contains("cpu4 "))
    }

    @Test
    fun buildHostCliHelperScriptsAndProfiles_includeAgyAndCopilotInstallersAndLocalBinPath() {
        val scripts = PosixRuntimeConfig.buildHostCliHelperScripts()
        assertTrue(scripts.containsKey("kucode-install-agy"))
        val agyInstaller = scripts.getValue("kucode-install-agy")
        assertTrue(agyInstaller.startsWith("#!/usr/bin/env bash\n"))
        assertTrue(agyInstaller.contains("https://antigravity.google/cli/install.sh"))
        assertFalse(agyInstaller.contains("--skip-path"))
        assertFalse(agyInstaller.contains("--skip-aliases"))
        assertTrue(agyInstaller.contains("mktemp -d"))
        assertTrue(agyInstaller.contains("trap "))
        assertTrue(agyInstaller.contains("HOME=\"\$STAGE_DIR/home\" bash -s -- -d \"\$STAGE_DIR/bin\""))
        assertTrue(agyInstaller.contains("command -v curl"))
        assertTrue(agyInstaller.contains("command -v git"))
        assertTrue(agyInstaller.contains("command -v tar"))
        assertTrue(agyInstaller.contains("command -v gzip"))
        assertTrue(agyInstaller.contains("command -v sha512sum"))
        assertTrue(agyInstaller.contains("agy acp --help"))
        assertTrue(agyInstaller.contains("ld-linux-aarch64.so.1"))
        assertTrue(agyInstaller.contains("SIGSYS"))

        assertTrue(scripts.containsKey("kucode-install-copilot"))
        val copilotInstaller = scripts.getValue("kucode-install-copilot")
        assertTrue(copilotInstaller.startsWith("#!/usr/bin/env bash\n"))
        assertTrue(copilotInstaller.contains(".local/bin"))
        assertTrue(copilotInstaller.contains("ld-linux-aarch64.so.1"))

        for ((name, content) in listOf("kucode-install-agy" to agyInstaller, "kucode-install-copilot" to copilotInstaller)) {
            val proc = ProcessBuilder("bash", "-n").redirectErrorStream(true).start()
            proc.outputStream.use { it.write(content.toByteArray(Charsets.UTF_8)) }
            val out = proc.inputStream.bufferedReader().readText()
            assertEquals("$name failed bash -n: $out", 0, proc.waitFor())
        }

        val profileD = PosixRuntimeConfig.buildProfileDEnvScript()
        assertTrue(profileD.contains(".local/bin"))
        val profile = PosixRuntimeConfig.buildDefaultProfile()
        assertTrue(profile.contains(".local/bin"))
    }
}

