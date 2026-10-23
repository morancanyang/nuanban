plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.kapt") }

android {
    namespace = "org.nuanban.assistant"
    compileSdk = 36
    defaultConfig {
        applicationId = "org.nuanban.assistant.standalone"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-standalone-validation"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].java.srcDirs(
        rootProject.file("app/src/main/java"),
        rootProject.file("app/src/standalone/java"),
        rootProject.file("../../packages/contracts/kotlin/src/main/kotlin"),
    )
    sourceSets["main"].res.srcDir(rootProject.file("app/src/main/res"))
    sourceSets["main"].res.srcDir(rootProject.file("app/src/standalone/res"))
    sourceSets["main"].assets.srcDir(rootProject.file("app/src/main/assets"))
}

dependencies {
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    implementation("com.google.mlkit:face-detection:16.1.7")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.room:room-runtime:2.8.5")
    kapt("androidx.room:room-compiler:2.8.5")
}

kapt { correctErrorTypes = true }
