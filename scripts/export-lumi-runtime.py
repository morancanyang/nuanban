import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


arguments = sys.argv[sys.argv.index("--") + 1:]
output = Path(arguments[0]).resolve()
output.mkdir(parents=True, exist_ok=True)
source = Path(bpy.data.filepath)
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
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
        ("CAT_HEAD", 5100), ("CAT_BODY", 2800), ("CAT_CHEST", 1300),
        ("CAT_CLOAK_tailored", 6800), ("CAT_EAR", 1500),
        ("_iris", 1600), ("_corneal", 1200), ("_sclera", 1100),
        ("_vertical_pupil", 550), ("CAT_TAIL", 1500),
        ("CAT_MUZZLE", 850), ("CAT_CHIN", 650), ("CAT_NOSE", 700),
        ("CAT_ARM", 1100), ("CAT_FOOT", 800), ("CAT_LEG", 550),
        ("CAT_PAW", 600), ("CAT_TOE_", 200),
        ("_soft_folded_collar", 900), ("_cabochon", 800),
        ("_gold_setting", 650), ("_prong_", 100),
        ("_turquoise_core", 600), ("_rounded_gold_star", 650),
        ("CAT_BAG_soft", 650), ("CAT_BAG_rounded", 650),
        ("_antique_gold_button", 150), ("_WHISKER_", 70),
        ("_stitch_", 40), ("_embroidery_", 90),
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
    size = 512
    coordinates = np.arange(size, dtype=float)
    horizontal, vertical = np.meshgrid(coordinates, coordinates)
    if woven:
        height = np.sin(horizontal * math.tau / 8) * np.cos(vertical * math.tau / 8) * 0.45
    else:
        height = generator.normal(0, 0.17, (size, size))
        height = height * 0.2 + np.roll(height, 1, axis=0) * 0.3 + np.roll(height, 2, axis=0) * 0.3 + np.roll(height, 3, axis=0) * 0.2
        height += 0.08 * np.sin(horizontal * math.tau / 3 + 0.3 * np.sin(vertical * math.tau / 32))
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
    for link in list(shader.inputs["Normal"].links):
        material.node_tree.links.remove(link)
    if material_name not in fur_names | cloth_names:
        continue
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (18, 18, 1) if material_name in fur_names else (12, 12, 1)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = fur_normal if material_name in fur_names else cloth_normal
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = 0.35 if material_name in fur_names else 0.2
    links.new(coordinates.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    links.new(texture.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], shader.inputs["Normal"])


iris_object = next(obj for obj in objects if "EYE_L_iris" in obj.name)
iris = iris_object.material_slots[0].material
iris_shader = principled(iris)
iris_color = iris_shader.inputs["Base Color"].links[0].from_socket
iris_output = next(node for node in iris.node_tree.nodes if node.type == "OUTPUT_MATERIAL")
emission = iris.node_tree.nodes.new("ShaderNodeEmission")
iris.node_tree.links.new(iris_color, emission.inputs["Color"])
iris.node_tree.links.new(emission.outputs[0], iris_output.inputs["Surface"])
iris_image = bpy.data.images.new("Microglow original blue iris baked", width=1024, height=1024, alpha=False)
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


fur_material = bpy.data.materials.new("Microglow real-time groom ribbons")
fur_material.use_nodes = True
fur_material.use_backface_culling = False
fur_shader = principled(fur_material)
fur_shader.inputs["Roughness"].default_value = 0.95
fur_shader.inputs["Sheen Weight"].default_value = 0.18
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
    pale = "pale" in groom.data.materials[0].name
    for strand in strands:
        start, middle, end = [Vector(strand[index]) for index in (0, 2, 4)]
        local = surface.matrix_world.inverted() @ start
        nearest = tree.find_nearest(local)
        normal = (surface.matrix_world.to_3x3().inverted().transposed() @ nearest[1]).normalized()
        width_axis = (end - start).cross(normal).normalized()
        if width_axis.length < 0.01:
            width_axis = normal.cross(Vector((0.36, 0.62, 0.7))).normalized()
        width = generator.uniform(0.00055, 0.00105)
        offset = len(vertices)
        vertices.extend([tuple(start - width_axis * width), tuple(start + width_axis * width), tuple(middle - width_axis * width * 0.65), tuple(middle + width_axis * width * 0.65), tuple(end)])
        faces.extend([(offset, offset + 1, offset + 2), (offset + 1, offset + 3, offset + 2), (offset + 2, offset + 3, offset + 4)])
        shade = generator.uniform(0.86, 1.0)
        base_color = (0.95, 0.91, 0.80) if pale else (0.88, 0.84, 0.73)
        colors.extend([(*(component * shade for component in base_color), 1)] * 5)
    mesh = bpy.data.meshes.new(groom.name + "_RIBBONS")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    color_attribute = mesh.color_attributes.new(name="GroomColor", type="FLOAT_COLOR", domain="POINT")
    color_attribute.data.foreach_set("color", np.asarray(colors, dtype=np.float32).ravel())
    mesh.materials.append(fur_material)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    duplicate = bpy.data.objects.new(groom.name + "_RT", mesh)
    runtime.objects.link(duplicate)
    duplicate["source_object"] = groom.name
    duplicate["source_surface"] = surface.name
    objects.append(duplicate)
    exported_strands += count

root = bpy.data.objects.new("Microglow_Original_Cat", None)
runtime.objects.link(root)
root["source_blend_sha256"] = source_hash
root["asset_version"] = "2.0.0"
root["groom_conversion"] = "Tapered mesh ribbons sampled from the original groom; packed short-fur normal texture"
for obj in objects:
    obj.parent = root

bpy.context.scene.render.fps = 30
for frame, height in [(1, 0), (46, 0.006), (91, 0), (136, -0.002), (181, 0)]:
    root.location.z = height
    root.keyframe_insert(data_path="location", frame=frame)
root.animation_data.action.name = "idle"
bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = 181
bpy.context.scene.frame_set(1)
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
model_path = output / "Lumi_Magical_Kitten.glb"
bpy.ops.export_scene.gltf(
    filepath=str(model_path), export_format="GLB", use_selection=True,
    export_apply=True, export_yup=True, export_cameras=False, export_lights=False,
    export_animations=True, export_animation_mode="ACTIONS", export_frame_range=True,
    export_force_sampling=True, export_skins=False, export_morph=False,
    export_extras=True, export_vertex_color="ACTIVE", export_image_format="AUTO",
)

data = model_path.read_bytes()
document = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
triangles = sum(document["accessors"][primitive["indices"]]["count"] // 3 for mesh in document["meshes"] for primitive in mesh["primitives"])
if triangles > 100000 or document.get("cameras") or document.get("skins"):
    raise RuntimeError("The exported asset violates the character-only runtime contract")
manifest = {
    "schemaVersion": "1.0.0",
    "character": {"id": "lumi-magical-kitten", "name": "Lumi Magical Kitten", "assetVersion": "2.0.0"},
    "source": {"file": source.name, "sha256": source_hash, "collection": character.name, "sourceGroomStrands": total_strands},
    "runtime": {
        "format": "glTF 2.0 binary (.glb)", "file": model_path.name, "fileBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(), "triangleCount": triangles,
        "meshCount": len(document["meshes"]), "materialCount": len(document["materials"]),
        "skeleton": {"boneCount": 0}, "frameRate": 30,
        "groom": {"method": "Tapered triangle ribbons from original curves and packed normal map", "strands": exported_strands, "lossless": False},
        "textures": [image["name"] for image in document.get("images", [])],
        "animations": [{"name": animation["name"], "kind": "object-transform"} for animation in document.get("animations", [])],
        "limitations": ["The original source has no skeletal rig or facial blend shapes.", "Movie groom and procedural shaders are adapted for real-time rendering, not exported losslessly."],
    },
}
(output / "character_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
poster = bpy.data.images.load(str(source.with_name("microglow_cat_hero.png")), check_existing=False)
poster.scale(1000, 1125)
poster.filepath_raw = str(output / "poster.png")
poster.file_format = "PNG"
poster.save()
print("RUNTIME_EXPORT_COMPLETE " + json.dumps(manifest["runtime"]), flush=True)
