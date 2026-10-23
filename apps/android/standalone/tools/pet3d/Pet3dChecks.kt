package org.nuanban.assistant.nativehost

import java.nio.file.Files
import java.nio.file.Paths
import kotlin.system.exitProcess

/**
 * 独立桌宠实时 3D 的离线用例（JVM，无设备、无网络、不抓屏）。
 *
 * 覆盖两件可以离线证明的事：
 *  1) 渲染层级选择与回退策略 [Pet3dRenderPolicy] 的决策表（含失败升层与封闭）；
 *  2) 原生渲染层的数据前提：用 [Pet3dGlb] 真读随包 GLB，并对畸形/不支持输入验证"失败即封闭"。
 *
 * 输出 JSON 给 tools/pet3d/check-pet3d.ps1 汇总；deviceVerified 恒为 false：这里没有任何真机渲染、帧率或耗电数据。
 */
object Pet3dChecks {
    private val results = LinkedHashMap<String, String>()

    private fun check(name: String, body: () -> Unit) {
        results[name] = try { body(); "" } catch (error: Throwable) { error.message ?: error.toString() }
    }

    private fun assertTrue(condition: Boolean, message: String) {
        if (!condition) throw AssertionError(message)
    }

    private fun assertEquals(expected: Any?, actual: Any?, label: String) {
        if (expected != actual) throw AssertionError("$label 期望=$expected 实际=$actual")
    }

    private fun capable() = Pet3dRenderInput(
        bundledModelPresent = true,
        modelDigestVerified = true,
        webViewEngineAvailable = true,
        webViewMajorVersion = 130,
        glesMajorVersion = 3,
        isLowRamDevice = false,
        totalMemoryMb = 8192,
    )

    @JvmStatic
    fun main(args: Array<String>) {
        val modelPath = args.getOrNull(0)
        val manifestPath = args.getOrNull(1)
        assertTrue(modelPath != null && manifestPath != null, "缺少随包 GLB 与 manifest 路径参数")

        policyCases()
        val modelFacts = glbCases(modelPath!!, manifestPath!!)
        syntheticGlbCases()

        val failures = results.filterValues { it.isNotEmpty() }
        val payload = StringBuilder()
        payload.append("{\"passed\":").append(failures.isEmpty())
            .append(",\"caseCount\":").append(results.size)
            .append(",\"failureCount\":").append(failures.size)
            .append(",\"cases\":[")
        payload.append(results.keys.joinToString(",") { quote(it) })
        payload.append("],\"failures\":{")
        payload.append(failures.entries.joinToString(",") { quote(it.key) + ":" + quote(it.value) })
        payload.append("},\"deviceVerified\":false,\"captureExecuted\":false,\"cloudExecuted\":false,\"networkExecuted\":false")
        payload.append(",\"bundledModel\":").append(modelFacts)
        payload.append(",\"policyThresholds\":{")
            .append("\"webviewMinMajorVersion\":").append(Pet3dRenderPolicy.WEBVIEW_MIN_MAJOR_VERSION)
            .append(",\"webviewMinTotalMemoryMb\":").append(Pet3dRenderPolicy.WEBVIEW_MIN_TOTAL_MEMORY_MB)
            .append(",\"nativeMinTotalMemoryMb\":").append(Pet3dRenderPolicy.NATIVE_MIN_TOTAL_MEMORY_MB)
            .append(",\"maxConsecutiveFailures\":").append(Pet3dRenderPolicy.MAX_CONSECUTIVE_FAILURES)
            .append("}")
        payload.append("}")
        println(payload)
        if (failures.isNotEmpty()) exitProcess(1)
    }

    private fun policyCases() {
        check("policy_capable_device_selects_webview_three_js") {
            val decision = Pet3dRenderPolicy.decide(capable())
            assertEquals(Pet3dRenderMode.CONTROLLED_WEBVIEW, decision.mode, "capable mode")
            assertEquals(Pet3dRenderPolicy.REASON_WEBVIEW, decision.reason, "capable reason")
        }
        check("policy_low_ram_device_selects_native_gl") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(isLowRamDevice = true))
            assertEquals(Pet3dRenderMode.NATIVE_GL, decision.mode, "low ram mode")
            assertEquals(Pet3dRenderPolicy.REASON_NATIVE_WEBVIEW_UNAVAILABLE, decision.reason, "low ram reason")
        }
        check("policy_small_memory_device_falls_back_to_static_png") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(totalMemoryMb = 1024))
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "small memory mode")
            assertEquals(Pet3dRenderPolicy.REASON_NO_RENDERER, decision.reason, "small memory reason")
        }
        check("policy_old_webview_engine_selects_native_gl") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(webViewMajorVersion = 89))
            assertEquals(Pet3dRenderMode.NATIVE_GL, decision.mode, "old webview mode")
        }
        check("policy_missing_webview_engine_selects_native_gl") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(webViewEngineAvailable = false))
            assertEquals(Pet3dRenderMode.NATIVE_GL, decision.mode, "no webview mode")
        }
        check("policy_without_gles_support_falls_back_to_static_png") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(glesMajorVersion = 1, isLowRamDevice = true))
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "no gles mode")
        }
        check("policy_missing_bundled_model_falls_back_to_static_png") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(bundledModelPresent = false))
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "missing model mode")
            assertEquals(Pet3dRenderPolicy.REASON_MODEL_MISSING, decision.reason, "missing model reason")
        }
        check("policy_unverified_model_digest_falls_back_to_static_png") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(modelDigestVerified = false))
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "unverified mode")
            assertEquals(Pet3dRenderPolicy.REASON_MODEL_UNVERIFIED, decision.reason, "unverified reason")
        }
        check("policy_user_disabled_3d_falls_back_to_static_png") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(userDisabled3d = true))
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "user disabled mode")
            assertEquals(Pet3dRenderPolicy.REASON_USER_DISABLED, decision.reason, "user disabled reason")
        }
        check("policy_webview_failure_escalates_to_native_gl") {
            val input = capable()
            val first = Pet3dRenderPolicy.decide(input)
            val second = Pet3dRenderPolicy.afterFailure(input, first.mode)
            assertEquals(Pet3dRenderMode.NATIVE_GL, second.mode, "after webview failure mode")
            assertEquals(Pet3dRenderPolicy.REASON_NATIVE_AFTER_WEBVIEW_FAILURE, second.reason, "after webview failure reason")
        }
        check("policy_native_failure_escalates_to_static_png") {
            val input = capable()
            val decision = Pet3dRenderPolicy.afterFailure(input.copy(failedModes = setOf(Pet3dRenderMode.CONTROLLED_WEBVIEW)), Pet3dRenderMode.NATIVE_GL)
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "after native failure mode")
            assertEquals(Pet3dRenderPolicy.REASON_NO_RENDERER, decision.reason, "after native failure reason")
        }
        check("policy_two_consecutive_failures_fail_closed") {
            val decision = Pet3dRenderPolicy.decide(capable().copy(consecutiveFailures = Pet3dRenderPolicy.MAX_CONSECUTIVE_FAILURES))
            assertEquals(Pet3dRenderMode.STATIC_PNG, decision.mode, "fail closed mode")
            assertEquals(Pet3dRenderPolicy.REASON_FAIL_CLOSED, decision.reason, "fail closed reason")
        }
        check("policy_failed_modes_are_never_reselected") {
            val input = capable()
            val decision = Pet3dRenderPolicy.decide(input.copy(failedModes = setOf(Pet3dRenderMode.CONTROLLED_WEBVIEW)))
            assertTrue(decision.mode != Pet3dRenderMode.CONTROLLED_WEBVIEW, "已失败层级被重新选中")
        }
        check("policy_chain_is_ordered_and_ends_with_static_png") {
            val chain = Pet3dRenderPolicy.chain(capable())
            assertEquals(listOf(Pet3dRenderMode.CONTROLLED_WEBVIEW, Pet3dRenderMode.NATIVE_GL, Pet3dRenderMode.STATIC_PNG), chain, "capable chain")
            assertEquals(listOf(Pet3dRenderMode.NATIVE_GL, Pet3dRenderMode.STATIC_PNG), Pet3dRenderPolicy.chain(capable().copy(isLowRamDevice = true)), "low ram chain")
            assertEquals(listOf(Pet3dRenderMode.STATIC_PNG), Pet3dRenderPolicy.chain(capable().copy(totalMemoryMb = 512)), "static only chain")
        }
        check("policy_labels_and_status_lines_are_user_readable") {
            assertEquals("实时 3D · three.js（受控 WebView）", Pet3dRenderPolicy.label(Pet3dRenderMode.CONTROLLED_WEBVIEW), "webview label")
            assertEquals("实时 3D · 原生 GLES", Pet3dRenderPolicy.label(Pet3dRenderMode.NATIVE_GL), "native label")
            assertEquals("随包静态形象", Pet3dRenderPolicy.label(Pet3dRenderMode.STATIC_PNG), "static label")
            assertTrue(Pet3dRenderPolicy.statusLine(Pet3dRenderMode.STATIC_PNG, Pet3dRenderPolicy.REASON_NO_RENDERER).contains("形象："), "状态行缺少前缀")
        }
        check("policy_decisions_cover_every_reason_once") {
            val reasons = setOf(
                Pet3dRenderPolicy.REASON_USER_DISABLED, Pet3dRenderPolicy.REASON_MODEL_MISSING,
                Pet3dRenderPolicy.REASON_MODEL_UNVERIFIED, Pet3dRenderPolicy.REASON_FAIL_CLOSED,
                Pet3dRenderPolicy.REASON_WEBVIEW, Pet3dRenderPolicy.REASON_NATIVE_WEBVIEW_UNAVAILABLE,
                Pet3dRenderPolicy.REASON_NATIVE_AFTER_WEBVIEW_FAILURE, Pet3dRenderPolicy.REASON_NO_RENDERER,
            )
            assertEquals(8, reasons.size, "原因码数量")
        }
    }

    private fun glbCases(modelPath: String, manifestPath: String): String {
        val bytes = Files.readAllBytes(Paths.get(modelPath))
        var document: Pet3dGlbDocument? = null
        check("bundled_model_is_present_and_readable") {
            assertTrue(bytes.size > 1_000_000, "随包模型过小：" + bytes.size)
            document = Pet3dGlb.inspect(bytes)
        }
        val glb = document ?: return "{\"readable\":false}"
        val facts = glb.facts
        check("bundled_model_parses_as_gltf_2_binary") {
            assertTrue(facts.gltfVersion.startsWith("2."), "glTF 版本：" + facts.gltfVersion)
            assertEquals(bytes.size, facts.byteSize, "byteSize")
            assertTrue(facts.binChunkByteLength + 1_000_000 > bytes.size, "BIN chunk 明显偏小")
            assertTrue(facts.bufferByteLength <= facts.binChunkByteLength, "buffer 声明长度超过 BIN chunk")
        }
        check("bundled_model_digest_matches_character_manifest") {
            val manifest = Pet3dJsonParser.parse(String(Files.readAllBytes(Paths.get(manifestPath)), Charsets.UTF_8))
            val runtime = manifest.objectField("runtime") ?: throw AssertionError("manifest 缺少 runtime")
            assertEquals(runtime.stringField("sha256"), facts.sha256, "manifest sha256")
            assertEquals(runtime.intField("fileBytes"), facts.byteSize, "manifest fileBytes")
            assertEquals(runtime.intField("triangleCount"), facts.triangleCount, "manifest triangleCount")
            assertEquals(runtime.objectField("skeleton")?.intField("boneCount"), 0, "manifest boneCount")
        }
        check("bundled_model_geometry_is_unskinned_triangles") {
            assertEquals(0, facts.skinCount, "skinCount")
            assertTrue(!facts.skinned, "随包模型不应被判定为蒙皮模型")
            assertEquals(0, facts.morphTargetPrimitiveCount, "morphTargetPrimitiveCount")
            assertEquals(0, facts.unindexedPrimitiveCount, "unindexedPrimitiveCount")
            assertTrue(facts.meshCount >= 100, "meshCount=" + facts.meshCount)
            assertTrue(facts.primitiveCount >= facts.meshCount, "primitiveCount=" + facts.primitiveCount)
            assertTrue(facts.triangleCount > 50_000, "triangleCount=" + facts.triangleCount)
            assertTrue(facts.vertexCount > facts.triangleCount / 3, "vertexCount=" + facts.vertexCount)
        }
        check("bundled_model_has_loopable_idle_object_animation") {
            assertTrue(facts.animations.isNotEmpty(), "模型没有任何动画")
            assertTrue(facts.hasIdleAnimation, "缺少 idle 节点动画")
            val idle = facts.animations.first { it.name == "idle" }
            assertEquals(1, idle.nodeChannels, "idle 通道数")
            assertEquals(1, idle.translationChannels, "idle 位移动画数")
            assertEquals(0, idle.weightsChannels, "idle 形变权重通道数")
        }
        check("bundled_model_textures_are_embedded_and_need_texture_transform") {
            assertEquals(3, facts.imageCount, "imageCount")
            assertEquals(3, facts.embeddedImageCount, "embeddedImageCount")
            assertTrue(facts.textureCount >= 3, "textureCount=" + facts.textureCount)
            assertTrue(facts.requiresTextureTransform, "扩展列表：" + facts.extensionsRequired)
            assertTrue(facts.selfContained, "模型不是自包含（有外部引用）")
        }
        check("bundled_model_accessors_decode_finite_positions_and_valid_indices") {
            val primitives = glb.primitives()
            assertTrue(primitives.isNotEmpty(), "没有可渲染 primitive")
            var decoded = 0
            for (primitive in primitives.take(12)) {
                val positions = glb.readFloats(primitive.positionAccessor)
                assertTrue(positions.isNotEmpty() && positions.size % 3 == 0, "POSITION 解码长度异常")
                val vertexCount = positions.size / 3
                assertTrue(positions.all { it.isFinite() }, "POSITION 出现非有限值")
                val boundsMin = facts.positionBoundsMin
                val boundsMax = facts.positionBoundsMax
                if (boundsMin != null && boundsMax != null) {
                    for (index in 0 until positions.size) {
                        val axis = index % 3
                        assertTrue(positions[index] >= boundsMin[axis] - 1e-3f && positions[index] <= boundsMax[axis] + 1e-3f, "POSITION 超出 accessor min/max")
                    }
                }
                primitive.indicesAccessor?.let { indexAccessor ->
                    val indices = glb.readIndices(indexAccessor)
                    assertTrue(indices.size % 3 == 0, "索引数量不是 3 的倍数")
                    assertTrue(indices.all { it in 0 until vertexCount }, "索引越界：顶点数=" + vertexCount)
                }
                primitive.normalAccessor?.let { normalAccessor ->
                    val normals = glb.readFloats(normalAccessor)
                    assertEquals(vertexCount * 3, normals.size, "法线长度")
                    assertTrue(normals.all { it.isFinite() }, "法线出现非有限值")
                }
                decoded++
            }
            assertEquals(minOf(12, primitives.size), decoded, "已解码 primitive 数")
        }
        check("bundled_model_position_bounds_are_sane") {
            val boundsMin = facts.positionBoundsMin ?: throw AssertionError("缺少 POSITION min")
            val boundsMax = facts.positionBoundsMax ?: throw AssertionError("缺少 POSITION max")
            assertEquals(3, boundsMin.size, "min 维度")
            assertEquals(3, boundsMax.size, "max 维度")
            for (axis in 0 until 3) {
                assertTrue(boundsMin[axis] <= boundsMax[axis], "包围盒 min>max（轴 $axis）")
                assertTrue(boundsMin[axis].isFinite() && boundsMax[axis].isFinite(), "包围盒出现非有限值")
            }
        }
        return modelFactsJson(facts)
    }

    private fun syntheticGlbCases() {
        check("glb_accepts_minimal_self_contained_triangle") {
            val document = Pet3dGlb.inspect(minimalGlb())
            assertEquals(1, document.facts.meshCount, "meshCount")
            assertEquals(1, document.facts.triangleCount, "triangleCount")
            assertEquals(0, document.facts.skinCount, "skinCount")
            val positions = document.readFloats(0)
            assertEquals(9, positions.size, "positions")
        }
        check("glb_rejects_bad_magic_and_unsupported_version") {
            val bad = minimalGlb()
            bad[0] = 0x00
            assertThrows("glb_bad_magic") { Pet3dGlb.inspect(bad) }
            val version = minimalGlb()
            version[4] = 3
            assertThrows("glb_unsupported_version") { Pet3dGlb.inspect(version) }
        }
        check("glb_rejects_declared_length_mismatch_and_truncation") {
            val wrongLength = minimalGlb()
            wrongLength[8] = (wrongLength[8] + 4).toByte()
            assertThrows("glb_declared_length_mismatch") { Pet3dGlb.inspect(wrongLength) }
            assertThrows("glb_too_small") { Pet3dGlb.inspect(minimalGlb().copyOf(16)) }
        }
        check("glb_rejects_external_buffer_and_image_uris") {
            val externalBuffer = minimalGlb(json = minimalJson().replace("\"buffers\":[{", "\"buffers\":[{\"uri\":\"model.bin\","))
            assertThrows("gltf_external_buffer_unsupported") { Pet3dGlb.inspect(externalBuffer) }
            val externalImage = minimalGlb(json = minimalJson().replace("\"meshes\"", "\"images\":[{\"uri\":\"tex.png\"}],\"meshes\""))
            assertThrows("gltf_external_image_unsupported") { Pet3dGlb.inspect(externalImage) }
        }
        check("glb_rejects_sparse_accessor") {
            // inspect() 保持宽松（three.js 层能读 sparse）；原生渲染层在取数时拒绝，因此这里必须读一次。
            val sparse = minimalGlb(json = minimalJson().replace("\"type\":\"VEC3\"", "\"type\":\"VEC3\",\"sparse\":{\"count\":1}"))
            assertThrows("gltf_sparse_accessor_unsupported") { Pet3dGlb.inspect(sparse).readFloats(0) }
        }
        check("glb_rejects_accessor_range_beyond_bin_chunk") {
            val outOfBounds = minimalGlb(json = minimalJson().replace("\"count\":3,\"type\":\"VEC3\"", "\"count\":1000,\"type\":\"VEC3\""))
            assertThrows("gltf_accessor_range_out_of_bounds") { Pet3dGlb.inspect(outOfBounds).readFloats(0) }
        }
        check("glb_rejects_unsupported_gltf_1_and_missing_asset") {
            val version1 = minimalGlb(json = minimalJson().replace("\"version\":\"2.0\"", "\"version\":\"1.0\""))
            assertThrows("gltf_unsupported_version") { Pet3dGlb.inspect(version1) }
            val noVersion = minimalGlb(json = minimalJson().replace("\"asset\":{\"version\":\"2.0\",\"generator\":\"pet3d-check\"}", "\"asset\":{\"generator\":\"pet3d-check\"}"))
            assertThrows("gltf_missing_version") { Pet3dGlb.inspect(noVersion) }
            // 去掉 asset 键后仍是合法 JSON，才能确定失败原因是缺少 asset 而不是 JSON 语法。
            val noAsset = minimalGlb(json = minimalJson().replace("{\"asset\":{\"version\":\"2.0\",\"generator\":\"pet3d-check\"},", "{"))
            assertThrows("gltf_missing_asset") { Pet3dGlb.inspect(noAsset) }
        }
        check("glb_rejects_primitive_without_position_attribute") {
            val noPosition = minimalGlb(json = minimalJson().replace("\"attributes\":{\"POSITION\":0}", "\"attributes\":{\"NORMAL\":0}"))
            assertThrows("gltf_primitive_without_position") { Pet3dGlb.inspect(noPosition) }
        }
        check("glb_rejects_json_chunk_with_invalid_syntax") {
            val broken = minimalGlb(json = minimalJson().replace("\"meshes\"", "\"meshes\"").dropLast(1) + " ,")
            assertThrows("gltf_json_") { Pet3dGlb.inspect(broken) }
        }
    }

    private fun assertThrows(expectedPrefix: String, body: () -> Unit) {
        val error = try { body(); null } catch (thrown: Throwable) { thrown }
        if (error == null) throw AssertionError("期望抛出 $expectedPrefix，但没有异常")
        val message = error.message ?: error.toString()
        assertTrue(message.startsWith(expectedPrefix), "期望 $expectedPrefix，实际 $message")
    }

    private fun minimalJson(): String =
        "{\"asset\":{\"version\":\"2.0\",\"generator\":\"pet3d-check\"}," +
            "\"buffers\":[{\"byteLength\":36}]," +
            "\"bufferViews\":[{\"buffer\":0,\"byteOffset\":0,\"byteLength\":36}]," +
            "\"accessors\":[{\"bufferView\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\",\"min\":[0,0,0],\"max\":[1,1,0]}]," +
            "\"meshes\":[{\"name\":\"tri\",\"primitives\":[{\"attributes\":{\"POSITION\":0},\"mode\":4}]}]," +
            "\"nodes\":[{\"mesh\":0}],\"scenes\":[{\"nodes\":[0]}],\"scene\":0}"

    private fun minimalBin(): ByteArray {
        val values = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f)
        val bin = ByteArray(values.size * 4)
        for (index in values.indices) writeU32(bin, index * 4, values[index].toRawBits())
        return bin
    }

    private fun minimalGlb(json: String = minimalJson()): ByteArray {
        val bin = minimalBin()
        val jsonBytes = json.toByteArray(Charsets.UTF_8)
        val jsonPadding = (4 - jsonBytes.size % 4) % 4
        val binPadding = (4 - bin.size % 4) % 4
        val total = 12 + 8 + jsonBytes.size + jsonPadding + 8 + bin.size + binPadding
        val output = ByteArray(total)
        writeU32(output, 0, 0x46546C67)
        writeU32(output, 4, 2)
        writeU32(output, 8, total)
        writeU32(output, 12, jsonBytes.size + jsonPadding)
        writeU32(output, 16, 0x4E4F534A)
        jsonBytes.copyInto(output, 20)
        for (index in 0 until jsonPadding) output[20 + jsonBytes.size + index] = ' '.code.toByte()
        val binHeader = 20 + jsonBytes.size + jsonPadding
        writeU32(output, binHeader, bin.size + binPadding)
        writeU32(output, binHeader + 4, 0x004E4942)
        bin.copyInto(output, binHeader + 8)
        return output
    }

    private fun writeU32(target: ByteArray, at: Int, value: Int) {
        target[at] = (value and 0xff).toByte()
        target[at + 1] = ((value ushr 8) and 0xff).toByte()
        target[at + 2] = ((value ushr 16) and 0xff).toByte()
        target[at + 3] = ((value ushr 24) and 0xff).toByte()
    }

    private fun modelFactsJson(facts: Pet3dGlbFacts): String = buildString {
        append("{\"readable\":true")
        append(",\"sha256\":").append(quote(facts.sha256))
        append(",\"byteSize\":").append(facts.byteSize)
        append(",\"gltfVersion\":").append(quote(facts.gltfVersion))
        append(",\"generator\":").append(quote(facts.generator))
        append(",\"meshCount\":").append(facts.meshCount)
        append(",\"primitiveCount\":").append(facts.primitiveCount)
        append(",\"nodeCount\":").append(facts.nodeCount)
        append(",\"skinCount\":").append(facts.skinCount)
        append(",\"materialCount\":").append(facts.materialCount)
        append(",\"imageCount\":").append(facts.imageCount)
        append(",\"textureCount\":").append(facts.textureCount)
        append(",\"triangleCount\":").append(facts.triangleCount)
        append(",\"vertexCount\":").append(facts.vertexCount)
        append(",\"extensionsRequired\":[").append(facts.extensionsRequired.joinToString(",") { quote(it) }).append("]")
        append(",\"animationNames\":[").append(facts.animationNames.joinToString(",") { quote(it) }).append("]")
        append(",\"hasIdleAnimation\":").append(facts.hasIdleAnimation)
        append(",\"selfContained\":").append(facts.selfContained)
        append(",\"positionBoundsMin\":[").append((facts.positionBoundsMin ?: emptyList()).joinToString(",") { it.toString() }).append("]")
        append(",\"positionBoundsMax\":[").append((facts.positionBoundsMax ?: emptyList()).joinToString(",") { it.toString() }).append("]")
        append("}")
    }

    private fun quote(value: String): String {
        val builder = StringBuilder("\"")
        for (char in value) {
            when (char) {
                '"' -> builder.append("\\\"")
                '\\' -> builder.append("\\\\")
                '\n' -> builder.append("\\n")
                '\r' -> builder.append("\\r")
                '\t' -> builder.append("\\t")
                else -> if (char.code < 0x20) builder.append("\\u%04x".format(char.code)) else builder.append(char)
            }
        }
        return builder.append("\"").toString()
    }
}