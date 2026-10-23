import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.kapt") }

/**
 * 把与桌面端一致、且被 git 跟踪的模型文件复制进独立桌宠的 assets。
 *
 * 这样做而不是在仓库里再存一份 5.4MB 的 GLB：单一事实来源仍是 apps/web/public/models/lumi/，
 * 运行期再用固定 SHA-256 复核一次（见 Pet3dAssets.PINNED_MODEL_SHA256）。
 */
abstract class SyncPet3dModelAssets @Inject constructor(private val fileSystem: FileSystemOperations) : DefaultTask() {
    @get:InputDirectory
    abstract val sourceDirectory: DirectoryProperty

    @get:Input
    abstract val includedFiles: ListProperty<String>

    /** full（默认）/ missing / corrupt：后两者只用于真机回退验收，见 docs/implementation/android-3d-pet.md。 */
    @get:Input
    abstract val variant: Property<String>

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun syncModelAssets() {
        val source = sourceDirectory.get().asFile
        require(source.isDirectory) { "缺少与桌面端一致的模型目录：" + source }
        val target = outputDirectory.get().asFile
        when (variant.get()) {
            "missing" -> fileSystem.delete { delete(target) }
            else -> {
                fileSystem.sync {
                    from(source) { include(includedFiles.get()) }
                    into(target)
                }
                if (variant.get() == "corrupt") {
                    val model = target.resolve("Lumi_Magical_Kitten.glb")
                    val bytes = model.readBytes()
                    model.writeBytes(bytes.copyOf(bytes.size / 2))
                }
            }
        }
    }
}

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
    // 实时 3D 页面与内嵌 three 运行时（见 assets/pet3d/README.md）。
    sourceSets["main"].assets.srcDir(rootProject.file("app/src/standalone/assets"))
    // 构建期从被跟踪的桌面模型复制进来的随包 GLB（见下面的 syncPet3dModelAssets）。
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/pet3dAssets"))
}

val pet3dModelVariant = (findProperty("pet3dModelVariant") as String?) ?: "full"
require(pet3dModelVariant in setOf("full", "missing", "corrupt")) { "pet3dModelVariant 只能是 full/missing/corrupt" }
if (pet3dModelVariant != "full") {
    logger.lifecycle("pet3dModelVariant=" + pet3dModelVariant + "：本次构建用于真机回退验收，随包 3D 模型被有意裁剪/损坏，不要安装到日常使用。")
}

val pet3dModelAssets = tasks.register<SyncPet3dModelAssets>("syncPet3dModelAssets") {
    description = "把与桌面端一致的 Lumi GLB 复制进独立桌宠 assets/pet3d/models/lumi（离线，无网络）"
    sourceDirectory.set(rootProject.file("../../apps/web/public/models/lumi"))
    includedFiles.set(listOf("Lumi_Magical_Kitten.glb", "character_manifest.json"))
    variant.set(pet3dModelVariant)
    outputDirectory.set(layout.buildDirectory.dir("generated/pet3dAssets/pet3d/models/lumi"))
}

// 复制必须发生在资源合并之前；显式接线，不依赖 AGP 版本对 generated source 的支持差异。
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(pet3dModelAssets) }
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(pet3dModelAssets) }
tasks.matching { it.name.startsWith("generate") && it.name.endsWith("Assets") }.configureEach { dependsOn(pet3dModelAssets) }

dependencies {
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    implementation("com.google.mlkit:face-detection:16.1.7")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.room:room-runtime:2.8.5")
    kapt("androidx.room:room-compiler:2.8.5")
}

kapt { correctErrorTypes = true }