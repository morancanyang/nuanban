package org.nuanban.assistant.nativehost

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * Spike (a)：原生 GLES2 轻量 GLB 渲染层。
 *
 * 支持范围（与随包 Lumi GLB 的能力对齐，超出即失败封闭到下一渲染层级）：
 *  - 三角形图元、索引/非索引几何、POSITION/NORMAL，材质 pbrMetallicRoughness.baseColorFactor 平色近似；
 *  - 节点层级 TRS（含 glTF `matrix`），动画 translation/rotation/scale 的 LINEAR / STEP 采样，优先选 idle 循环；
 *  - 不支持：蒙皮网格、形变目标、CUBICSPLINE、PBR 贴图/法线贴图与 KHR_* 材质扩展（贴图与材质近似为平色）。
 *
 * 该层只是"更省内存的近似形象"，不是桌面端渲染的等价物；真机保真度、帧率与耗电均未验证（deviceVerified=false）。
 */
class Pet3dGlRenderer(
    private val modelBytes: ByteArray,
    private val onReady: () -> Unit,
    private val onFailure: (String) -> Unit,
) : GLSurfaceView.Renderer {

    private class MeshGeometry(
        val positions: List<FloatArray>,
        val normals: List<FloatArray>,
        val indices: List<IntArray>,
        val indexType: Int,
        val baseColors: List<FloatArray>,
    )

    private class InstanceSpec(val nodeIndex: Int, val meshIndex: Int)

    private class Draw(
        val positionBuffer: Int,
        val normalBuffer: Int,
        val indexBuffer: Int,
        val indexCount: Int,
        val indexType: Int,
        val baseColor: FloatArray,
    )

    private class Channel(
        val path: String,
        val times: FloatArray,
        val values: FloatArray,
        val interpolation: String,
    )

    private class LoadedModel(
        val instances: List<InstanceSpec>,
        val meshes: Map<Int, MeshGeometry>,
        val nodes: List<Pet3dNodeRef>,
        val parents: IntArray,
        val localMatrices: Array<FloatArray>,
        val world: Array<FloatArray>,
        val computed: BooleanArray,
        val channels: Map<Int, List<Channel>>,
        val durationSeconds: Float,
        val boundsMin: FloatArray,
        val boundsMax: FloatArray,
    )

    private val stats = Pet3dFrameStats("native_gl")
    private var model: LoadedModel? = null
    private var gpuDraws: Map<Int, List<Draw>> = emptyMap()
    private var program = 0
    private var positionAttribute = -1
    private var normalAttribute = -1
    private var mvpUniform = -1
    private var worldUniform = -1
    private var baseColorUniform = -1
    private val projection = FloatArray(16)
    private val view = FloatArray(16)
    private val viewProjection = FloatArray(16)
    private val scratch = FloatArray(16)
    private var failed = false
    private var readySignalled = false
    private var startNanos = 0L

    override fun onSurfaceCreated(unused: GL10?, config: EGLConfig?) {
        if (failed) return
        try {
            GLES20.glClearColor(0f, 0f, 0f, 0f)
            GLES20.glDisable(GLES20.GL_DEPTH_TEST)
            // 形象按不透明处理：透明背景来自浮层窗口本身，避免半透明材质在叠加时出现意外穿透。
            GLES20.glDisable(GLES20.GL_BLEND)
            program = buildProgram()
            positionAttribute = GLES20.glGetAttribLocation(program, "aPosition")
            normalAttribute = GLES20.glGetAttribLocation(program, "aNormal")
            mvpUniform = GLES20.glGetUniformLocation(program, "uMvp")
            worldUniform = GLES20.glGetUniformLocation(program, "uWorld")
            baseColorUniform = GLES20.glGetUniformLocation(program, "uBaseColor")
            if (positionAttribute < 0 || mvpUniform < 0 || worldUniform < 0 || baseColorUniform < 0) {
                fail("native_shader_interface_missing")
                return
            }
            val loaded = model ?: loadModel().also { model = it }
            gpuDraws = upload(loaded)
            startNanos = System.nanoTime()
        } catch (error: Pet3dGlbFormatException) {
            fail(error.message ?: "native_model_rejected")
        } catch (error: Throwable) {
            fail("native_surface_setup_failed")
        }
    }

    override fun onSurfaceChanged(unused: GL10?, width: Int, height: Int) {
        if (failed || width <= 0 || height <= 0) return
        val loaded = model ?: return
        GLES20.glViewport(0, 0, width, height)
        val aspect = width.toFloat() / height.toFloat()
        val center = FloatArray(3)
        val size = FloatArray(3)
        for (axis in 0 until 3) {
            center[axis] = (loaded.boundsMin[axis] + loaded.boundsMax[axis]) * 0.5f
            size[axis] = (loaded.boundsMax[axis] - loaded.boundsMin[axis]).coerceAtLeast(0.001f)
        }
        val tanHalfFov = Math.tan(Math.toRadians(FOV_Y_DEGREES / 2.0)).toFloat()
        val distanceForHeight = (size[1] * 0.5f * FIT_MARGIN) / tanHalfFov
        val distanceForWidth = (size[0] * 0.5f * FIT_MARGIN) / (tanHalfFov * aspect)
        val distance = maxOf(distanceForHeight, distanceForWidth) + size[2] * 0.5f
        val near = (distance / 100f).coerceAtLeast(0.01f)
        val far = (distance + size[2]) * 4f
        Matrix.perspectiveM(projection, 0, FOV_Y_DEGREES, aspect, near, far)
        Matrix.setLookAtM(
            view, 0,
            center[0], center[1] + size[1] * 0.05f, center[2] + distance,
            center[0], center[1], center[2],
            0f, 1f, 0f,
        )
        Matrix.multiplyMM(viewProjection, 0, projection, 0, view, 0)
    }

    override fun onDrawFrame(unused: GL10?) {
        if (failed) return
        val loaded = model ?: return
        val now = System.nanoTime()
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        val elapsedSeconds = (now - startNanos) / 1_000_000_000f
        if (loaded.durationSeconds > 0f) applyAnimation(loaded, elapsedSeconds % loaded.durationSeconds)
        updateWorldMatrices(loaded)
        GLES20.glUseProgram(program)
        for (instance in loaded.instances) {
            val draws = gpuDraws[instance.meshIndex] ?: continue
            val world = loaded.world[instance.nodeIndex]
            Matrix.multiplyMM(scratch, 0, viewProjection, 0, world, 0)
            GLES20.glUniformMatrix4fv(mvpUniform, 1, false, scratch, 0)
            GLES20.glUniformMatrix4fv(worldUniform, 1, false, world, 0)
            for (draw in draws) {
                GLES20.glUniform4fv(baseColorUniform, 1, draw.baseColor, 0)
                GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, draw.positionBuffer)
                GLES20.glEnableVertexAttribArray(positionAttribute)
                GLES20.glVertexAttribPointer(positionAttribute, 3, GLES20.GL_FLOAT, false, 0, 0)
                if (normalAttribute >= 0) {
                    GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, draw.normalBuffer)
                    GLES20.glEnableVertexAttribArray(normalAttribute)
                    GLES20.glVertexAttribPointer(normalAttribute, 3, GLES20.GL_FLOAT, false, 0, 0)
                }
                GLES20.glBindBuffer(GLES20.GL_ELEMENT_ARRAY_BUFFER, draw.indexBuffer)
                GLES20.glDrawElements(GLES20.GL_TRIANGLES, draw.indexCount, draw.indexType, 0)
            }
        }
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
        GLES20.glBindBuffer(GLES20.GL_ELEMENT_ARRAY_BUFFER, 0)
        stats.recordFrame(now)
        stats.maybeReport(now)
        if (!readySignalled) {
            readySignalled = true
            onReady()
        }
    }

    private fun fail(reason: String) {
        if (failed) return
        failed = true
        onFailure(reason)
    }

    private fun loadModel(): LoadedModel {
        val document = Pet3dGlb.inspect(modelBytes)
        val facts = document.facts
        if (facts.skinned) throw Pet3dGlbFormatException("native_skinning_unsupported")
        if (facts.morphTargetPrimitiveCount > 0) throw Pet3dGlbFormatException("native_morph_targets_unsupported")
        val primitives = document.primitives()
        if (primitives.isEmpty()) throw Pet3dGlbFormatException("native_no_primitives")
        if (primitives.any { it.mode != 4 }) throw Pet3dGlbFormatException("native_primitive_mode_unsupported")
        val nodes = document.nodes()
        val materials = document.materials()
        val parents = IntArray(nodes.size) { -1 }
        for (node in nodes) for (child in node.children) if (child in nodes.indices) parents[child] = node.index
        val localMatrices = Array(nodes.size) { FloatArray(16) }
        for (node in nodes) localMatrices[node.index] = composeLocal(node)
        val world = Array(nodes.size) { FloatArray(16) }
        val computed = BooleanArray(nodes.size)
        val boundsMin = FloatArray(3) { Float.MAX_VALUE }
        val boundsMax = FloatArray(3) { -Float.MAX_VALUE }
        val meshes = HashMap<Int, MeshGeometry>()
        val instances = ArrayList<InstanceSpec>()
        for (node in nodes) {
            val meshIndex = node.meshIndex ?: continue
            val meshPrimitives = primitives.filter { it.meshIndex == meshIndex }
            if (meshPrimitives.isEmpty()) continue
            instances.add(InstanceSpec(node.index, meshIndex))
            if (meshes.containsKey(meshIndex)) continue
            val positionsList = ArrayList<FloatArray>(meshPrimitives.size)
            val normalsList = ArrayList<FloatArray>(meshPrimitives.size)
            val indicesList = ArrayList<IntArray>(meshPrimitives.size)
            val colors = ArrayList<FloatArray>(meshPrimitives.size)
            var indexType = GLES20.GL_UNSIGNED_SHORT
            for (primitive in meshPrimitives) {
                val positions = document.readFloats(primitive.positionAccessor)
                if (positions.isEmpty() || positions.size % 3 != 0) throw Pet3dGlbFormatException("native_position_count_invalid")
                val vertexCount = positions.size / 3
                val normals = primitive.normalAccessor?.let { document.readFloats(it) }?.takeIf { it.size == positions.size }
                    ?: FloatArray(positions.size) { if (it % 3 == 2) 1f else 0f }
                val indices = primitive.indicesAccessor?.let { document.readIndices(it) }
                    ?: IntArray(vertexCount) { it }
                if (indices.isEmpty() || indices.size % 3 != 0) throw Pet3dGlbFormatException("native_index_count_invalid")
                if (indices.any { it < 0 || it >= vertexCount }) throw Pet3dGlbFormatException("native_index_out_of_range")
                if (indices.max() > 0xffff) indexType = GLES20.GL_UNSIGNED_INT
                positionsList.add(positions)
                normalsList.add(normals)
                indicesList.add(indices)
                colors.add(primitive.materialIndex?.let { materials.getOrNull(it)?.baseColorFactor } ?: DEFAULT_BASE_COLOR)
            }
            val meshWorld = worldOf(node.index, parents, localMatrices, world, computed)
            for (positions in positionsList) {
                var vertex = 0
                while (vertex * 3 + 2 < positions.size) {
                    val x = positions[vertex * 3]
                    val y = positions[vertex * 3 + 1]
                    val z = positions[vertex * 3 + 2]
                    val wx = meshWorld[0] * x + meshWorld[4] * y + meshWorld[8] * z + meshWorld[12]
                    val wy = meshWorld[1] * x + meshWorld[5] * y + meshWorld[9] * z + meshWorld[13]
                    val wz = meshWorld[2] * x + meshWorld[6] * y + meshWorld[10] * z + meshWorld[14]
                    if (wx < boundsMin[0]) boundsMin[0] = wx
                    if (wy < boundsMin[1]) boundsMin[1] = wy
                    if (wz < boundsMin[2]) boundsMin[2] = wz
                    if (wx > boundsMax[0]) boundsMax[0] = wx
                    if (wy > boundsMax[1]) boundsMax[1] = wy
                    if (wz > boundsMax[2]) boundsMax[2] = wz
                    vertex++
                }
            }
            meshes[meshIndex] = MeshGeometry(positionsList, normalsList, indicesList, indexType, colors)
        }
        if (instances.isEmpty()) throw Pet3dGlbFormatException("native_no_mesh_instances")
        if (boundsMin[0] > boundsMax[0]) throw Pet3dGlbFormatException("native_empty_bounds")
        val animation = document.animations().firstOrNull { it.name == "idle" && it.samplers.any { sampler -> sampler.path != "weights" } }
            ?: document.animations().firstOrNull { it.samplers.any { sampler -> sampler.path != "weights" } }
        val channels = HashMap<Int, MutableList<Channel>>()
        var duration = 0f
        if (animation != null) {
            for (sampler in animation.samplers) {
                if (sampler.path == "weights" || sampler.interpolation == "CUBICSPLINE") continue
                val times = document.readFloats(sampler.inputAccessor)
                val values = document.readFloats(sampler.outputAccessor)
                val stride = when (sampler.path) {
                    "rotation" -> 4
                    "translation", "scale" -> 3
                    else -> continue
                }
                if (times.isEmpty() || values.size < times.size * stride) continue
                if (times.last() > duration) duration = times.last()
                channels.getOrPut(sampler.nodeIndex) { ArrayList() }.add(Channel(sampler.path, times, values, sampler.interpolation))
            }
        }
        return LoadedModel(
            instances = instances,
            meshes = meshes,
            nodes = nodes,
            parents = parents,
            localMatrices = localMatrices,
            world = world,
            computed = computed,
            channels = channels,
            durationSeconds = duration,
            boundsMin = boundsMin,
            boundsMax = boundsMax,
        )
    }

    private fun worldOf(nodeIndex: Int, parents: IntArray, localMatrices: Array<FloatArray>, world: Array<FloatArray>, computed: BooleanArray): FloatArray {
        if (nodeIndex !in world.indices) return FloatArray(16).also { Matrix.setIdentityM(it, 0) }
        if (computed[nodeIndex]) return world[nodeIndex]
        val parent = parents[nodeIndex]
        if (parent < 0 || parent == nodeIndex) {
            localMatrices[nodeIndex].copyInto(world[nodeIndex])
        } else {
            Matrix.multiplyMM(world[nodeIndex], 0, worldOf(parent, parents, localMatrices, world, computed), 0, localMatrices[nodeIndex], 0)
        }
        computed[nodeIndex] = true
        return world[nodeIndex]
    }

    private fun updateWorldMatrices(loaded: LoadedModel) {
        for (index in loaded.computed.indices) loaded.computed[index] = false
        for (node in loaded.nodes) worldOf(node.index, loaded.parents, loaded.localMatrices, loaded.world, loaded.computed)
    }

    private fun applyAnimation(loaded: LoadedModel, timeSeconds: Float) {
        for ((nodeIndex, nodeChannels) in loaded.channels) {
            val node = loaded.nodes.getOrNull(nodeIndex) ?: continue
            val translation = node.translation.copyOf()
            val rotation = node.rotation.copyOf()
            val scale = node.scale.copyOf()
            for (channel in nodeChannels) {
                when (channel.path) {
                    "translation" -> sampleVec3(channel, timeSeconds)?.copyInto(translation)
                    "scale" -> sampleVec3(channel, timeSeconds)?.copyInto(scale)
                    "rotation" -> sampleQuaternion(channel, timeSeconds)?.copyInto(rotation)
                    else -> Unit
                }
            }
            loaded.localMatrices[nodeIndex] = composeLocal(
                Pet3dNodeRef(node.index, node.name, node.children, node.meshIndex, translation, rotation, scale, node.matrix, hasMatrix = false),
            )
        }
    }

    private fun sampleVec3(channel: Channel, timeSeconds: Float): FloatArray? {
        val keys = channel.times.size
        if (keys == 0 || channel.values.size < keys * 3) return null
        val (index, blend) = locate(channel, timeSeconds)
        val next = if (index + 1 < keys) index + 1 else index
        val result = FloatArray(3)
        for (component in 0 until 3) {
            val a = channel.values[index * 3 + component]
            val b = channel.values[next * 3 + component]
            result[component] = if (channel.interpolation == "STEP" || next == index) a else a + (b - a) * blend
        }
        return result
    }

    private fun sampleQuaternion(channel: Channel, timeSeconds: Float): FloatArray? {
        val keys = channel.times.size
        if (keys == 0 || channel.values.size < keys * 4) return null
        val (index, blend) = locate(channel, timeSeconds)
        val next = if (index + 1 < keys) index + 1 else index
        val a = floatArrayOf(channel.values[index * 4], channel.values[index * 4 + 1], channel.values[index * 4 + 2], channel.values[index * 4 + 3])
        if (channel.interpolation == "STEP" || next == index) return a
        val b = floatArrayOf(channel.values[next * 4], channel.values[next * 4 + 1], channel.values[next * 4 + 2], channel.values[next * 4 + 3])
        return slerp(a, b, blend)
    }

    private fun locate(channel: Channel, timeSeconds: Float): Pair<Int, Float> {
        val times = channel.times
        if (timeSeconds <= times.first()) return 0 to 0f
        if (timeSeconds >= times.last()) return (times.size - 1) to 0f
        var index = 0
        while (index + 1 < times.size && times[index + 1] <= timeSeconds) index++
        val span = times[index + 1] - times[index]
        val blend = if (span <= 0f) 0f else ((timeSeconds - times[index]) / span).coerceIn(0f, 1f)
        return index to blend
    }

    private fun slerp(a: FloatArray, b: FloatArray, blend: Float): FloatArray {
        var dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
        val target = b.copyOf()
        if (dot < 0f) {
            for (index in 0 until 4) target[index] = -target[index]
            dot = -dot
        }
        if (dot > 0.9995f) {
            val result = FloatArray(4)
            for (index in 0 until 4) result[index] = a[index] + (target[index] - a[index]) * blend
            return normalizeQuaternion(result)
        }
        val theta = Math.acos(dot.toDouble())
        val sinTheta = Math.sin(theta)
        val weightA = Math.sin((1.0 - blend) * theta) / sinTheta
        val weightB = Math.sin(blend.toDouble() * theta) / sinTheta
        val result = FloatArray(4)
        for (index in 0 until 4) result[index] = (a[index] * weightA + target[index] * weightB).toFloat()
        return normalizeQuaternion(result)
    }

    private fun normalizeQuaternion(value: FloatArray): FloatArray {
        val length = Math.sqrt((value[0] * value[0] + value[1] * value[1] + value[2] * value[2] + value[3] * value[3]).toDouble())
        if (length <= 1e-6) return floatArrayOf(0f, 0f, 0f, 1f)
        for (index in 0 until 4) value[index] = (value[index] / length).toFloat()
        return value
    }

    private fun composeLocal(node: Pet3dNodeRef): FloatArray {
        val matrix = FloatArray(16)
        if (node.hasMatrix) {
            node.matrix.copyInto(matrix)
            return matrix
        }
        val rotation = fromQuaternion(node.rotation)
        val scale = FloatArray(16).also {
            Matrix.setIdentityM(it, 0)
            Matrix.scaleM(it, 0, node.scale[0], node.scale[1], node.scale[2])
        }
        val translation = FloatArray(16).also {
            Matrix.setIdentityM(it, 0)
            Matrix.translateM(it, 0, node.translation[0], node.translation[1], node.translation[2])
        }
        val scaled = FloatArray(16)
        Matrix.multiplyMM(scaled, 0, rotation, 0, scale, 0)
        Matrix.multiplyMM(matrix, 0, translation, 0, scaled, 0)
        return matrix
    }

    /** glTF 四元数 (x, y, z, w) → 列主序 4x4（android.opengl.Matrix 没有四元数入口）。 */
    private fun fromQuaternion(quaternion: FloatArray): FloatArray {
        val x = quaternion[0]
        val y = quaternion[1]
        val z = quaternion[2]
        val w = quaternion[3]
        val xx = x * x
        val yy = y * y
        val zz = z * z
        val xy = x * y
        val xz = x * z
        val yz = y * z
        val wx = w * x
        val wy = w * y
        val wz = w * z
        return floatArrayOf(
            1f - 2f * (yy + zz), 2f * (xy + wz), 2f * (xz - wy), 0f,
            2f * (xy - wz), 1f - 2f * (xx + zz), 2f * (yz + wx), 0f,
            2f * (xz + wy), 2f * (yz - wx), 1f - 2f * (xx + yy), 0f,
            0f, 0f, 0f, 1f,
        )
    }

    private fun upload(loaded: LoadedModel): Map<Int, List<Draw>> {
        val result = HashMap<Int, List<Draw>>(loaded.meshes.size)
        for ((meshIndex, mesh) in loaded.meshes) {
            val draws = ArrayList<Draw>(mesh.positions.size)
            for (index in mesh.positions.indices) {
                draws.add(
                    Draw(
                        positionBuffer = uploadFloats(mesh.positions[index]),
                        normalBuffer = uploadFloats(mesh.normals[index]),
                        indexBuffer = uploadIndices(mesh.indices[index], mesh.indexType),
                        indexCount = mesh.indices[index].size,
                        indexType = mesh.indexType,
                        baseColor = mesh.baseColors[index],
                    ),
                )
            }
            result[meshIndex] = draws
        }
        if (GLES20.glGetError() != GLES20.GL_NO_ERROR) throw IllegalStateException("native_gl_upload_error")
        return result
    }

    private fun uploadFloats(data: FloatArray): Int {
        val ids = IntArray(1)
        GLES20.glGenBuffers(1, ids, 0)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, ids[0])
        val buffer = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        buffer.put(data)
        buffer.position(0)
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, data.size * 4, buffer, GLES20.GL_STATIC_DRAW)
        return ids[0]
    }

    private fun uploadIndices(data: IntArray, type: Int): Int {
        val ids = IntArray(1)
        GLES20.glGenBuffers(1, ids, 0)
        GLES20.glBindBuffer(GLES20.GL_ELEMENT_ARRAY_BUFFER, ids[0])
        if (type == GLES20.GL_UNSIGNED_INT) {
            val buffer = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asIntBuffer()
            buffer.put(data)
            buffer.position(0)
            GLES20.glBufferData(GLES20.GL_ELEMENT_ARRAY_BUFFER, data.size * 4, buffer, GLES20.GL_STATIC_DRAW)
        } else {
            val buffer = ByteBuffer.allocateDirect(data.size * 2).order(ByteOrder.nativeOrder()).asShortBuffer()
            for (value in data) buffer.put(value.toShort())
            buffer.position(0)
            GLES20.glBufferData(GLES20.GL_ELEMENT_ARRAY_BUFFER, data.size * 2, buffer, GLES20.GL_STATIC_DRAW)
        }
        return ids[0]
    }

    private fun buildProgram(): Int {
        val vertex = compile(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER)
        val fragment = compile(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
        val program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vertex)
        GLES20.glAttachShader(program, fragment)
        GLES20.glLinkProgram(program)
        val status = IntArray(1)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
        GLES20.glDeleteShader(vertex)
        GLES20.glDeleteShader(fragment)
        if (status[0] != GLES20.GL_TRUE) throw IllegalStateException("native_shader_link_failed")
        return program
    }

    private fun compile(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val status = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
        if (status[0] != GLES20.GL_TRUE) {
            GLES20.glDeleteShader(shader)
            throw IllegalStateException("native_shader_compile_failed")
        }
        return shader
    }

    companion object {
        private const val FOV_Y_DEGREES = 40f
        private const val FIT_MARGIN = 1.15f
        private val DEFAULT_BASE_COLOR = floatArrayOf(0.86f, 0.78f, 1f, 1f)
        private const val VERTEX_SHADER = """
            uniform mat4 uMvp;
            uniform mat4 uWorld;
            attribute vec3 aPosition;
            attribute vec3 aNormal;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            void main() {
                vec4 world = uWorld * vec4(aPosition, 1.0);
                vNormal = normalize(mat3(uWorld) * aNormal);
                vWorldPosition = world.xyz;
                gl_Position = uMvp * vec4(aPosition, 1.0);
            }
        """
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform vec4 uBaseColor;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            void main() {
                vec3 normal = normalize(vNormal);
                vec3 lightDirection = normalize(vec3(0.35, 0.75, 0.55));
                float lambert = max(dot(normal, lightDirection), 0.0);
                vec3 viewDirection = normalize(vec3(0.0, 0.0, 1.0) - vWorldPosition);
                float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 2.0) * 0.2;
                vec3 color = uBaseColor.rgb * (0.4 + 0.6 * lambert) + rim;
                gl_FragColor = vec4(color, 1.0);
            }
        """
    }
}