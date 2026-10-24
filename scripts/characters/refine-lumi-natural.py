import argparse
import hashlib
import json
import math
import runpy
from pathlib import Path
from types import SimpleNamespace

import bpy
import bmesh
import numpy as np
from mathutils import Vector


REVISION = "lumi-natural-20261024-v4"
SOURCE_REVISION = "reference-20261024-v3"
VIEWS = ("hero", "front", "side", "back", "detail", "grip")
ROOT = Path(__file__).resolve().parents[2]
HELPERS = SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name("refine-reference-characters.py"))))
GENERATOR = np.random.default_rng(20261024)


def remove_objects(names):
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj:
            bpy.data.objects.remove(obj, do_unlink=True)


def original_material(fragment):
    return next(surface for surface in bpy.data.materials if fragment in surface.name and surface.users)


def front_surface(horizontal, height, objects):
    intersections = []
    for obj in objects:
        inverse = obj.matrix_world.inverted()
        hit, coordinate, normal, face_index = obj.ray_cast(
            inverse @ Vector((horizontal, -3, height)), inverse.to_3x3() @ Vector((0, 1, 0)))
        if hit:
            intersections.append((obj.matrix_world @ coordinate).y)
    if not intersections:
        raise ValueError(f"No face surface at {horizontal}, {height}")
    return min(intersections)


def tapered_curve(name, coordinates, radius, surface, collection, widths=None):
    obj = HELPERS.curve_object(name, coordinates, radius, surface, collection)
    points = obj.data.splines[0].bezier_points
    for point, width in zip(points, widths or np.linspace(1, 0.04, len(points))):
        point.radius = float(width)
    obj.data.resolution_u = 20
    return obj


def groom_surface(obj, count, length, surface, collection, direction=(0, 0.2, -0.8), staff=None):
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    positions = np.asarray([vertex.co[:] for vertex in mesh.vertices], dtype=np.float64)
    normals = np.asarray([vertex.normal[:] for vertex in mesh.vertices], dtype=np.float64)
    triangles = np.asarray([triangle.vertices[:] for triangle in mesh.loop_triangles])
    triangle_positions = positions[triangles]
    areas = np.linalg.norm(np.cross(triangle_positions[:, 1] - triangle_positions[:, 0],
                                    triangle_positions[:, 2] - triangle_positions[:, 0]), axis=1)
    selected = triangles[GENERATOR.choice(len(triangles), size=count, p=areas / areas.sum())]
    first, second = np.sqrt(GENERATOR.random(count)), GENERATOR.random(count)
    weights = np.column_stack((1 - first, first * (1 - second), first * second))
    roots = (positions[selected] * weights[:, :, None]).sum(axis=1)
    root_normals = (normals[selected] * weights[:, :, None]).sum(axis=1)
    matrix = np.asarray(obj.matrix_world)
    roots = roots @ matrix[:3, :3].T + matrix[:3, 3]
    root_normals = root_normals @ np.linalg.inv(matrix[:3, :3])
    root_normals /= np.maximum(1e-9, np.linalg.norm(root_normals, axis=1))[:, None]
    if staff:
        center, axis = (np.asarray(value, dtype=float) for value in staff)
        offset = roots - center
        distance = np.linalg.norm(offset - np.outer(offset @ axis, axis), axis=1)
        mask = distance > 0.032
        roots, root_normals = roots[mask], root_normals[mask]
    count = len(roots)
    flow = np.tile(np.asarray(direction, dtype=float), (count, 1))
    tangent = flow - root_normals * (flow * root_normals).sum(axis=1)[:, None]
    tangent /= np.maximum(1e-9, np.linalg.norm(tangent, axis=1))[:, None]
    lengths = length * np.clip(GENERATOR.normal(1, 0.16, count), 0.6, 1.4)
    steps = np.linspace(0, 1, 5)[None, :, None]
    points = (roots[:, None] + root_normals[:, None] * lengths[:, None, None] * steps * 0.7
              + tangent[:, None] * lengths[:, None, None] * steps ** 1.7 * 0.7)
    data = bpy.data.hair_curves.new(obj.name + "_NATURAL_GROOM")
    data.add_curves([5] * count)
    data.attributes["position"].data.foreach_set("vector", points.astype(np.float32).ravel())
    widths = GENERATOR.uniform(0.00026, 0.00040, count)
    radii = widths[:, None] * np.array([0.8, 1, 0.7, 0.35, 0.025])[None, :]
    data.attributes.new("radius", "FLOAT", "POINT").data.foreach_set("value", radii.astype(np.float32).ravel())
    groom = bpy.data.objects.new(obj.name + "_FUR", data)
    collection.objects.link(groom)
    data.materials.append(surface)
    groom["source_surface"] = obj.name
    evaluated.to_mesh_clear()
    return groom


def eye_dome(name, center, width, height, depth, surface, collection, polar_uv=False):
    segments, rows = 128, 20
    vertices = [tuple(center)]
    for row in range(1, rows + 1):
        radial = row / rows
        for segment in range(segments):
            angle = math.tau * segment / segments
            vertices.append((center[0] + width * radial * math.sin(angle),
                             center[1] + depth * radial ** 2,
                             center[2] + height * radial * math.cos(angle)))
    faces = [(0, 1 + (segment + 1) % segments, 1 + segment) for segment in range(segments)]
    for row in range(rows - 1):
        for segment in range(segments):
            current = 1 + row * segments + segment
            following = 1 + row * segments + (segment + 1) % segments
            faces.append((current, following, following + segments, current + segments))
    obj = HELPERS.mesh_object(name, vertices, faces, surface, collection)
    if polar_uv:
        layer = obj.data.uv_layers.new(name="PolarIrisUV")
        for polygon in obj.data.polygons:
            segment_indices = [(obj.data.loops[index].vertex_index - 1) % segments
                               for index in polygon.loop_indices if obj.data.loops[index].vertex_index]
            seam = 0 in segment_indices and segments - 1 in segment_indices
            for index in polygon.loop_indices:
                vertex_index = obj.data.loops[index].vertex_index
                angular = ((vertex_index - 1) % segments) / segments if vertex_index else 0
                if seam and angular == 0:
                    angular = 1
                radial = (((vertex_index - 1) // segments) + 1) / rows if vertex_index else 0
                layer.data[index].uv = (angular, radial)
    return obj


def refine_eyes(character, fur_collection):
    cream = original_material("warm ivory undercoat")
    fur = original_material("groom ivory strands")
    sclera = original_material("warm ivory sclera")
    shader = sclera.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*HELPERS.linear_color((0.82, 0.81, 0.71)), 1)
    shader.inputs["Roughness"].default_value = 0.32
    iris = original_material("radial blue iris fibers")
    iris.node_tree.nodes.get("Principled BSDF").inputs["Coat Weight"].default_value = 0.08
    ramp = next(node.color_ramp for node in iris.node_tree.nodes if node.type == "VALTORGB")
    for element, color in zip(ramp.elements, [(0.045, 0.20, 0.24), (0.085, 0.38, 0.43),
                                             (0.18, 0.57, 0.59), (0.37, 0.72, 0.70), (0.15, 0.44, 0.49)]):
        element.color = (*HELPERS.linear_color(color), 1)
    limbal = original_material("deep blue limbal rings")
    pupil = original_material("deep blue vertical pupils")
    cornea = original_material("clear tear film cornea")
    cornea_shader = cornea.node_tree.nodes.get("Principled BSDF")
    cornea_shader.inputs["Roughness"].default_value = 0.045
    cornea_shader.inputs["Thin Wall"].default_value = True
    lash = HELPERS.material("LUMI V4 | quiet blue grey lash roots", (0.20, 0.27, 0.27), 0.8)
    brow = HELPERS.material("LUMI V4 | velvet blue grey brows", (0.19, 0.27, 0.29), 0.86)
    head = bpy.data.objects["CAT_HEAD_sculpted_cheeks"]
    for side, direction in (("L", -1), ("R", 1)):
        prefix = "CAT_EYE_" + side
        remove_objects([prefix + suffix for suffix in ("_sclera", "_iris", "_limbal_ring",
                       "_vertical_pupil", "_corneal_shell")] + ["CAT_EYELID_" + side + suffix
                       for suffix in ("_upper", "_lower")] + ["CAT_BROW_" + side + "_subtle"])
        center_x, center_z = direction * 0.266, 2.31
        HELPERS.ellipsoid(prefix + "_sclera", (center_x, -0.418, center_z), (0.177, 0.100, 0.222), sclera, character)
        eye_dome(prefix + "_iris", (center_x + 0.003, -0.539, center_z - 0.003),
                 0.149, 0.187, 0.023, iris, character, True)
        eye_dome(prefix + "_soft_open_pupil", (center_x + 0.003, -0.546, center_z - 0.003),
                 0.087, 0.122, 0.008, pupil, character)
        eye_dome(prefix + "_corneal_shell", (center_x + 0.003, -0.558, center_z - 0.003),
                 0.153, 0.191, 0.034, cornea, character)
        HELPERS.curve_object(prefix + "_limbal_ring", [
            (center_x + 0.003 + 0.149 * math.sin(angle), -0.5165,
             center_z - 0.003 + 0.187 * math.cos(angle))
            for angle in np.linspace(0, math.tau, 96, endpoint=False)], 0.0024, limbal, character, True)
        def fit_orbit(coordinates):
            result = coordinates.copy()
            horizontal = coordinates[:, 0] - center_x
            depth = coordinates[:, 1] + 0.045 + 0.47
            angle = direction * 0.24
            result[:, 0] = center_x + horizontal * math.cos(angle) - depth * math.sin(angle)
            result[:, 1] = -0.47 + horizontal * math.sin(angle) + depth * math.cos(angle)
            return result
        for obj in list(character.all_objects):
            if obj.name.startswith(prefix):
                HELPERS.deform_object(obj, fit_orbit)
        segments, rows = 128, 7
        vertices, faces = [], []
        for row in range(rows + 1):
            blend = row / rows
            for segment in range(segments):
                angle = math.tau * segment / segments
                inner = fit_orbit(np.array([[center_x + 0.166 * math.sin(angle), -0.514,
                                           center_z + 0.204 * math.cos(angle) - 0.006 * math.sin(angle) ** 2]]))[0]
                outer = fit_orbit(np.array([[center_x + 0.218 * math.sin(angle), -0.514,
                                           center_z + 0.257 * math.cos(angle)]]))[0]
                outer[1] = front_surface(outer[0], outer[2], [head]) + 0.002
                smooth_blend = blend * blend * (3 - 2 * blend)
                point = inner * (1 - smooth_blend) + outer * smooth_blend
                vertices.append(tuple(point))
        for row in range(rows):
            for segment in range(segments):
                current = row * segments + segment
                following = row * segments + (segment + 1) % segments
                faces.append((current, following, following + segments, current + segments))
        lid = HELPERS.mesh_object("CAT_EYELID_" + side + "_integrated_fur_rim", vertices, faces, cream, character)
        groom_surface(lid, 10000, 0.0080, fur, fur_collection, (direction * 0.3, 0, 0.4))
        coordinates = [(center_x + 0.166 * math.sin(angle), -0.516,
                        center_z + 0.204 * math.cos(angle) - 0.006 * math.sin(angle) ** 2)
                       for angle in np.linspace(-1.28, 1.28, 9)]
        crease = tapered_curve("CAT_EYELID_" + side + "_soft_upper_crease", coordinates, 0.0026, lash, character,
                      [0.05, 0.5, 0.8, 1, 1, 1, 0.8, 0.5, 0.05])
        HELPERS.deform_object(crease, fit_orbit)
        coordinates = []
        for fraction in np.linspace(-1, 1, 7):
            horizontal = center_x + fraction * 0.080
            height = 2.635 + 0.028 * (1 - fraction ** 2) + direction * fraction * 0.008
            coordinates.append((horizontal, front_surface(horizontal, height, [head]) - 0.008, height))
        tapered_curve("CAT_BROW_" + side + "_soft_tapered", coordinates, 0.0065, brow, character,
                      [0.08, 0.65, 0.95, 1, 0.9, 0.55, 0.06])


def refine_muzzle(character):
    for name in ("CAT_MUZZLE_L", "CAT_MUZZLE_R", "CAT_CHIN"):
        def soften(coordinates):
            result = coordinates.copy()
            chin = name == "CAT_CHIN"
            result[:, 0] *= 0.88 if chin else 0.97
            result[:, 1] = -0.423 + (result[:, 1] + 0.423) * 0.65 + 0.058 if chin else -0.446 + (result[:, 1] + 0.457) * 0.62
            center_z = 1.89 if chin else 2.005
            result[:, 2] = center_z + (result[:, 2] - center_z) * (0.60 if chin else 0.80)
            return result
        HELPERS.deform_object(bpy.data.objects[name], soften)
        HELPERS.deform_object(bpy.data.objects[name + "_FUR"], soften)
    remove_objects(["CAT_NOSE", "CAT_PHILTRUM", "CAT_SMILE_L", "CAT_SMILE_R"] +
                   [f"CAT_WHISKER_{side}_{index}" for side in ("L", "R") for index in range(3)])
    pink = HELPERS.material("LUMI V4 | soft rose nose", (0.74, 0.39, 0.42), 0.46)
    pink.node_tree.nodes.get("Principled BSDF").inputs["Subsurface Weight"].default_value = 0.07
    outline = [(-0.063, 2.084), (-0.036, 2.101), (0.036, 2.101), (0.063, 2.084), (0, 2.031)]
    vertices = [(horizontal, depth, height) for depth in (-0.566, -0.490) for horizontal, height in outline]
    faces = [tuple(reversed(range(5))), tuple(range(5, 10))]
    faces.extend((index, (index + 1) % 5, (index + 1) % 5 + 5, index + 5) for index in range(5))
    nose = HELPERS.mesh_object("CAT_NOSE_soft_triangle", vertices, faces, pink, character)
    bevel = nose.modifiers.new("Soft fleshy nose corners", "BEVEL")
    bevel.width, bevel.segments = 0.014, 5
    cocoa = HELPERS.material("LUMI V4 | subtle cocoa smile", (0.31, 0.23, 0.20), 0.8)
    face = [bpy.data.objects[name] for name in ("CAT_HEAD_sculpted_cheeks", "CAT_MUZZLE_L", "CAT_MUZZLE_R", "CAT_CHIN")]
    bpy.context.view_layer.update()
    tapered_curve("CAT_PHILTRUM_soft", [(0, -0.553, 2.042), (0, front_surface(0, 2.022, face) - 0.003, 2.022),
                  (0, front_surface(0, 2.002, face) - 0.003, 2.002)], 0.0034, cocoa, character, [0.5, 0.8, 0.9])
    whisker = original_material("soft cream muzzle and chest")
    for side, direction in (("L", -1), ("R", 1)):
        coordinates = []
        for horizontal, height in ((0, 2.002), (0.036, 1.981), (0.080, 1.983), (0.118, 2.003)):
            horizontal *= direction
            coordinates.append((horizontal, front_surface(horizontal, height, face) - 0.0034, height))
        tapered_curve("CAT_SMILE_" + side + "_soft", coordinates, 0.0042, cocoa, character, [0.9, 1, 0.8, 0.1])
        for index, height in enumerate((2.034, 1.990, 1.953)):
            root = (direction * 0.221, front_surface(direction * 0.221, height, face) - 0.003, height)
            coordinates = [root, (direction * 0.43, -0.546, height + (1 - index) * 0.032),
                           (direction * (0.645 - index * 0.020), -0.521, height + (1 - index) * 0.068)]
            tapered_curve(f"CAT_WHISKER_{side}_{index}", coordinates, 0.00135, whisker, character, [0.6, 0.8, 0.025])


def blend_face(character, fur_collection):
    names = ("CAT_HEAD_sculpted_cheeks", "CAT_MUZZLE_L", "CAT_MUZZLE_R", "CAT_CHIN")
    remove_objects([name + "_FUR" for name in names])
    head = bpy.data.objects[names[0]]
    bpy.ops.object.select_all(action="DESELECT")
    for name in names:
        bpy.data.objects[name].select_set(True)
    bpy.context.view_layer.objects.active = head
    bpy.ops.object.join()
    remesh = head.modifiers.new("Continuous soft cheek and muzzle sculpt", "REMESH")
    remesh.mode, remesh.voxel_size = "VOXEL", 0.006
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = head.modifiers.new("Blend muzzle transitions", "SMOOTH")
    smooth.factor, smooth.iterations = 0.7, 9
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    head.data.materials.clear()
    head.data.materials.append(original_material("warm ivory undercoat"))
    for polygon in head.data.polygons:
        polygon.use_smooth = True
    groom_surface(head, 92000, 0.013, original_material("groom ivory strands"), fur_collection, (0, 0.1, -0.5))


def refine_grip(character, fur_collection):
    remove_objects(["CAT_PAW_R_grip", "CAT_PAW_R_grip_FUR", "CAT_PAW_R_thumb", "CAT_PAW_R_wand_contact_fingers"])
    surface = original_material("soft cream muzzle and chest")
    fur = original_material("groom pale strands")
    center = Vector((0.904, -0.475, 1.345))
    axis = Vector((0.38, 0, 1.28)).normalized()
    across = Vector((axis.z, 0, -axis.x))
    palm = HELPERS.ellipsoid("CAT_PAW_R_grip", center - across * 0.053 + Vector((0, 0.056, 0)),
                             (0.123, 0.092, 0.145), surface, character)
    pieces = [palm]
    for index, along in enumerate((-0.052, 0, 0.052)):
        origin = center + axis * along
        coordinates = [origin - across * 0.080 + Vector((0, 0.017, 0)),
                       origin - across * 0.030 + Vector((0, -0.048, 0)),
                       origin + across * 0.025 + Vector((0, -0.047, 0)),
                       origin + across * 0.057 + Vector((0, -0.005, 0))]
        digit = tapered_curve(f"CAT_PAW_R_curled_digit_{index}", coordinates, 0.028, surface, character, [1, 1, 0.93, 0.7])
        digit.data.use_fill_caps = True
        pieces.append(digit)
    thumb = tapered_curve("CAT_PAW_R_opposable_soft_thumb", [
        center - across * 0.090 + axis * 0.085 + Vector((0, 0.006, 0)),
        center - across * 0.051 + axis * 0.055 + Vector((0, -0.055, 0)),
        center + across * 0.002 + axis * 0.045 + Vector((0, -0.059, 0))],
        0.037, surface, character, [1.05, 1, 0.70])
    pieces.append(thumb)
    thumb.data.use_fill_caps = True
    bpy.ops.object.select_all(action="DESELECT")
    for obj in pieces:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = palm
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.join()
    remesh = palm.modifiers.new("Continuous rounded paw sculpt", "REMESH")
    remesh.mode, remesh.voxel_size = "VOXEL", 0.0045
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = palm.modifiers.new("Soft knuckle transitions", "SMOOTH")
    smooth.factor, smooth.iterations = 0.6, 5
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    wand = bpy.data.objects["CAT_WAND_indigo_shaft"]
    channel_curve = wand.copy()
    channel_curve.data = wand.data.copy()
    channel_curve.data.bevel_depth *= 1.12
    character.objects.link(channel_curve)
    bpy.context.view_layer.update()
    evaluated = channel_curve.evaluated_get(bpy.context.evaluated_depsgraph_get())
    channel = bpy.data.objects.new("TEMP_WAND_CLEARANCE", bpy.data.meshes.new_from_object(evaluated))
    character.objects.link(channel)
    channel.matrix_world = channel_curve.matrix_world.copy()
    bpy.context.view_layer.objects.active = palm
    cut = palm.modifiers.new("Fitted wand clearance", "BOOLEAN")
    cut.operation, cut.solver, cut.object = "DIFFERENCE", "EXACT", channel
    bpy.ops.object.modifier_apply(modifier=cut.name)
    bpy.data.objects.remove(channel, do_unlink=True)
    bpy.data.objects.remove(channel_curve, do_unlink=True)
    edge = palm.modifiers.new("Soft contact edge", "BEVEL")
    edge.width, edge.segments = 0.0015, 3
    bpy.ops.object.modifier_apply(modifier=edge.name)
    mesh = bmesh.new()
    mesh.from_mesh(palm.data)
    unseen = set(mesh.verts)
    components = []
    while unseen:
        pending = [unseen.pop()]
        connected = set(pending)
        while pending:
            vertex = pending.pop()
            for edge in vertex.link_edges:
                other = edge.other_vert(vertex)
                if other in unseen:
                    unseen.remove(other)
                    connected.add(other)
                    pending.append(other)
        components.append(connected)
    components.sort(key=len, reverse=True)
    if len(components) > 1:
        bmesh.ops.delete(mesh, geom=[vertex for component in components[1:] for vertex in component], context="VERTS")
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(palm.data)
    mesh.free()
    for polygon in palm.data.polygons:
        polygon.use_smooth = True
    palm["anatomical_side"] = "left; viewer right; inherited mesh suffix R is screen-side naming"
    palm["grip_clearance_radius"] = wand.data.bevel_depth * 1.12
    groom_surface(palm, 8000, 0.004, fur, fur_collection, (0.3, 0, -0.5), (center, axis))


def woven_material(surface, dark, light):
    nodes, links = surface.node_tree.nodes, surface.node_tree.links
    nodes.clear()
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Specular IOR Level"].default_value = 0.24
    shader.inputs["Sheen Weight"].default_value = 0.26
    shader.inputs["Sheen Roughness"].default_value = 0.80
    shader.inputs["Sheen Tint"].default_value = (*HELPERS.linear_color((0.70, 0.49, 0.66)), 1)
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    coordinates = nodes.new("ShaderNodeTexCoord")
    variation = nodes.new("ShaderNodeTexNoise")
    variation.inputs["Scale"].default_value = 5.0
    variation.inputs["Detail"].default_value = 2
    links.new(coordinates.outputs["Object"], variation.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.15
    ramp.color_ramp.elements[0].color = (*HELPERS.linear_color(dark), 1)
    ramp.color_ramp.elements[1].position = 0.85
    ramp.color_ramp.elements[1].color = (*HELPERS.linear_color(light), 1)
    links.new(variation.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
    waves = []
    for direction in ("X", "Z"):
        wave = nodes.new("ShaderNodeTexWave")
        wave.wave_type, wave.bands_direction = "BANDS", direction
        wave.inputs["Scale"].default_value = 210
        wave.inputs["Distortion"].default_value = 0.22
        links.new(coordinates.outputs["Object"], wave.inputs["Vector"])
        waves.append(wave)
    weave = nodes.new("ShaderNodeMath")
    weave.operation = "MULTIPLY"
    for index, wave in enumerate(waves):
        links.new(wave.outputs["Fac"], weave.inputs[index])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.32
    bump.inputs["Distance"].default_value = 0.00032
    links.new(weave.outputs[0], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    roughness = nodes.new("ShaderNodeMapRange")
    roughness.inputs["To Min"].default_value = 0.80
    roughness.inputs["To Max"].default_value = 0.91
    links.new(variation.outputs["Fac"], roughness.inputs["Value"])
    links.new(roughness.outputs["Result"], shader.inputs["Roughness"])


def refine_costume(character):
    cloth = original_material("amethyst woven cloak")
    lining = original_material("dusky lilac cloak lining")
    woven_material(cloth, (0.40, 0.087, 0.36), (0.49, 0.13, 0.44))
    woven_material(lining, (0.49, 0.24, 0.40), (0.56, 0.30, 0.47))
    for obj in list(character.all_objects):
        if not obj.name.startswith("CAT_CLOAK_") or "collar" in obj.name:
            continue
        def drape(coordinates):
            result = coordinates.copy()
            height = np.clip((1.62 - coordinates[:, 2]) / 1.28, 0, 1)
            angle = np.arctan2(coordinates[:, 0], coordinates[:, 1])
            displacement = 0.007 * height ** 1.5 * np.sin(angle * 7 + coordinates[:, 2] * 3)
            result[:, 0] += np.sin(angle) * displacement
            result[:, 1] += np.cos(angle) * displacement
            result[:, 2] -= height ** 3 * 0.007 * (0.5 + 0.5 * np.sin(angle * 3 + 0.3))
            return result
        HELPERS.deform_object(obj, drape)
    gold = original_material("embroidered golden thread")
    for side, direction in (("L", -1), ("R", 1)):
        remove_objects([f"CAT_CLOAK_{side}_soft_folded_collar", f"CAT_CLOAK_{side}_collar_stitch"])
        def collar_point(along, across):
            upper = 1.68 + 0.035 * math.sin(math.pi * along) - 0.018 * along
            lower = 1.576 + 0.046 * along + 0.035 * math.sin(math.pi * along)
            return (direction * (0.065 + 0.40 * along + 0.012 * math.sin(math.pi * along) * across),
                    -0.317 + 0.11 * along - 0.042 * math.sin(math.pi * across) - 0.020 * across,
                    upper * (1 - across) + lower * across)
        columns, rows = 24, 10
        vertices = [collar_point(column / columns, row / rows)
                    for column in range(columns + 1) for row in range(rows + 1)]
        faces = []
        for column in range(columns):
            for row in range(rows):
                current = column * (rows + 1) + row
                face = (current, current + 1, current + rows + 2, current + rows + 1)
                faces.append(face if direction == 1 else tuple(reversed(face)))
        collar = HELPERS.mesh_object(f"CAT_CLOAK_{side}_soft_folded_collar", vertices, faces, cloth, character)
        collar.data.materials.append(lining)
        subdivision = collar.modifiers.new("Soft fabric fold", "SUBSURF")
        subdivision.levels = subdivision.render_levels = 2
        thickness = collar.modifiers.new("Folded fabric thickness", "SOLIDIFY")
        thickness.thickness, thickness.material_offset = 0.006, 1
        for stitch_index in range(23):
            start = stitch_index / 23
            points = [collar_point(start + offset, 0.89) for offset in (0.005, 0.025)]
            points = [(point[0], point[1] - 0.004, point[2]) for point in points]
            tapered_curve(f"CAT_CLOAK_{side}_collar_stitch_{stitch_index:02}", points,
                          0.0012, gold, character, [0.8, 0.8])
    for surface in bpy.data.materials:
        if not surface.users or not surface.use_nodes:
            continue
        shader = surface.node_tree.nodes.get("Principled BSDF")
        if shader and "leather" in surface.name.lower():
            shader.inputs["Roughness"].default_value = 0.76
            shader.inputs["Specular IOR Level"].default_value = 0.28
        if shader and "gold" in surface.name.lower():
            shader.inputs["Roughness"].default_value = max(shader.inputs["Roughness"].default_value, 0.32)


def refine_ears(character, fur_collection):
    pink = original_material("translucent rose inner ear")
    shader = pink.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = 0.79
    shader.inputs["Subsurface Weight"].default_value = 0.085
    shader.inputs["Subsurface Scale"].default_value = 0.012
    shader.inputs["Base Color"].default_value = (*HELPERS.linear_color((0.78, 0.49, 0.47)), 1)
    for side, direction in (("L", -1), ("R", 1)):
        obj = bpy.data.objects[f"CAT_EAR_{side}_rose_inset"]
        def cup(coordinates):
            result = coordinates.copy()
            weight = np.exp(-((coordinates[:, 0] - direction * 0.49) / 0.09) ** 2
                            - ((coordinates[:, 2] - 2.93) / 0.14) ** 2)
            result[:, 1] += 0.022 * weight
            return result
        HELPERS.deform_object(obj, cup)
        groom_surface(obj, 650, 0.004, original_material("groom pale strands"), fur_collection, (0, 0, 1))
    remove_objects([obj.name for obj in character.all_objects if obj.name.startswith("CAT_FOREHEAD_soft_tuft_")])
    head = bpy.data.objects["CAT_HEAD_sculpted_cheeks"]
    inverse = head.matrix_world.inverted()
    roots = []
    for horizontal, depth in GENERATOR.normal((0, -0.035), (0.027, 0.018), (240, 2)):
        hit, coordinate, normal, face_index = head.ray_cast(
            inverse @ Vector((horizontal, depth, 3.5)), inverse.to_3x3() @ Vector((0, 0, -1)))
        if hit:
            roots.append((head.matrix_world @ coordinate)[:])
    roots = np.asarray(roots)
    steps = np.linspace(0, 1, 5)[None, :, None]
    lengths = GENERATOR.uniform(0.023, 0.043, len(roots))
    upward = np.array((0, 0, 1))[None, None, :]
    lean = np.array((-0.020, -0.012, -0.010))[None, None, :]
    points = roots[:, None, :] + upward * lengths[:, None, None] * steps + lean * steps ** 2
    data = bpy.data.hair_curves.new("CAT_FOREHEAD_natural_tuft_GROOM")
    data.add_curves([5] * len(roots))
    data.attributes["position"].data.foreach_set("vector", points.astype(np.float32).ravel())
    radii = np.tile(np.array((0.00027, 0.00032, 0.00025, 0.00012, 0.00001)), len(roots))
    data.attributes.new("radius", "FLOAT", "POINT").data.foreach_set("value", radii)
    tuft = bpy.data.objects.new("CAT_FOREHEAD_natural_tuft_FUR", data)
    fur_collection.objects.link(tuft)
    data.materials.append(original_material("groom ivory strands"))
    tuft["source_surface"] = head.name


def setup_review(scene, studio):
    for obj in studio.objects:
        if obj.type != "LIGHT":
            continue
        obj.visible_glossy = "EYE_REFLECTION" in obj.name
        if "WARM_KEY" in obj.name:
            obj.data.color = (1, 0.91, 0.79)
            obj.data.specular_factor = 0.10
        elif "COOL_FILL" in obj.name:
            obj.data.specular_factor = 0.08
        elif "FUR_RIM" in obj.name:
            obj.data.energy = 460
            obj.data.specular_factor = 0.02
        elif "EYE_REFLECTION" in obj.name:
            obj.data.size, obj.data.energy = 0.65, 26
            obj.data.specular_factor = 1
        else:
            obj.data.specular_factor = 0.08
    scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.16
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.film_transparent = True
    scene.render.image_settings.color_depth = "16"
    scene.render.image_settings.color_mode = "RGBA"
    scene.cycles.adaptive_threshold = 0.010
    scene.cycles.samples = 192
    preferences = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            preferences.compute_device_type = backend
            preferences.get_devices()
            if any(device.type == backend for device in preferences.devices):
                for device in preferences.devices:
                    device.use = device.type == backend
                scene.cycles.device = "GPU"
                break
        except (RuntimeError, TypeError):
            continue
    camera_data = bpy.data.cameras.new("REFERENCE_CAMERA_grip")
    camera_data.type, camera_data.ortho_scale = "ORTHO", 0.72
    camera = bpy.data.objects.new(camera_data.name, camera_data)
    studio.objects.link(camera)
    target = Vector((0.886, -0.43, 1.38))
    camera.location = target + Vector((1.2, -6, 0.65))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def validate_scene(scene, character):
    outside = [obj.name for obj in scene.objects if obj.type in {"MESH", "CURVE", "CURVES"}
               and obj.name not in character.all_objects]
    if outside or any(obj.type == "ARMATURE" for obj in scene.objects):
        raise ValueError("Expected one isolated static character without background geometry or an armature")
    result = {}
    for name in ("CAT_HEAD_sculpted_cheeks", "CAT_PAW_R_grip"):
        obj = bpy.data.objects[name]
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        unseen, components = set(mesh.verts), 0
        while unseen:
            pending = [unseen.pop()]
            components += 1
            while pending:
                vertex = pending.pop()
                for edge in vertex.link_edges:
                    other = edge.other_vert(vertex)
                    if other in unseen:
                        unseen.remove(other)
                        pending.append(other)
        non_manifold = sum(not edge.is_manifold for edge in mesh.edges)
        volume = mesh.calc_volume(signed=True)
        result[name] = {"vertices": len(mesh.verts), "faces": len(mesh.faces), "components": components,
                        "nonManifoldEdges": non_manifold, "positiveVolume": volume > 0}
        mesh.free()
        if components != 1 or non_manifold or volume <= 0:
            raise ValueError(f"Disconnected, open or inverted sculpt: {name}")
    return result


def main():
    parser = argparse.ArgumentParser(description="Refine the static Lumi v3 candidate through the local Blender MCP addon")
    parser.add_argument("--output", type=Path, default=ROOT / "work/lumi-natural-v4")
    parser.add_argument("--size", type=int, default=2400)
    parser.add_argument("--samples", type=int, default=192)
    parser.add_argument("--views", nargs="+", choices=VIEWS, default=list(VIEWS))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--render-only", action="store_true")
    parser.add_argument("--draft", action="store_true")
    arguments = parser.parse_args()
    if arguments.prepare_only and arguments.render_only:
        parser.error("Choose prepare-only or render-only")
    if not 256 <= arguments.size <= 8192 or not 1 <= arguments.samples <= 4096:
        parser.error("Invalid resolution or sample count")
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = Path(bpy.data.filepath).resolve(strict=True)
    target = output / "lumi-natural-v4.blend"
    manifest_path = output / "candidate-manifest.json"
    scene = bpy.context.scene
    character = bpy.data.collections["MICROGLOW_CAT_ONLY"]
    bpy.context.preferences.filepaths.save_version = 0
    if arguments.render_only:
        if scene.get("natural_revision") != REVISION or source != target:
            raise RuntimeError("Render-only requires the saved natural-v4 candidate")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if hashlib.sha256(target.read_bytes()).hexdigest() != manifest["blendSha256"]:
            raise RuntimeError("Saved candidate differs from its manifest")
    else:
        if source == target or scene.get("natural_revision") or scene.get("reference_revision") != SOURCE_REVISION:
            raise RuntimeError("Start from the unmodified reference-v3 Lumi candidate")
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        fur_collection = bpy.data.objects["CAT_HEAD_sculpted_cheeks_FUR"].users_collection[0]
        refine_muzzle(character)
        blend_face(character, fur_collection)
        refine_eyes(character, fur_collection)
        refine_grip(character, fur_collection)
        refine_costume(character)
        refine_ears(character, fur_collection)
        setup_review(scene, bpy.data.collections["REFERENCE_CAMERAS_AND_LIGHTS_NO_GEOMETRY"])
        topology = validate_scene(scene, character)
        scene["natural_revision"] = REVISION
        scene["natural_source_sha256"] = source_hash
        scene["production_status"] = "Static natural look-development candidate; no rig or animation clips"
        scene.render.resolution_x, scene.render.resolution_y = 2400, 2800
        scene.camera = bpy.data.objects["REFERENCE_CAMERA_hero"]
        scene.render.filepath = str(output / "lumi-hero.png")
        bpy.ops.file.pack_all()
        bpy.ops.wm.save_as_mainfile(filepath=str(target), compress=True)
        manifest = {"revision": REVISION, "character": "lumi", "sourceRevision": SOURCE_REVISION,
                    "sourceBlend": source.name, "sourceSha256": source_hash, "blend": target.name,
                    "blendSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "blender": bpy.app.version_string, "workflow": "installed loopback Blender MCP addon bridge",
                    "nativeMcpConnectorUsed": False, "aiRefinementUsed": False, "comfyUIUsed": False,
                    "productAssetsReplaced": False, "rigged": False, "animationClips": [],
                    "topology": topology,
                    "changes": ["smaller eyes, wider teal iris, softly open pupils and fur-integrated eyelids",
                                "tapered brows, recessed muzzle, rounded triangular nose and fine whiskers",
                                "continuous sculpted gripping paw with fitted shaft channel and new groom",
                                "matte cross-woven cloak, thinner folded collars and separate stitch geometry",
                                "cupped softly translucent inner ears and controlled studio eye reflections"],
                    "renders": []}
    manifest["backgroundGeometry"] = [obj.name for obj in scene.objects if obj.type in {"MESH", "CURVE", "CURVES"}
                                      and obj.name not in character.all_objects]
    if manifest["backgroundGeometry"]:
        raise RuntimeError("Found geometry outside the character")
    manifest["groomStrands"] = sum(len(obj.data.curves) for obj in character.all_objects if obj.type == "CURVES")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not arguments.prepare_only:
        scene.render.resolution_x = arguments.size
        scene.cycles.samples = arguments.samples
        for view in arguments.views:
            scene.camera = bpy.data.objects["REFERENCE_CAMERA_" + view]
            square = view in {"detail", "grip"}
            scene.render.resolution_y = arguments.size if square else round(arguments.size * 7 / 6)
            prefix = "draft-" if arguments.draft else ""
            scene.render.filepath = str(output / f"{prefix}lumi-{view}.png")
            bpy.ops.render.render(write_still=True)
            if not arguments.draft:
                manifest["renders"] = [entry for entry in manifest["renders"] if entry["view"] != view]
                manifest["renders"].append({"view": view, "file": Path(scene.render.filepath).name,
                                           "width": scene.render.resolution_x, "height": scene.render.resolution_y,
                                           "samples": arguments.samples, "transparent": True, "bitDepth": 16})
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
