plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildSha = providers.environmentVariable("KUCODE_BUILD_SHA")
    .orElse(providers.environmentVariable("GITHUB_SHA"))
    .orElse(providers.exec {
        workingDir(rootProject.projectDir.parentFile)
        commandLine("git", "rev-parse", "HEAD")
        isIgnoreExitValue = true
    }.standardOutput.asText.map { it.trim().ifEmpty { "unknown" } })

android {
    namespace = "dev.koduki.kucode"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.koduki.kucode"
        minSdk = 34
        targetSdk = 35
        versionCode = 12
        versionName = "0.10.1"
        resValue("string", "kucode_build_sha", buildSha.get())

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
        if (!ksPath.isNullOrBlank()) {
            val ksFile = file(ksPath)
            if (!ksFile.exists()) {
                throw org.gradle.api.GradleException("ANDROID_KEYSTORE_PATH was set but file does not exist: $ksPath")
            }
            create("release") {
                storeFile = ksFile
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: ""
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        release {
            resValue("string", "app_name_variant", "KuCode")
            isMinifyEnabled = true
            isShrinkResources = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            applicationIdSuffix = ".debug"
            resValue("string", "app_name_variant", "KuCode Dev")
            versionNameSuffix = "-debug"
        }
    }

    androidResources {
        // Keep embedded Debian rootfs & openvscode-server .tgz uncompressed inside the APK
        // (using .tgz avoids AGP's legacy auto-gunzip behavior on .gz assets)
        noCompress += listOf("tgz", "tar", "xz")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        jniLibs {
            // Required so libproot.so & libproot-loader.so extract to nativeLibraryDir with +x
            useLegacyPackaging = true
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/licenseAssets"))
        }
    }
}

val repoRootDir = rootProject.projectDir.parentFile
val runtimeLock = providers.environmentVariable("KUCODE_RUNTIME_LOCK")
    .orElse(providers.gradleProperty("kucodeRuntimeLock"))
    .orElse(File(repoRootDir, "runtime-assets.lock.json").absolutePath)
val verifyRuntimeAssets by tasks.registering(Exec::class) {
    group = "verification"
    description = "Verify reviewed runtime asset lock before packaging."
    workingDir(repoRootDir)
    commandLine("python3", "scripts/runtime-assets.py", "verify", "--lock", runtimeLock.get())
}
val generatedLicenseAssetsDir = layout.buildDirectory.dir("generated/licenseAssets")

val syncLicenseAssets by tasks.registering(Sync::class) {
    from(repoRootDir) {
        include("LICENSE", "THIRD_PARTY_NOTICES.md")
    }
    from(File(repoRootDir, "LICENSES")) {
        include("*.txt")
    }
    from(file("src/main/assets/runtime")) {
        include("debian-manifest.txt")
    }
    into(generatedLicenseAssetsDir.map { it.dir("licenses") })
}

tasks.named("preBuild") {
    dependsOn(syncLicenseAssets)
}

tasks.configureEach {
    if (name.startsWith("merge") && name.endsWith("Assets")) {
        dependsOn(syncLicenseAssets)
        dependsOn(verifyRuntimeAssets)
    }
    if (name.startsWith("merge") && name.endsWith("NativeLibs")) {
        dependsOn(verifyRuntimeAssets)
    }
}

tasks.withType<Test>().configureEach {
    if (name == "testDebugUnitTest" || name == "testReleaseUnitTest") {
        useJUnit {
            excludeCategories("dev.koduki.kucode.MediumTest")
        }
    }
}

val testDebugMediumUnitTest by tasks.registering(Test::class) {
    description = "Runs medium unit tests (subprocesses, loopback sockets, bundled archives) for the debug build."
    group = "verification"
    val debugUnitTest = tasks.named<Test>("testDebugUnitTest")
    dependsOn(debugUnitTest.map { it.taskDependencies })
    testClassesDirs = files(debugUnitTest.map { it.testClassesDirs })
    classpath = files(debugUnitTest.map { it.classpath })
    useJUnit {
        includeCategories("dev.koduki.kucode.MediumTest")
    }
    shouldRunAfter(debugUnitTest)
}

tasks.named("check") {
    dependsOn(testDebugMediumUnitTest)
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.apache.commons:commons-compress:1.27.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
