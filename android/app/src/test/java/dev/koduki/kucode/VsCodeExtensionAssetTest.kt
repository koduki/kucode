package dev.koduki.kucode

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class VsCodeExtensionAssetTest {

    @Test
    fun failedExtensionUpdatePreservesCompletePreviousVersion() {
        val dir = Files.createTempDirectory("kucode-ext-rollback").toFile()
        try {
            val target = VsCodeExtensionAsset.installInto(dir)
            val old = target.resolve("extension.js").readBytes()
            try {
                VsCodeExtensionAsset.installInto(dir) { name ->
                    if (name.endsWith("acp-client.js")) throw java.io.IOException("simulated failed asset read")
                    java.io.ByteArrayInputStream("new".toByteArray())
                }
                throw AssertionError("expected asset failure")
            } catch (_: java.io.IOException) {}
            assertTrue(old.contentEquals(target.resolve("extension.js").readBytes()))
            assertTrue(target.resolve("acp-client.js").isFile)
        } finally {
            deleteTreeNoFollow(dir)
        }
    }

    @Test
    fun installInto_copiesBundledExtensionAssetsAtomically() {
        val dir = Files.createTempDirectory("kucode-ext-test").toFile()
        try {
            val extDir = VsCodeExtensionAsset.installInto(dir)
            assertTrue(extDir.resolve("icon.svg").isFile)
            assertTrue(extDir.resolve("acp-client.js").isFile)
            assertTrue(extDir.resolve("acp-webview.js").isFile)
            val pkgJson = JSONObject(extDir.resolve("package.json").readText())
            assertEquals("kucode-tools", pkgJson.getString("name"))
            assertEquals("0.10.1", pkgJson.getString("version"))
            assertEquals("./extension.js", pkgJson.getString("main"))

            val contributes = pkgJson.getJSONObject("contributes")
            val commands = contributes.getJSONArray("commands")
            val commandIds = (0 until commands.length()).map { commands.getJSONObject(it).getString("command") }
            assertTrue(commandIds.contains("kucode.openAcpChat"))
            assertTrue(commandIds.contains("kucode.sendSelectionToAcp"))
            assertTrue(commandIds.contains("kucode.setupAntigravityCli"))
            assertTrue(commandIds.contains("kucode.setupCopilotCli"))
            assertTrue(commandIds.contains("kucode.openMenu"))
            assertTrue(commandIds.contains("kucode.runDiagnostics"))
            assertTrue(commandIds.contains("kucode.openLogs"))
            assertTrue(commandIds.contains("kucode.toggleTerminal"))
            assertTrue(commandIds.contains("kucode.selectDisplayScale"))
            assertTrue(commandIds.contains("kucode.selectOpticalTheme"))
            assertTrue(commandIds.contains("kucode.openManager"))
            assertTrue(commandIds.contains("kucode.requestStorage"))

            val menus = contributes.getJSONObject("menus")
            assertTrue(menus.has("editor/context"))
            assertTrue(menus.has("explorer/context"))
            assertTrue(contributes.getJSONObject("viewsContainers").has("activitybar"))
            assertTrue(contributes.getJSONObject("views").has("kucode"))

            val capabilities = pkgJson.getJSONObject("capabilities")
            assertEquals("limited", capabilities.getJSONObject("untrustedWorkspaces").getString("supported"))
            val acpProps = contributes.getJSONObject("configuration").getJSONObject("properties")
            assertEquals("application", acpProps.getJSONObject("kucode.acp.agents").getString("scope"))
            assertEquals("application", acpProps.getJSONObject("kucode.acp.permissionMode").getString("scope"))
            assertEquals("application", acpProps.getJSONObject("kucode.acp.defaultAgent").getString("scope"))

            val js = extDir.resolve("extension.js").readText()
            assertTrue(js.contains("KUCODE_ADMIN_PORT"))
            assertTrue(js.contains("KUCODE_ADMIN_TOKEN"))
            assertTrue(js.contains("registerTreeDataProvider"))
            assertTrue(js.contains("registerWebviewViewProvider"))
            assertTrue(js.contains("StatusBarAlignment.Left"))
            assertTrue(js.contains("OST_COLORS"))
            assertTrue(js.contains("VST_COLORS"))
            assertTrue(extDir.listFiles()!!.none { it.name.startsWith(".pending-") })
        } finally {
            deleteTreeNoFollow(dir)
        }
    }

    @Test
    fun installAndroidInto_installsStandaloneExtensionAndPreservesOnFailure() {
        val dir = Files.createTempDirectory("kucode-android-ext-test").toFile()
        val assetRoot = java.io.File("src/main/assets")
        try {
            val extDir = VsCodeExtensionAsset.installAndroidInto(dir) { assetPath ->
                java.io.File(assetRoot, assetPath).inputStream()
            }
            assertEquals("kucode-android", extDir.name)
            assertTrue(extDir.resolve("package.json").isFile)
            assertTrue(extDir.resolve("extension.js").isFile)
            val pkgJson = JSONObject(extDir.resolve("package.json").readText())
            assertEquals("kucode-android", pkgJson.getString("name"))
            assertEquals(false, pkgJson.getJSONObject("capabilities").getJSONObject("untrustedWorkspaces").getBoolean("supported"))
            assertTrue(pkgJson.getJSONObject("contributes").has("taskDefinitions"))

            val original = extDir.resolve("extension.js").readBytes()
            try {
                VsCodeExtensionAsset.installAndroidInto(dir) { name ->
                    if (name.endsWith("extension.js")) throw java.io.IOException("simulated read failure")
                    java.io.ByteArrayInputStream("partial".toByteArray())
                }
                throw AssertionError("expected failure")
            } catch (_: java.io.IOException) {}
            assertTrue(original.contentEquals(extDir.resolve("extension.js").readBytes()))
        } finally {
            deleteTreeNoFollow(dir)
        }
    }
}
