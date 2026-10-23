package org.nuanban.assistant.nativehost

import java.security.MessageDigest

/**
 * 轻量 GLB/glTF 2.0 读取层（纯 Kotlin，无 Android 依赖），供原生 GLES 渲染层使用，也可离线在 JVM 中针对真实随包 GLB 跑用例。
 *
 * 设计取向是"失败即封闭"：任何超出支持范围的特性（外部 buffer、外部贴图、sparse accessor、非 2.0 版本、
 * chunk 越界/未填充、越界的 accessor 读取）都抛 [Pet3dGlbFormatException]，由上层回退到下一渲染层级，
 * 绝不渲染未校验或半解析的字节。
 */
class Pet3dGlbFormatException(message: String) : Exception(message)

sealed class Pet3dJson {
    data class Obj(val values: Map<String, Pet3dJson>) : Pet3dJson()
    data class Arr(val values: List<Pet3dJson>) : Pet3dJson()
    data class Str(val value: String) : Pet3dJson()
    data class Num(val value: Double) : Pet3dJson()
    data class Bool(val value: Boolean) : Pet3dJson()
    object Null : Pet3dJson()

    fun field(name: String): Pet3dJson? = (this as? Obj)?.values?.get(name)
    fun objectField(name: String): Obj? = field(name) as? Obj
    fun arrayField(name: String): Arr? = field(name) as? Arr
    fun stringField(name: String): String? = (field(name) as? Str)?.value
    fun intField(name: String): Int? = (field(name) as? Num)?.value?.toInt()
    fun floatListOrNull(): List<Float>? = (this as? Arr)?.values?.mapNotNull { (it as? Num)?.value?.toFloat() }
}

/** 最小 JSON 解析器：只覆盖 glTF JSON chunk 所需的语法，带深度上限，遇到非法输入即抛异常。 */
object Pet3dJsonParser {
    private const val MAX_DEPTH = 128

    fun parse(text: String): Pet3dJson {
        val cursor = Cursor(text)
        cursor.skipWhitespace()
        val value = cursor.readValue(0)
        cursor.skipWhitespace()
        if (!cursor.done()) throw Pet3dGlbFormatException("gltf_json_trailing_bytes")
        return value
    }

    private class Cursor(private val text: String) {
        private var index = 0
        fun done(): Boolean = index >= text.length
        fun skipWhitespace() {
            while (index < text.length && text[index].let { it == ' ' || it == '\n' || it == '\r' || it == '\t' }) index++
        }

        private fun fail(code: String): Nothing = throw Pet3dGlbFormatException(code)
        private fun expect(char: Char) {
            if (index >= text.length || text[index] != char) fail("gltf_json_expected_$char")
            index++
        }

        fun readValue(depth: Int): Pet3dJson {
            if (depth > MAX_DEPTH) fail("gltf_json_too_deep")
            if (done()) fail("gltf_json_truncated")
            return when (val char = text[index]) {
                '{' -> readObject(depth)
                '[' -> readArray(depth)
                '"' -> Pet3dJson.Str(readString())
                't' -> { literal("true"); Pet3dJson.Bool(true) }
                'f' -> { literal("false"); Pet3dJson.Bool(false) }
                'n' -> { literal("null"); Pet3dJson.Null }
                else -> if (char == '-' || char.isDigit()) readNumber() else fail("gltf_json_unexpected_token")
            }
        }

        private fun literal(value: String) {
            if (!text.startsWith(value, index)) fail("gltf_json_unexpected_token")
            index += value.length
        }

        private fun readObject(depth: Int): Pet3dJson {
            expect('{')
            val values = LinkedHashMap<String, Pet3dJson>()
            skipWhitespace()
            if (!done() && text[index] == '}') { index++; return Pet3dJson.Obj(values) }
            while (true) {
                skipWhitespace()
                if (done() || text[index] != '"') fail("gltf_json_expected_key")
                val key = readString()
                skipWhitespace()
                expect(':')
                skipWhitespace()
                values[key] = readValue(depth + 1)
                skipWhitespace()
                if (done()) fail("gltf_json_truncated")
                when (text[index]) {
                    ',' -> index++
                    '}' -> { index++; return Pet3dJson.Obj(values) }
                    else -> fail("gltf_json_expected_separator")
                }
            }
        }

        private fun readArray(depth: Int): Pet3dJson {
            expect('[')
            val values = ArrayList<Pet3dJson>()
            skipWhitespace()
            if (!done() && text[index] == ']') { index++; return Pet3dJson.Arr(values) }
            while (true) {
                skipWhitespace()
                values.add(readValue(depth + 1))
                skipWhitespace()
                if (done()) fail("gltf_json_truncated")
                when (text[index]) {
                    ',' -> index++
                    ']' -> { index++; return Pet3dJson.Arr(values) }
                    else -> fail("gltf_json_expected_separator")
                }
            }
        }

        private fun readString(): String {
            expect('"')
            val builder = StringBuilder()
            while (true) {
                if (done()) fail("gltf_json_truncated")
                when (val char = text[index++]) {
                    '"' -> return builder.toString()
                    '\\' -> {
                        if (done()) fail("gltf_json_truncated")
                        when (val escape = text[index++]) {
                            '"' -> builder.append('"')
                            '\\' -> builder.append('\\')
                            '/' -> builder.append('/')
                            'b' -> builder.append('\b')
                            'f' -> builder.append('\u000C')
                            'n' -> builder.append('\n')
                            'r' -> builder.append('\r')
                            't' -> builder.append('\t')
                            'u' -> {
                                if (index + 4 > text.length) fail("gltf_json_truncated")
                                val code = text.substring(index, index + 4).toIntOrNull(16) ?: fail("gltf_json_bad_unicode_escape")
                                index += 4
                                builder.append(code.toChar())
                            }
                            else -> fail("gltf_json_bad_escape")
                        }
                    }
                    else -> builder.append(char)
                }
            }
        }

        private fun readNumber(): Pet3dJson {
            val start = index
            if (text[index] == '-') index++
            while (index < text.length && text[index].isDigit()) index++
            if (index < text.length && text[index] == '.') { index++; while (index < text.length && text[index].isDigit()) index++ }
            if (index < text.length && (text[index] == 'e' || text[index] == 'E')) {
                index++
                if (index < text.length && (text[index] == '+' || text[index] == '-')) index++
                while (index < text.length && text[index].isDigit()) index++
            }
            val raw = text.substring(start, index)
            val value = raw.toDoubleOrNull() ?: fail("gltf_json_bad_number")
            return Pet3dJson.Num(value)
        }
    }
}

data class Pet3dAnimationFact(
    val name: String,
    val translationChannels: Int,
    val rotationChannels: Int,
    val scaleChannels: Int,
    val weightsChannels: Int,
) {
    val nodeChannels: Int get() = translationChannels + rotationChannels + scaleChannels
}

data class Pet3dGlbFacts(
    val byteSize: Int,
    val sha256: String,
    val gltfVersion: String,
    val generator: String,
    val meshCount: Int,
    val primitiveCount: Int,
    val nodeCount: Int,
    val skinCount: Int,
    val materialCount: Int,
    val imageCount: Int,
    val embeddedImageCount: Int,
    val textureCount: Int,
    val accessorCount: Int,
    val bufferByteLength: Long,
    val binChunkByteLength: Int,
    val triangleCount: Int,
    val vertexCount: Int,
    val indexedPrimitiveCount: Int,
    val unindexedPrimitiveCount: Int,
    val morphTargetPrimitiveCount: Int,
    val extensionsUsed: List<String>,
    val extensionsRequired: List<String>,
    val animations: List<Pet3dAnimationFact>,
    val positionBoundsMin: List<Float>?,
    val positionBoundsMax: List<Float>?,
) {
    val skinned: Boolean get() = skinCount > 0
    val hasIdleAnimation: Boolean get() = animations.any { it.name == "idle" && it.nodeChannels > 0 }
    val requiresTextureTransform: Boolean get() = extensionsRequired.contains("KHR_texture_transform")
    val selfContained: Boolean get() = embeddedImageCount == imageCount && extensionsRequired.all { it == "KHR_texture_transform" }
    val animationNames: List<String> get() = animations.map { it.name }
}

data class Pet3dPrimitiveRef(
    val meshIndex: Int,
    val meshName: String,
    val primitiveIndex: Int,
    val positionAccessor: Int,
    val normalAccessor: Int?,
    val indicesAccessor: Int?,
    val materialIndex: Int?,
    val mode: Int,
    val morphTargetCount: Int,
)

data class Pet3dNodeRef(
    val index: Int,
    val name: String,
    val children: List<Int>,
    val meshIndex: Int?,
    /** 节点自身 TRS；glTF 用四元数 (x, y, z, w) 表示旋转，缺省为单位值。 */
    val translation: FloatArray,
    val rotation: FloatArray,
    val scale: FloatArray,
    val matrix: FloatArray,
    val hasMatrix: Boolean,
)

data class Pet3dMaterialRef(
    val index: Int,
    val name: String,
    /** pbrMetallicRoughness.baseColorFactor，缺省为白色不透明的 glTF 默认值。 */
    val baseColorFactor: FloatArray,
    val doubleSided: Boolean,
    val alphaMode: String,
)

data class Pet3dAnimationSamplerRef(
    val nodeIndex: Int,
    val path: String,
    val inputAccessor: Int,
    val outputAccessor: Int,
    val interpolation: String,
)

data class Pet3dAnimationRef(val name: String, val samplers: List<Pet3dAnimationSamplerRef>)

private fun readFloatArray(json: Pet3dJson?, fallback: FloatArray): FloatArray {
    val values = json?.floatListOrNull() ?: return fallback.copyOf()
    if (values.size != fallback.size) return fallback.copyOf()
    return values.toFloatArray()
}

private fun parsePrimitives(gltf: Pet3dJson): List<Pet3dPrimitiveRef> {
    val meshes = gltf.arrayField("meshes")?.values ?: emptyList()
    val result = ArrayList<Pet3dPrimitiveRef>()
    for ((meshIndex, mesh) in meshes.withIndex()) {
        val name = mesh.stringField("name") ?: ("mesh_" + meshIndex)
        for ((primitiveIndex, primitive) in (mesh.arrayField("primitives")?.values ?: emptyList()).withIndex()) {
            val attributes = primitive.objectField("attributes") ?: continue
            val position = attributes.intField("POSITION") ?: throw Pet3dGlbFormatException("gltf_primitive_without_position")
            result.add(
                Pet3dPrimitiveRef(
                    meshIndex = meshIndex,
                    meshName = name,
                    primitiveIndex = primitiveIndex,
                    positionAccessor = position,
                    normalAccessor = attributes.intField("NORMAL"),
                    indicesAccessor = primitive.intField("indices"),
                    materialIndex = primitive.intField("material"),
                    mode = primitive.intField("mode") ?: 4,
                    morphTargetCount = primitive.arrayField("targets")?.values?.size ?: 0,
                ),
            )
        }
    }
    return result
}

/** 解析后的 GLB：facts 供策略/上报使用，accessor 读取供原生渲染层建 VBO 使用。 */
class Pet3dGlbDocument internal constructor(
    val facts: Pet3dGlbFacts,
    private val gltf: Pet3dJson,
    private val bin: ByteArray,
    private val primitiveRefs: List<Pet3dPrimitiveRef>,
) {
    private val accessors: List<Pet3dJson> = gltf.arrayField("accessors")?.values ?: emptyList()
    private val bufferViews: List<Pet3dJson> = gltf.arrayField("bufferViews")?.values ?: emptyList()

    fun primitives(): List<Pet3dPrimitiveRef> = primitiveRefs

    fun nodes(): List<Pet3dNodeRef> {
        val identity = floatArrayOf(1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
        return (gltf.arrayField("nodes")?.values ?: emptyList()).mapIndexed { index, node ->
            Pet3dNodeRef(
                index = index,
                name = node.stringField("name") ?: ("node_" + index),
                children = node.arrayField("children")?.values?.mapNotNull { (it as? Pet3dJson.Num)?.value?.toInt() } ?: emptyList(),
                meshIndex = node.intField("mesh"),
                translation = readFloatArray(node.field("translation"), floatArrayOf(0f, 0f, 0f)),
                rotation = readFloatArray(node.field("rotation"), floatArrayOf(0f, 0f, 0f, 1f)),
                scale = readFloatArray(node.field("scale"), floatArrayOf(1f, 1f, 1f)),
                matrix = readFloatArray(node.field("matrix"), identity),
                hasMatrix = node.field("matrix") != null,
            )
        }
    }

    fun materials(): List<Pet3dMaterialRef> = (gltf.arrayField("materials")?.values ?: emptyList()).mapIndexed { index, material ->
        val pbr = material.objectField("pbrMetallicRoughness")
        Pet3dMaterialRef(
            index = index,
            name = material.stringField("name") ?: ("material_" + index),
            baseColorFactor = readFloatArray(pbr?.field("baseColorFactor"), floatArrayOf(1f, 1f, 1f, 1f)),
            doubleSided = (material.field("doubleSided") as? Pet3dJson.Bool)?.value == true,
            alphaMode = material.stringField("alphaMode") ?: "OPAQUE",
        )
    }

    fun animations(): List<Pet3dAnimationRef> = (gltf.arrayField("animations")?.values ?: emptyList()).mapIndexed { index, animation ->
        val samplers = animation.arrayField("samplers")?.values ?: emptyList()
        val refs = ArrayList<Pet3dAnimationSamplerRef>()
        for (channel in animation.arrayField("channels")?.values ?: emptyList()) {
            val target = channel.objectField("target") ?: continue
            val samplerIndex = channel.intField("sampler") ?: continue
            val sampler = samplers.getOrNull(samplerIndex) ?: continue
            refs.add(
                Pet3dAnimationSamplerRef(
                    nodeIndex = target.intField("node") ?: continue,
                    path = target.stringField("path") ?: continue,
                    inputAccessor = sampler.intField("input") ?: continue,
                    outputAccessor = sampler.intField("output") ?: continue,
                    interpolation = sampler.stringField("interpolation") ?: "LINEAR",
                ),
            )
        }
        Pet3dAnimationRef(animation.stringField("name") ?: ("animation_" + index), refs)
    }

    /** 动画时长取各输入 accessor 的 max[0]（glTF Blender 导出会写 min/max）；取不到返回 0，调用方按静态处理。 */
    fun animationDurationSeconds(animationIndex: Int): Float {
        val animation = animations().getOrNull(animationIndex) ?: return 0f
        var duration = 0f
        for (sampler in animation.samplers) {
            val maximum = accessors.getOrNull(sampler.inputAccessor)?.arrayField("max")?.floatListOrNull()?.firstOrNull() ?: continue
            if (maximum > duration) duration = maximum
        }
        return duration
    }

    fun readFloats(accessorIndex: Int): FloatArray {
        val accessor = accessor(accessorIndex)
        val componentType = accessor.intField("componentType") ?: throw Pet3dGlbFormatException("gltf_accessor_without_component_type")
        val components = componentCount(accessor.stringField("type"))
        val count = requireCount(accessor)
        val normalized = (accessor.field("normalized") as? Pet3dJson.Bool)?.value == true
        val componentSize = componentSize(componentType)
        val elementSize = componentSize * components
        val view = viewOf(accessor)
        val stride = strideOf(view, elementSize)
        val base = validatedOffset(accessor, view, count, stride, elementSize)
        val output = FloatArray(count * components)
        for (element in 0 until count) {
            val offset = base + element * stride
            for (component in 0 until components) {
                val at = offset + component * componentSize
                output[element * components + component] = when (componentType) {
                    5126 -> readFloat32(at)
                    5123 -> normalize(readUint16(at).toLong(), 65535L, normalized)
                    5121 -> normalize(readUint8(at).toLong(), 255L, normalized)
                    5122 -> normalize(readInt16(at).toLong(), 32767L, normalized)
                    5120 -> normalize(readInt8(at).toLong(), 127L, normalized)
                    // 5125 在顶点属性里很少出现；readUint32 返回有符号 Int，先按无符号展开再归一化。
                    5125 -> normalize(readUint32(at).toLong() and 0xFFFFFFFFL, 4294967295L, normalized)
                    else -> throw Pet3dGlbFormatException("gltf_unsupported_component_type")
                }
            }
        }
        return output
    }

    fun readIndices(accessorIndex: Int): IntArray {
        val accessor = accessor(accessorIndex)
        val componentType = accessor.intField("componentType") ?: throw Pet3dGlbFormatException("gltf_accessor_without_component_type")
        val count = requireCount(accessor)
        val componentSize = componentSize(componentType)
        val view = viewOf(accessor)
        val stride = strideOf(view, componentSize)
        val base = validatedOffset(accessor, view, count, stride, componentSize)
        val output = IntArray(count)
        for (element in 0 until count) {
            val at = base + element * stride
            output[element] = when (componentType) {
                5125 -> readUint32(at).toLong().let { if (it > Int.MAX_VALUE) throw Pet3dGlbFormatException("gltf_index_out_of_int_range") else it.toInt() }
                5123 -> readUint16(at)
                5121 -> readUint8(at)
                else -> throw Pet3dGlbFormatException("gltf_unsupported_index_component_type")
            }
        }
        return output
    }

    private fun accessor(index: Int): Pet3dJson {
        if (index < 0 || index >= accessors.size) throw Pet3dGlbFormatException("gltf_accessor_index_out_of_range")
        val accessor = accessors[index]
        if (accessor.field("sparse") != null) throw Pet3dGlbFormatException("gltf_sparse_accessor_unsupported")
        return accessor
    }

    private fun requireCount(accessor: Pet3dJson): Int {
        val count = accessor.intField("count") ?: throw Pet3dGlbFormatException("gltf_accessor_without_count")
        if (count < 0 || count > 8_000_000) throw Pet3dGlbFormatException("gltf_accessor_count_out_of_range")
        return count
    }

    private fun viewOf(accessor: Pet3dJson): Pet3dJson {
        val viewIndex = accessor.intField("bufferView") ?: throw Pet3dGlbFormatException("gltf_accessor_without_buffer_view")
        if (viewIndex < 0 || viewIndex >= bufferViews.size) throw Pet3dGlbFormatException("gltf_buffer_view_index_out_of_range")
        val view = bufferViews[viewIndex]
        if ((view.intField("buffer") ?: 0) != 0) throw Pet3dGlbFormatException("gltf_external_buffer_unsupported")
        return view
    }

    private fun validatedOffset(accessor: Pet3dJson, view: Pet3dJson, count: Int, stride: Int, elementSize: Int): Int {
        val viewOffset = view.intField("byteOffset") ?: 0
        val accessorOffset = accessor.intField("byteOffset") ?: 0
        if (viewOffset < 0 || accessorOffset < 0) throw Pet3dGlbFormatException("gltf_negative_accessor_offset")
        val base = viewOffset + accessorOffset
        val required = if (count == 0) 0L else (count - 1).toLong() * stride + elementSize
        if (base.toLong() + required > bin.size) throw Pet3dGlbFormatException("gltf_accessor_range_out_of_bounds")
        return base
    }

    private fun strideOf(view: Pet3dJson, elementSize: Int): Int {
        val stride = view.intField("byteStride") ?: 0
        if (stride == 0) return elementSize
        if (stride < elementSize) throw Pet3dGlbFormatException("gltf_byte_stride_too_small")
        return stride
    }

    private fun normalize(value: Long, max: Long, normalized: Boolean): Float =
        if (normalized) (value.toDouble() / max.toDouble()).toFloat().coerceIn(-1f, 1f) else value.toFloat()

    private fun readUint8(at: Int): Int = bin[at].toInt() and 0xff
    private fun readInt8(at: Int): Int = bin[at].toInt()
    private fun readUint16(at: Int): Int = readUint8(at) or (readUint8(at + 1) shl 8)
    private fun readInt16(at: Int): Int = readUint16(at).toShort().toInt()
    private fun readUint32(at: Int): Int = readUint16(at) or (readUint16(at + 2) shl 16)
    private fun readFloat32(at: Int): Float = Float.fromBits(readUint32(at))

    private fun componentSize(componentType: Int): Int = when (componentType) {
        5120, 5121 -> 1
        5122, 5123 -> 2
        5125, 5126 -> 4
        else -> throw Pet3dGlbFormatException("gltf_unsupported_component_type")
    }

    private fun componentCount(type: String?): Int = when (type) {
        "SCALAR" -> 1
        "VEC2" -> 2
        "VEC3" -> 3
        "VEC4" -> 4
        "MAT2" -> 4
        "MAT3" -> 9
        "MAT4" -> 16
        else -> throw Pet3dGlbFormatException("gltf_unsupported_accessor_type")
    }
}

object Pet3dGlb {
    private const val MAGIC = 0x46546C67
    private const val CHUNK_JSON = 0x4E4F534A
    private const val CHUNK_BIN = 0x004E4942

    fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun inspect(bytes: ByteArray): Pet3dGlbDocument {
        if (bytes.size < 32) throw Pet3dGlbFormatException("glb_too_small")
        if (readUint32(bytes, 0) != MAGIC) throw Pet3dGlbFormatException("glb_bad_magic")
        if (readUint32(bytes, 4) != 2) throw Pet3dGlbFormatException("glb_unsupported_version")
        if (readUint32(bytes, 8) != bytes.size) throw Pet3dGlbFormatException("glb_declared_length_mismatch")
        var offset = 12
        var json: ByteArray? = null
        var bin = ByteArray(0)
        while (offset + 8 <= bytes.size) {
            val length = readUint32(bytes, offset)
            val type = readUint32(bytes, offset + 4)
            offset += 8
            if (length < 0 || offset.toLong() + length > bytes.size) throw Pet3dGlbFormatException("glb_chunk_out_of_range")
            val payload = bytes.copyOfRange(offset, offset + length)
            when (type) {
                CHUNK_JSON -> if (json == null) json = payload else throw Pet3dGlbFormatException("glb_duplicate_json_chunk")
                CHUNK_BIN -> if (bin.isEmpty()) bin = payload else throw Pet3dGlbFormatException("glb_duplicate_bin_chunk")
                else -> Unit
            }
            offset += length
        }
        if (offset != bytes.size) throw Pet3dGlbFormatException("glb_trailing_bytes")
        val jsonBytes = json ?: throw Pet3dGlbFormatException("glb_missing_json_chunk")
        val gltf = Pet3dJsonParser.parse(String(jsonBytes, Charsets.UTF_8))
        val asset = gltf.objectField("asset") ?: throw Pet3dGlbFormatException("gltf_missing_asset")
        val gltfVersion = asset.stringField("version") ?: throw Pet3dGlbFormatException("gltf_missing_version")
        if (!gltfVersion.startsWith("2.")) throw Pet3dGlbFormatException("gltf_unsupported_version")
        val buffers = gltf.arrayField("buffers")?.values ?: emptyList()
        if (buffers.size != 1) throw Pet3dGlbFormatException("gltf_external_buffer_unsupported")
        val buffer = buffers[0]
        if (buffer.stringField("uri") != null) throw Pet3dGlbFormatException("gltf_external_buffer_unsupported")
        val bufferByteLength = (buffer.field("byteLength") as? Pet3dJson.Num)?.value?.toLong() ?: -1L
        if (bufferByteLength < 0 || bufferByteLength > bin.size) throw Pet3dGlbFormatException("gltf_bin_chunk_shorter_than_declared_buffer")
        val images = gltf.arrayField("images")?.values ?: emptyList()
        if (images.any { it.stringField("uri") != null }) throw Pet3dGlbFormatException("gltf_external_image_unsupported")
        val primitives = parsePrimitives(gltf)
        val accessors = gltf.arrayField("accessors")?.values ?: emptyList()
        var triangles = 0
        var vertices = 0
        var indexed = 0
        var unindexed = 0
        var morphTargets = 0
        for (primitive in primitives) {
            if (primitive.mode != 4) continue
            val vertexCount = accessors.getOrNull(primitive.positionAccessor)?.intField("count") ?: 0
            vertices += vertexCount
            val indexAccessor = primitive.indicesAccessor?.let { accessors.getOrNull(it) }
            if (indexAccessor != null) {
                indexed++
                triangles += (indexAccessor.intField("count") ?: 0) / 3
            } else {
                unindexed++
                triangles += vertexCount / 3
            }
            if (primitive.morphTargetCount > 0) morphTargets++
        }
        val positionAccessors = primitives.mapNotNull { accessors.getOrNull(it.positionAccessor) }
        val animations = (gltf.arrayField("animations")?.values ?: emptyList()).map { animation ->
            var translation = 0
            var rotation = 0
            var scale = 0
            var weights = 0
            for (channel in animation.arrayField("channels")?.values ?: emptyList()) {
                when (channel.objectField("target")?.stringField("path")) {
                    "translation" -> translation++
                    "rotation" -> rotation++
                    "scale" -> scale++
                    "weights" -> weights++
                    else -> Unit
                }
            }
            Pet3dAnimationFact(animation.stringField("name") ?: "unnamed", translation, rotation, scale, weights)
        }
        val facts = Pet3dGlbFacts(
            byteSize = bytes.size,
            sha256 = digest(bytes),
            gltfVersion = gltfVersion,
            generator = asset.stringField("generator") ?: "unknown",
            meshCount = gltf.arrayField("meshes")?.values?.size ?: 0,
            primitiveCount = primitives.size,
            nodeCount = gltf.arrayField("nodes")?.values?.size ?: 0,
            skinCount = gltf.arrayField("skins")?.values?.size ?: 0,
            materialCount = gltf.arrayField("materials")?.values?.size ?: 0,
            imageCount = images.size,
            embeddedImageCount = images.count { it.intField("bufferView") != null },
            textureCount = gltf.arrayField("textures")?.values?.size ?: 0,
            accessorCount = accessors.size,
            bufferByteLength = bufferByteLength,
            binChunkByteLength = bin.size,
            triangleCount = triangles,
            vertexCount = vertices,
            indexedPrimitiveCount = indexed,
            unindexedPrimitiveCount = unindexed,
            morphTargetPrimitiveCount = morphTargets,
            extensionsUsed = gltf.arrayField("extensionsUsed")?.values?.mapNotNull { (it as? Pet3dJson.Str)?.value } ?: emptyList(),
            extensionsRequired = gltf.arrayField("extensionsRequired")?.values?.mapNotNull { (it as? Pet3dJson.Str)?.value } ?: emptyList(),
            animations = animations,
            positionBoundsMin = unionBounds(positionAccessors, min = true),
            positionBoundsMax = unionBounds(positionAccessors, min = false),
        )
        return Pet3dGlbDocument(facts, gltf, bin, primitives)
    }

    private fun unionBounds(accessors: List<Pet3dJson>, min: Boolean): List<Float>? {
        var result: MutableList<Float>? = null
        for (accessor in accessors) {
            val values = accessor.arrayField(if (min) "min" else "max")?.floatListOrNull() ?: continue
            if (values.size != 3) continue
            if (result == null) result = values.toMutableList() else {
                for (index in 0 until 3) {
                    result[index] = if (min) minOf(result[index], values[index]) else maxOf(result[index], values[index])
                }
            }
        }
        return result
    }

    private fun readUint32(bytes: ByteArray, at: Int): Int {
        if (at < 0 || at + 4 > bytes.size) throw Pet3dGlbFormatException("glb_read_out_of_bounds")
        return (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8) or
            ((bytes[at + 2].toInt() and 0xff) shl 16) or ((bytes[at + 3].toInt() and 0xff) shl 24)
    }
}