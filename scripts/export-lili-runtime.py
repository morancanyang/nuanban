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


arguments = sys.argv[sys.argv.index("--") + 1:]
if not arguments or len(arguments) > 2 or len(arguments) == 2 and arguments[1] != "--natural-v4":
    raise RuntimeError("Usage: export-lili-runtime.py -- OUTPUT [--natural-v4]")
natural_v4 = len(arguments) == 2
output = Path(arguments[0]).resolve()
output.mkdir(parents=True, exist_ok=True)
source = Path(bpy.data.filepath)
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
if natural_v4 and source_hash != "02a69fd97777769544955586eec861396438444e2a17fc89d67ab702d5d3351b":
    raise RuntimeError("Natural v4 export requires the reviewed Lili v4 source")
asset_id = "lili-natural-v4" if natural_v4 else "lili"
asset_version = "4.0.0-preview.2" if natural_v4 else "2.0.0"
character = next(collection for collection in bpy.context.scene.collection.children if collection.name.startswith("DEER_CHARACTER_ONLY"))
garment = next(collection for collection in character.children if collection.name.startswith("DEER_SCARF_KNIT"))
runtime = bpy.data.collections.new("MICROGLOW_DEER_RUNTIME")
bpy.context.scene.collection.children.link(runtime)
generator = np.random.default_rng(231026)
graph = bpy.context.evaluated_depsgraph_get()
objects = []


def principled(material):
    return next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")


def triangle_count(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def geometry_budget(name):
    budgets = [
        ("BODY_CONTINUOUS", 5500), ("HEAD_SCULPT", 4800),
        ("CREAM_MUZZLE", 1400), ("CREAM_BELLY", 1500),
        ("EAR_SHELL", 1500), ("EAR_INNER", 700),
        ("ANTLER_ORGANIC", 2000), ("AMBER_IRIS", 1600),
        ("CORNEA", 1100), ("EYE_GLOBE", 900), ("PUPIL", 650),
        ("SCARF_SOFT_CONTINUOUS", 2400), ("SCARF_DRAPED", 2500),
        ("SOFT_EYELID", 650), ("SOFT_FRINGE", 450),
        ("HOOF_SPLIT", 80), ("HOOF_", 600),
        ("NOSE", 750), ("TAIL", 650), ("CHEEK_TINT", 600),
    ]
    if natural_v4 and "LANTERN" in name:
        return 700 if any(marker in name for marker in ["BASE", "CHIMNEY", "CAP", "HANDLE"]) else 300
    return next((budget for marker, budget in budgets if marker in name), 160)


def is_knit(name):
    return "_KNIT_" in name or natural_v4 and "_TWISTED_WOOL_" in name


def ensure_uv(mesh):
    if mesh.uv_layers:
        return
    layer = mesh.uv_layers.new(name="RuntimeUV")
    positions = np.asarray([vertex.co[:] for vertex in mesh.vertices])
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0)
    center = (minimum + maximum) * 0.5
    height = max(maximum[2] - minimum[2], 0.00001)
    for polygon in mesh.polygons:
        coordinates = []
        for loop_index in polygon.loop_indices:
            position = positions[mesh.loops[loop_index].vertex_index]
            coordinates.append(((math.atan2(position[1] - center[1], position[0] - center[0]) / math.tau) % 1,
                                (position[2] - minimum[2]) / height))
        seam = max(value[0] for value in coordinates) - min(value[0] for value in coordinates) > 0.5
        for loop_index, coordinate in zip(polygon.loop_indices, coordinates):
            layer.data[loop_index].uv = (coordinate[0] + (1 if seam and coordinate[0] < 0.5 else 0), coordinate[1])


for original in list(character.all_objects):
    if original.type not in {"MESH", "CURVE"} or is_knit(original.name):
        continue
    if original.type == "CURVE":
        original.data.resolution_u = 3
        original.data.bevel_resolution = 1
    evaluated = original.evaluated_get(graph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=graph)
    duplicate = bpy.data.objects.new(original.name + "_RT", mesh)
    duplicate.matrix_world = original.matrix_world.copy()
    runtime.objects.link(duplicate)
    count = triangle_count(mesh)
    if count > geometry_budget(original.name):
        modifier = duplicate.modifiers.new("Runtime topology budget", "DECIMATE")
        modifier.ratio = geometry_budget(original.name) / count
        bpy.context.view_layer.objects.active = duplicate
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    ensure_uv(duplicate.data)
    duplicate["source_object"] = original.name
    objects.append(duplicate)


knit_stitches = 0
for original in garment.objects:
    if not is_knit(original.name):
        continue
    vertices, faces = [], []
    splines = list(original.data.splines)
    stride = 3 if natural_v4 and "_TWISTED_WOOL_" in original.name else 1
    for spline_index in range(0, len(splines), stride):
        spline = splines[spline_index]
        if stride == 3:
            coordinates = np.mean([[point.co[:3] for point in ply.points] for ply in splines[spline_index:spline_index + 3]], axis=0)
            points = [Vector(coordinates[index]) for index in np.linspace(0, len(coordinates) - 1, 5, dtype=int)]
        else:
            points = [point.co.copy() for point in spline.bezier_points]
        offset = len(vertices)
        for index, point in enumerate(points):
            tangent = (points[min(index + 1, len(points) - 1)] - points[max(index - 1, 0)]).normalized()
            outward = Vector((point.x / 0.425, point.y / 0.331, (point.z - 1.373) / 0.105)) if "COLLAR" in original.name else Vector((0, -1, 0))
            outward -= tangent * outward.dot(tangent)
            outward.normalize()
            sideways = tangent.cross(outward).normalized()
            radius = original.data.bevel_depth
            if natural_v4:
                radius *= 1.8 if stride == 3 else 1.3
                vertices.extend([tuple(point - sideways * radius), tuple(point + sideways * radius)])
            else:
                vertices.extend([tuple(point - sideways * radius), tuple(point + outward * radius), tuple(point + sideways * radius)])
        for index in range(len(points) - 1):
            if natural_v4:
                start = offset + index * 2
                faces.extend([(start, start + 2, start + 1), (start + 1, start + 2, start + 3)])
            else:
                start = offset + index * 3
                for rail in range(2):
                    faces.extend([(start + rail, start + rail + 3, start + rail + 1),
                                  (start + rail + 1, start + rail + 3, start + rail + 4)])
        knit_stitches += 1
    mesh = bpy.data.meshes.new(original.name + "_RUNTIME_MESH")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    mesh.materials.append(original.data.materials[0])
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    ensure_uv(mesh)
    duplicate = bpy.data.objects.new(original.name + "_RT", mesh)
    duplicate.matrix_world = original.matrix_world.copy()
    runtime.objects.link(duplicate)
    duplicate["source_object"] = original.name
    objects.append(duplicate)


def normal_texture(name, woven=False):
    size = 512
    horizontal, vertical = np.meshgrid(np.arange(size), np.arange(size))
    height = generator.normal(0, 0.16, (size, size))
    height = height * 0.2 + np.roll(height, 1, axis=0) * 0.3 + np.roll(height, 2, axis=0) * 0.3 + np.roll(height, 3, axis=0) * 0.2
    if woven:
        height += np.sin(horizontal * math.tau / 8) * np.cos(vertical * math.tau / 8) * 0.2
    gradient_vertical, gradient_horizontal = np.gradient(height)
    normals = np.stack((-gradient_horizontal * 4, -gradient_vertical * 4, np.ones_like(height)), axis=2)
    normals /= np.linalg.norm(normals, axis=2)[:, :, None]
    pixels = np.concatenate((normals * 0.5 + 0.5, np.ones((size, size, 1))), axis=2)
    image = bpy.data.images.new(name, width=size, height=size, alpha=False)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels.astype(np.float32).ravel())
    image.pack()
    return image


fur_normal = normal_texture("Lili short velvet fiber normal")
yarn_normal = normal_texture("Lili wool microfiber normal", woven=True)
grain = generator.normal(0, 0.17, (512, 512))
grain = grain * 0.4 + np.roll(grain, 1, axis=0) * 0.25 + np.roll(grain, 2, axis=0) * 0.2 + np.roll(grain, 3, axis=0) * 0.15
fiber_color = np.clip(1 + grain, 0.65, 1.2)
materials = {material for obj in objects for material in obj.data.materials if material}
for material in materials:
    if "iris" in material.name or "cheek tint" in material.name:
        continue
    shader = principled(material)
    if "wool" in material.name:
        shader.inputs["Sheen Tint"].default_value = (*[component * 0.15 for component in material.diffuse_color[:3]], 1)
    shader.inputs["Base Color"].default_value = material.diffuse_color
    for link in list(shader.inputs["Base Color"].links):
        material.node_tree.links.remove(link)
    if not any(marker in material.name for marker in ["undercoat", "ivory", "inner ear", "antler", "wool"]):
        continue
    nodes, links = material.node_tree.nodes, material.node_tree.links
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (6, 6, 1)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = yarn_normal if "wool" in material.name else fur_normal
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = 0.22 if "wool" in material.name else 0.32
    links.new(coordinates.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    links.new(texture.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    if any(marker in material.name for marker in ["undercoat", "ivory", "inner ear"]):
        pixels = np.ones((512, 512, 4), dtype=np.float32)
        linear_color = np.asarray(material.diffuse_color[:3]) * fiber_color[:, :, None]
        pixels[:, :, :3] = np.where(linear_color <= 0.0031308, linear_color * 12.92, 1.055 * linear_color ** (1 / 2.4) - 0.055)
        image = bpy.data.images.new(material.name + " fiber albedo", width=512, height=512, alpha=False)
        image.colorspace_settings.name = "Non-Color"
        image.pixels.foreach_set(pixels.ravel())
        image.pack()
        albedo = nodes.new("ShaderNodeTexImage")
        albedo.image = image
        links.new(mapping.outputs["Vector"], albedo.inputs["Vector"])
        links.new(albedo.outputs["Color"], shader.inputs["Base Color"])


iris_object = next(obj for obj in objects if "AMBER_IRIS" in obj.name)
iris = iris_object.data.materials[0]
iris_shader = principled(iris)
iris_color = iris_shader.inputs["Base Color"].links[0].from_socket
iris_output = next(node for node in iris.node_tree.nodes if node.type == "OUTPUT_MATERIAL")
emission = iris.node_tree.nodes.new("ShaderNodeEmission")
iris.node_tree.links.new(iris_color, emission.inputs["Color"])
iris.node_tree.links.new(emission.outputs[0], iris_output.inputs["Surface"])
iris_image = bpy.data.images.new("Lili original amber iris baked", width=1024, height=512, alpha=False)
iris_texture = iris.node_tree.nodes.new("ShaderNodeTexImage")
iris_texture.image = iris_image
iris.node_tree.nodes.active = iris_texture
bpy.ops.object.select_all(action="DESELECT")
iris_object.select_set(True)
bpy.context.view_layer.objects.active = iris_object
bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.samples = 1
bpy.context.scene.cycles.device = "CPU"
bpy.context.scene.render.bake.margin = 4
bpy.ops.object.bake(type="EMIT")
iris.node_tree.links.new(iris_shader.outputs[0], iris_output.inputs["Surface"])
iris.node_tree.links.new(iris_texture.outputs["Color"], iris_shader.inputs["Base Color"])
iris_image.pack()


for obj in objects:
    if "CHEEK_TINT" not in obj.name:
        continue
    layer = obj.data.color_attributes.new(name="CheekOpacity", type="FLOAT_COLOR", domain="POINT")
    fade = obj.data.attributes["CheekFade"]
    material = obj.data.materials[0]
    for color, value in zip(layer.data, fade.data):
        color.color = (*material.diffuse_color[:3], value.value)
    shader = principled(material)
    shader.inputs["Base Color"].default_value = (1, 1, 1, 1)
    attribute = material.node_tree.nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "CheekOpacity"
    material.node_tree.links.new(attribute.outputs["Color"], shader.inputs["Base Color"])
    material.node_tree.links.new(attribute.outputs["Alpha"], shader.inputs["Alpha"])


fur_material = bpy.data.materials.new("Lili original groom real-time fibers")
fur_material.use_nodes = True
fur_shader = principled(fur_material)
fur_shader.inputs["Roughness"].default_value = 0.92
fur_shader.inputs["Sheen Weight"].default_value = 0
attribute = fur_material.node_tree.nodes.new("ShaderNodeVertexColor")
attribute.layer_name = "GroomColor"
fur_material.node_tree.links.new(attribute.outputs["Color"], fur_shader.inputs["Base Color"])
base_count = sum(triangle_count(obj.data) for obj in objects)
fur_budget = min(22000, 98000 - base_count)
if fur_budget < 4000:
    raise RuntimeError("Insufficient groom budget: " + str(base_count))
grooms = list(next(collection for collection in character.children if collection.name.startswith("DEER_FILM_FUR")).objects)
total_strands = sum(len(obj.data.curves) for obj in grooms)
exported_strands = 0
for groom in grooms:
    count = max(1, int(fur_budget * len(groom.data.curves) / total_strands))
    selection = generator.choice(len(groom.data.curves), count, replace=False)
    coordinates = np.empty(len(groom.data.points) * 3, dtype=np.float32)
    groom.data.attributes["position"].data.foreach_get("vector", coordinates)
    strands = coordinates.reshape((-1, 5, 3))[selection]
    surface = bpy.data.objects[groom["source_mesh"]]
    tree = BVHTree.FromObject(surface, graph)
    inverse = surface.matrix_world.inverted()
    normal_matrix = inverse.to_3x3().transposed()
    hair_shader = next(node for node in groom.data.materials[0].node_tree.nodes if node.type == "BSDF_HAIR_PRINCIPLED")
    color = hair_shader.inputs["Color"].default_value[:3]
    vertices, faces, colors, normals = [], [], [], []
    for strand in strands:
        start, middle, end = [Vector(strand[index]) for index in (0, 2, 4)]
        normal = (normal_matrix @ tree.find_nearest(inverse @ start)[1]).normalized()
        width_axis = (end - start).cross(normal).normalized()
        if width_axis.length < 0.01:
            width_axis = normal.cross(Vector((0.36, 0.62, 0.7))).normalized()
        width = generator.uniform(0.00055, 0.00095)
        offset = len(vertices)
        vertices.extend([tuple(start - width_axis * width), tuple(start + width_axis * width), tuple(end)])
        faces.append((offset, offset + 1, offset + 2))
        shade = generator.uniform(0.85, 1.1)
        colors.extend([(*(min(component * shade, 1) for component in color), 1)] * 3)
        normals.extend([tuple(normal)] * 3)
    mesh = bpy.data.meshes.new(groom.name + "_RIBBONS")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    layer = mesh.color_attributes.new(name="GroomColor", type="FLOAT_COLOR", domain="POINT")
    layer.data.foreach_set("color", np.asarray(colors, dtype=np.float32).ravel())
    mesh.materials.append(fur_material)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.normals_split_custom_set_from_vertices(normals)
    duplicate = bpy.data.objects.new(groom.name + "_RT", mesh)
    runtime.objects.link(duplicate)
    duplicate["source_object"] = groom.name
    objects.append(duplicate)
    exported_strands += count


root = bpy.data.objects.new("Lili_Natural_v4_Deer" if natural_v4 else "Lili_Original_Blender_Deer", None)
runtime.objects.link(root)
root["character_id"] = asset_id if natural_v4 else "lili-original-v2"
root["source_blend_sha256"] = source_hash
root["asset_version"] = asset_version
for obj in objects:
    obj.parent = root
rig = runpy.run_path(str(Path(__file__).parent / "characters" / "rig-lili-natural.py"))["bind_natural_actions"](runtime, root, objects) if natural_v4 else None
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
if rig:
    rig.select_set(True)
for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
model_path = output / ("Lili_Natural_v4.glb" if natural_v4 else "Lili_Independent_Deer.glb")
bpy.ops.export_scene.gltf(
    filepath=str(model_path), export_format="GLB", use_selection=True,
    export_apply=not natural_v4, export_yup=True, export_cameras=False, export_lights=False,
    export_animations=natural_v4, export_skins=natural_v4, export_morph=natural_v4,
    export_animation_mode="NLA_TRACKS", export_force_sampling=True, export_anim_slide_to_zero=True,
    export_try_sparse_sk=False,
    export_extras=True, export_vertex_color="ACTIVE", export_image_format="AUTO",
)
data = model_path.read_bytes()
document = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
triangles = sum(document["accessors"][primitive["indices"]]["count"] // 3 for mesh in document["meshes"] for primitive in mesh["primitives"])
if triangles > 100000 or document.get("cameras") or not natural_v4 and (document.get("skins") or document.get("animations")):
    raise RuntimeError("Export violates the character-only runtime contract")
actions = [animation["name"] for animation in document.get("animations", [])]
bone_count = len({joint for skin in document.get("skins", []) for joint in skin["joints"]})
if natural_v4 and (bone_count != 18 or set(actions) != {"idle", "blink", "look", "wave", "nod"}):
    raise RuntimeError("Natural v4 skeletal and facial actions were not exported: " + str(actions))
if any("uri" in resource for resource in document.get("buffers", []) + document.get("images", [])):
    raise RuntimeError("Export contains external resources")
manifest = {
    "id": asset_id, "name": "栗栗 · Lili", "version": asset_version, "format": "glb",
    "fileName": model_path.name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
    "triangles": triangles, "meshes": len(document["meshes"]),
    "decodedMeshes": sum(len(mesh["primitives"]) for mesh in document["meshes"]),
    "bones": bone_count, "animations": len(actions), "textures": len(document.get("textures", [])),
    "background": False, "externalResources": False,
    "source": {"file": source.name, "sha256": source_hash, "scene": bpy.context.scene.name},
    "createdVia": "Local Blender source-scene export (scripts/export-lili-runtime.py)",
    "runtime": {"renderer": "glb", "geometrySource": "Original Blender character and scarf, not a procedural replacement",
                "knitStitches": knit_stitches, "sourceGroomStrands": total_strands, "groomStrands": exported_strands,
                "posterPurpose": "Original offline reference render; not the 3D display source",
                "limitations": ([] if natural_v4 else ["Static model: no skeletal rig or facial animation."]) + [
                                "Original hair is sampled into mesh fibers; procedural shading is adapted to embedded textures, not exported losslessly."]},
    "parts": [{"name": obj["source_object"], "triangles": triangle_count(obj.data)} for obj in objects],
}
if natural_v4:
    manifest["actions"] = [{"name": animation["name"], "loop": animation["name"] == "idle"} for animation in document["animations"]]
    manifest["status"] = "candidate"
    manifest["runtime"]["mobileTested"] = False
    manifest["runtime"]["limitations"].extend([
        "Three-ply collar yarn is reduced to stitch ribbons; Cycles lighting is not part of the runtime model.",
        "Mobile performance and Android floating-pet integration have not been verified.",
    ])
(output / "character_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("LILI_RUNTIME_EXPORT_COMPLETE " + json.dumps({key: manifest[key] for key in ["sha256", "bytes", "triangles", "meshes", "decodedMeshes", "textures"]}), flush=True)
