import hashlib
import json
import math
import runpy
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
output = Path(arguments[0]).resolve()
output.mkdir(parents=True, exist_ok=True)
source = Path(bpy.data.filepath)
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
if source_hash != "479e90d419ce51621b0354121cb5255a297e5d114a93f58a32d222a67e04a5b3":
    raise RuntimeError("Only the reviewed Lumi natural-v4 source can be rigged with this exporter")
if "MICROGLOW_CAT_RUNTIME" in bpy.data.collections:
    raise RuntimeError("Open the original static v4 source before exporting again")
character = bpy.data.collections["MICROGLOW_CAT_ONLY"]
runtime = bpy.data.collections.new("MICROGLOW_CAT_RUNTIME")
bpy.context.scene.collection.children.link(runtime)
generator = np.random.default_rng(231026)
graph = bpy.context.evaluated_depsgraph_get()


def principled(material):
    return next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")


def triangle_count(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def geometry_budget(name):
    budgets = [
        ("CAT_HEAD", 5800), ("CAT_BODY", 3200), ("CAT_CHEST", 1300),
        ("CAT_CLOAK_tailored", 6800), ("CAT_EAR", 1500),
        ("_iris", 2200), ("_corneal", 1200), ("_sclera", 1100),
        ("_limbal_ring", 700), ("CAT_EYELID", 400),
        ("_vertical_pupil", 550), ("CAT_TAIL", 1500),
        ("CAT_MUZZLE", 850), ("CAT_CHIN", 650), ("CAT_NOSE", 700),
        ("CAT_ARM", 1100), ("CAT_FOOT", 800), ("CAT_LEG", 550),
        ("CAT_PAW", 600), ("CAT_TOE_", 200),
        ("_soft_folded_collar", 900), ("_cabochon", 800),
        ("_gold_setting", 650), ("_prong_", 100),
        ("_turquoise_core", 600), ("_rounded_gold_star", 650),
        ("CAT_BAG_soft", 650), ("CAT_BAG_rounded", 650),
        ("_antique_gold_button", 150), ("_WHISKER_", 70),
        ("_stitch_", 12), ("_embroidery_", 60), ("_soft_open_pupil", 550),
    ]
    return next((budget for marker, budget in budgets if marker in name), 220)


def ensure_uv(mesh):
    if mesh.uv_layers:
        return
    uv_layer = mesh.uv_layers.new(name="RuntimeUV")
    positions = np.asarray([vertex.co[:] for vertex in mesh.vertices])
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0)
    span = np.maximum(maximum - minimum, 0.00001)
    for polygon in mesh.polygons:
        coordinates = []
        for loop_index in polygon.loop_indices:
            position = positions[mesh.loops[loop_index].vertex_index]
            coordinates.append(((math.atan2(position[1], position[0]) / math.tau) % 1, (position[2] - minimum[2]) / span[2]))
        seam = max(value[0] for value in coordinates) - min(value[0] for value in coordinates) > 0.5
        for loop_index, coordinate in zip(polygon.loop_indices, coordinates):
            uv_layer.data[loop_index].uv = (coordinate[0] + (1 if seam and coordinate[0] < 0.5 else 0), coordinate[1])


objects = []
for original in list(character.all_objects):
    if original.type not in {"MESH", "CURVE"}:
        continue
    if original.type == "CURVE":
        original.data.resolution_u = 4
        original.data.bevel_resolution = 1
    evaluated = original.evaluated_get(graph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=graph)
    duplicate = bpy.data.objects.new(original.name + "_RT", mesh)
    duplicate.matrix_world = original.matrix_world.copy()
    runtime.objects.link(duplicate)
    count = triangle_count(mesh)
    budget = geometry_budget(original.name)
    if count > budget:
        modifier = duplicate.modifiers.new("Realtime topology reduction", "DECIMATE")
        modifier.ratio = budget / count
        bpy.context.view_layer.objects.active = duplicate
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for material_index, slot in enumerate(original.material_slots):
        duplicate.data.materials[material_index] = slot.material
    ensure_uv(duplicate.data)
    duplicate["source_object"] = original.name
    objects.append(duplicate)

print("RUNTIME_BASE_TRIANGLES", sum(triangle_count(obj.data) for obj in objects), flush=True)


def normal_texture(name, woven=False):
    size = 1024 if not woven else 512
    coordinates = np.arange(size, dtype=float)
    horizontal, vertical = np.meshgrid(coordinates, coordinates)
    if woven:
        height = np.sin(horizontal * math.tau / 8) * np.cos(vertical * math.tau / 8) * 0.22
        height += np.sin(horizontal * math.tau / 4) * 0.025
    else:
        noise = generator.normal(0, 0.24, (size, size))
        height = sum(np.roll(noise, shift, axis=0) for shift in range(9)) / 9
        height += 0.035 * np.sin(horizontal * math.tau / 5 + 0.5 * np.sin(vertical * math.tau / 64))
    gradient_vertical, gradient_horizontal = np.gradient(height)
    normals = np.stack((-gradient_horizontal * 4, -gradient_vertical * 4, np.ones_like(height)), axis=2)
    normals /= np.linalg.norm(normals, axis=2)[:, :, None]
    pixels = np.concatenate((normals * 0.5 + 0.5, np.ones((size, size, 1))), axis=2)
    image = bpy.data.images.new(name, width=size, height=size, alpha=False)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels.astype(np.float32).ravel())
    image.pack()
    return image


fur_normal = normal_texture("Microglow short-fur normal")
cloth_normal = normal_texture("Microglow woven cloak normal", woven=True)
fur_names = {"CAT | warm ivory undercoat", "CAT | soft cream muzzle and chest"}
cloth_names = {"CAT | amethyst woven cloak", "CAT | dusky lilac cloak lining"}
for material in {slot.material for obj in objects for slot in obj.material_slots if slot.material}:
    material_name = material.name.split(".")[0]
    if material_name == "CAT | radial blue iris fibers":
        continue
    shader = principled(material)
    shader.inputs["Subsurface Weight"].default_value = 0
    if material_name == "CAT | clear tear film cornea":
        shader.inputs["Roughness"].default_value = 0.015
    for link in list(shader.inputs["Normal"].links):
        material.node_tree.links.remove(link)
    if material_name not in fur_names | cloth_names:
        continue
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1.25, 1, 1) if material_name in fur_names else (4, 4, 1)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = fur_normal if material_name in fur_names else cloth_normal
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = 0.45 if material_name in fur_names else 0.3
    links.new(coordinates.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    links.new(texture.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    if material_name in fur_names:
        shader.inputs["Roughness"].default_value = 0.86
        shader.inputs["Sheen Weight"].default_value = 0.25
        shader.inputs["Sheen Roughness"].default_value = 0.75
        shader.inputs["Sheen Tint"].default_value = (0.22, 0.21, 0.19, 1)
    else:
        shader.inputs["Roughness"].default_value = 0.8
        shader.inputs["Sheen Weight"].default_value = 0.28
        shader.inputs["Sheen Roughness"].default_value = 0.7
        shader.inputs["Sheen Tint"].default_value = (0.15, 0.11, 0.2, 1)


iris_object = next(obj for obj in objects if "EYE_L_iris" in obj.name)
iris = iris_object.material_slots[0].material
iris_shader = principled(iris)
iris_color = iris_shader.inputs["Base Color"].links[0].from_socket
iris_output = next(node for node in iris.node_tree.nodes if node.type == "OUTPUT_MATERIAL")
emission = iris.node_tree.nodes.new("ShaderNodeEmission")
iris.node_tree.links.new(iris_color, emission.inputs["Color"])
iris.node_tree.links.new(emission.outputs[0], iris_output.inputs["Surface"])
iris_image = bpy.data.images.new("Microglow original blue iris baked", width=2048, height=2048, alpha=False)
iris_texture = iris.node_tree.nodes.new("ShaderNodeTexImage")
iris_texture.image = iris_image
iris.node_tree.nodes.active = iris_texture
bpy.ops.object.select_all(action="DESELECT")
iris_object.select_set(True)
bpy.context.view_layer.objects.active = iris_object
bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.samples = 1
bpy.context.scene.render.bake.margin = 4
bpy.ops.object.bake(type="EMIT")
iris.node_tree.links.new(iris_shader.outputs[0], iris_output.inputs["Surface"])
iris.node_tree.links.new(iris_texture.outputs["Color"], iris_shader.inputs["Base Color"])
iris_image.pack()


def bake_contact_occlusion():
    matte_names = fur_names | cloth_names | {"CAT | chestnut soft leather"}
    targets = [obj for obj in objects if any(slot.material.name.split(".")[0] in matte_names for slot in obj.material_slots)]
    materials = {slot.material for obj in targets for slot in obj.material_slots}
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        obj.hide_render = obj.name not in runtime.objects
    for obj in targets:
        obj.select_set(True)
        obj.data.uv_layers.new(name="RuntimeAO")
        obj.data.uv_layers.active = obj.data.uv_layers["RuntimeAO"]
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.1, island_margin=0.004, area_weight=0.4, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    image = bpy.data.images.new("Microglow baked contact occlusion", width=1024, height=1024, alpha=False)
    image.colorspace_settings.name = "Non-Color"
    image.generated_color = (1, 1, 1, 1)
    restoration = []
    for material in materials:
        nodes, links = material.node_tree.nodes, material.node_tree.links
        material_output = next(node for node in nodes if node.type == "OUTPUT_MATERIAL")
        previous = material_output.inputs["Surface"].links[0].from_socket
        occlusion = nodes.new("ShaderNodeAmbientOcclusion")
        occlusion.inputs["Distance"].default_value = 0.14
        occlusion.samples = 16
        soften = nodes.new("ShaderNodeMath")
        soften.operation = "MULTIPLY_ADD"
        soften.inputs[1].default_value = 0.65
        soften.inputs[2].default_value = 0.35
        emission = nodes.new("ShaderNodeEmission")
        links.new(occlusion.outputs["AO"], soften.inputs[0])
        links.new(soften.outputs[0], emission.inputs["Color"])
        links.new(emission.outputs[0], material_output.inputs["Surface"])
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        nodes.active = texture
        restoration.append((material, previous, material_output, texture, (occlusion, soften, emission)))
    bpy.context.scene.cycles.samples = 16
    bpy.ops.object.bake(type="EMIT", use_clear=False, uv_layer="RuntimeAO", margin=8)
    settings = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    settings.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    for material, previous, material_output, texture, temporary in restoration:
        nodes, links = material.node_tree.nodes, material.node_tree.links
        links.new(previous, material_output.inputs["Surface"])
        for node in temporary:
            nodes.remove(node)
        coordinates = nodes.new("ShaderNodeUVMap")
        coordinates.uv_map = "RuntimeAO"
        links.new(coordinates.outputs["UV"], texture.inputs["Vector"])
        group = nodes.new("ShaderNodeGroup")
        group.node_tree = settings
        links.new(texture.outputs["Color"], group.inputs["Occlusion"])
    for obj in targets:
        obj.data.uv_layers.active_index = 0
        obj.data.uv_layers[0].active_render = True
    image.pack()


bake_contact_occlusion()


def groom_atlas():
    width, height, variants = 512, 1024, 8
    horizontal = (np.arange(width) + 0.5) / width
    vertical = (np.arange(height) + 0.5) / height
    grid_horizontal, grid_vertical = np.meshgrid(horizontal, vertical)
    alpha = np.zeros((height, width), dtype=np.float32)
    for variant in range(variants):
        local_horizontal = grid_horizontal * variants - variant
        local_alpha = np.zeros_like(alpha)
        for strand_index in range(5):
            center = (strand_index + 0.5) / 5 + generator.uniform(-0.035, 0.035)
            bend = generator.uniform(-0.08, 0.08) * np.sin(grid_vertical * math.pi)
            tip = generator.uniform(0.72, 0.99)
            radius = generator.uniform(0.045, 0.06) * np.maximum(0, 1 - grid_vertical / tip) ** 0.6
            stroke = np.clip((radius - np.abs(local_horizontal - center - bend)) * 220 + 0.5, 0, 1)
            stroke *= np.clip((tip - grid_vertical) * 60, 0, 1)
            local_alpha = np.maximum(local_alpha, stroke)
        alpha = np.maximum(alpha, local_alpha * ((local_horizontal >= 0) & (local_horizontal <= 1)))
    pixels = np.ones((height, width, 4), dtype=np.float32)
    pixels[:, :, 3] = alpha
    image = bpy.data.images.new("Microglow five-strand groom alpha atlas", width=width, height=height, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.pack()
    return image


fur_material = bpy.data.materials.new("Microglow real-time groom cards")
fur_material.use_nodes = True
fur_material.use_backface_culling = True
fur_shader = principled(fur_material)
fur_shader.inputs["Roughness"].default_value = 0.86
fur_shader.inputs["Sheen Weight"].default_value = 0.25
fur_shader.inputs["Sheen Roughness"].default_value = 0.75
fur_shader.inputs["Sheen Tint"].default_value = (0.22, 0.21, 0.19, 1)
fur_material.alpha_threshold = 0.25
fur_material.surface_render_method = "DITHERED"
fur_alpha = fur_material.node_tree.nodes.new("ShaderNodeTexImage")
fur_alpha.image = groom_atlas()
fur_mask = fur_material.node_tree.nodes.new("ShaderNodeMath")
fur_mask.operation = "GREATER_THAN"
fur_mask.inputs[1].default_value = 0.25
fur_material.node_tree.links.new(fur_alpha.outputs["Alpha"], fur_mask.inputs[0])
fur_material.node_tree.links.new(fur_mask.outputs[0], fur_shader.inputs["Alpha"])
attribute = fur_material.node_tree.nodes.new("ShaderNodeVertexColor")
attribute.layer_name = "GroomColor"
fur_material.node_tree.links.new(attribute.outputs["Color"], fur_shader.inputs["Base Color"])
base_count = sum(triangle_count(obj.data) for obj in objects)
fur_budget = min(15000, (98000 - base_count) // 3)
if fur_budget < 3000:
    raise RuntimeError("Source geometry exceeds the runtime budget")
grooms = [obj for obj in character.all_objects if obj.type == "CURVES"]
total_strands = sum(len(obj.data.curves) for obj in grooms)
exported_strands = 0
for groom in grooms:
    count = max(1, int(fur_budget * len(groom.data.curves) / total_strands))
    selection = generator.choice(len(groom.data.curves), count, replace=False)
    coordinates = np.empty(len(groom.data.points) * 3, dtype=np.float32)
    groom.data.attributes["position"].data.foreach_get("vector", coordinates)
    strands = coordinates.reshape((-1, 5, 3))[selection]
    surface = bpy.data.objects[groom["source_surface"]]
    tree = BVHTree.FromObject(surface, graph)
    vertices = []
    faces = []
    colors = []
    normals = []
    coordinates = []
    base_color = tuple(principled(surface.material_slots[0].material).inputs["Base Color"].default_value)[:3]
    for strand in strands:
        start, middle, end = [Vector(strand[index]) for index in (0, 2, 4)]
        local = surface.matrix_world.inverted() @ start
        nearest = tree.find_nearest(local)
        normal = (surface.matrix_world.to_3x3().inverted().transposed() @ nearest[1]).normalized()
        width_axis = (end - start).cross(normal).normalized()
        if width_axis.length < 0.01:
            width_axis = normal.cross(Vector((0.36, 0.62, 0.7))).normalized()
        width = generator.uniform(0.0038, 0.006)
        offset = len(vertices)
        vertices.extend([tuple(start - width_axis * width), tuple(start + width_axis * width), tuple(middle - width_axis * width), tuple(middle + width_axis * width), tuple(end)])
        faces.extend([(offset, offset + 1, offset + 2), (offset + 1, offset + 3, offset + 2), (offset + 2, offset + 3, offset + 4)])
        variant = int(generator.integers(0, 8))
        minimum, maximum = (variant + 0.05) / 8, (variant + 0.95) / 8
        coordinates.extend([(minimum, 0), (maximum, 0), (minimum, 0.5), (maximum, 0.5), ((minimum + maximum) / 2, 1)])
        normals.extend([tuple(normal)] * 5)
        shade = generator.uniform(0.985, 1.015)
        colors.extend([(*(component * shade * value for component in base_color), 1) for value in (0.98, 0.98, 1, 1, 1.02)])
    mesh = bpy.data.meshes.new(groom.name + "_RIBBONS")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="GroomAtlasUV")
    for loop in mesh.loops:
        uv_layer.data[loop.index].uv = coordinates[loop.vertex_index]
    color_attribute = mesh.color_attributes.new(name="GroomColor", type="FLOAT_COLOR", domain="POINT")
    color_attribute.data.foreach_set("color", np.asarray(colors, dtype=np.float32).ravel())
    mesh.materials.append(fur_material)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.normals_split_custom_set_from_vertices(normals)
    duplicate = bpy.data.objects.new(groom.name + "_RT", mesh)
    runtime.objects.link(duplicate)
    duplicate["source_object"] = groom.name
    duplicate["source_surface"] = surface.name
    objects.append(duplicate)
    exported_strands += count

root = bpy.data.objects.new("Lumi_Natural_v4_Rigged", None)
runtime.objects.link(root)
root["source_blend_sha256"] = source_hash
root["asset_version"] = "4.1.0"
root["character_id"] = "lumi-animated-v4"
root["source_groom_strands"] = total_strands
root["runtime_groom_cards"] = exported_strands
root["groom_conversion"] = "Five-strand alpha cards following the original groom, surface-aligned normals and packed short-fur normal texture"
for obj in objects:
    obj.parent = root

cache = Path("work/lumi-actions-task/lumi-runtime-unbound.blend").resolve()
cache.parent.mkdir(parents=True, exist_ok=True)
for obj in character.all_objects:
    obj.hide_render = True
    obj.hide_set(True)
bpy.ops.wm.save_as_mainfile(filepath=str(cache), compress=True)
if "--prepare-only" not in arguments:
    runpy.run_path(str(Path(__file__).parent / "characters/bind-lumi-actions.py"))["build"](output)
