import argparse
import hashlib
import json
import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


REVISION = "reference-20261024-v3"


def linear_color(color):
    return tuple(value / 12.92 if value < 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in color)


def material(name, color, roughness=0.5, metallic=0.0):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*linear_color(color), 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    result.diffuse_color = (*linear_color(color), 1)
    return result


def link_object(obj, collection):
    for previous in list(obj.users_collection):
        previous.objects.unlink(obj)
    collection.objects.link(obj)
    if obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return obj


def mesh_object(name, vertices, faces, surface, collection):
    mesh = bpy.data.meshes.new(name + "_MESH")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    mesh.materials.append(surface)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return obj


def ellipsoid(name, center, scale, surface, collection):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, location=center)
    obj = link_object(bpy.context.object, collection)
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(surface)
    return obj


def curve_object(name, coordinates, radius, surface, collection, cyclic=False):
    data = bpy.data.curves.new(name + "_CURVE", "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 12
    data.bevel_depth = radius
    data.bevel_resolution = 3
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(coordinates) - 1)
    spline.use_cyclic_u = cyclic
    for point, coordinate in zip(spline.bezier_points, coordinates):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    data.materials.append(surface)
    return obj


def lathe(name, profile, center, surface, collection, segments=64):
    vertices, faces = [], []
    for radius, height in profile:
        for segment in range(segments):
            angle = math.tau * segment / segments
            vertices.append((center[0] + radius * math.cos(angle),
                             center[1] + radius * math.sin(angle), height))
    for row in range(len(profile) - 1):
        for segment in range(segments):
            following = (segment + 1) % segments
            faces.append((row * segments + segment, row * segments + following,
                          (row + 1) * segments + following, (row + 1) * segments + segment))
    faces.extend([tuple(reversed(range(segments))),
                  tuple((len(profile) - 1) * segments + segment for segment in range(segments))])
    return mesh_object(name, vertices, faces, surface, collection)


def deform_object(obj, transformation):
    matrix = np.array(obj.matrix_world)
    inverse = np.linalg.inv(matrix)

    def convert(coordinates):
        world = coordinates @ matrix[:3, :3].T + matrix[:3, 3]
        return (transformation(world) @ inverse[:3, :3].T + inverse[:3, 3]).astype(np.float32)

    if obj.type in {"MESH", "CURVES"}:
        if obj.type == "MESH":
            positions, property_name = obj.data.vertices, "co"
        else:
            positions, property_name = obj.data.attributes["position"].data, "vector"
        coordinates = np.empty(len(positions) * 3, dtype=np.float32)
        positions.foreach_get(property_name, coordinates)
        positions.foreach_set(property_name, convert(coordinates.reshape(-1, 3)).ravel())
        obj.data.update_tag()
    elif obj.type == "CURVE":
        for spline in obj.data.splines:
            if spline.type == "BEZIER":
                for point in spline.bezier_points:
                    coordinates = np.array([point.co[:], point.handle_left[:], point.handle_right[:]])
                    transformed = convert(coordinates)
                    point.co, point.handle_left, point.handle_right = transformed
            else:
                for point in spline.points:
                    point.co = (*convert(np.array([point.co[:3]]))[0], point.co.w)


def rebuild_deer_arm(character):
    original = bpy.data.objects["DEER_BODY_CONTINUOUS_SCULPT"]
    original_groom = bpy.data.objects["DEER_BODY_CONTINUOUS_SCULPT_FILM_FUR"]
    coat = original.data.materials[0]
    fur_surface = original_groom.data.materials[0]
    fur_collection = original_groom.users_collection[0]
    original_name = original.name
    bpy.data.objects.remove(original, do_unlink=True)
    bpy.data.objects.remove(original_groom, do_unlink=True)
    for obj in list(character.all_objects):
        if obj.name.startswith("DEER_HAND_CREASE"):
            center = sum((obj.matrix_world @ Vector(corner) for corner in obj.bound_box), Vector()) / 8
            if center.x < 0:
                bpy.data.objects.remove(obj, do_unlink=True)
    torso = ellipsoid("DEER_REPOSE_TORSO", (0, 0.025, 0.88), (0.535, 0.370, 0.665), coat, character)
    for vertex in torso.data.vertices:
        vertex.co.x *= 1 - 0.16 * max(vertex.co.z / 0.665, 0)
    pieces = [torso, ellipsoid("DEER_REPOSE_NECK", (0, 0.005, 1.4), (0.295, 0.28, 0.34), coat, character)]
    for side in [-1, 1]:
        pieces.append(ellipsoid("DEER_REPOSE_LEG", (side * 0.255, 0.035, 0.30), (0.183, 0.223, 0.260), coat, character))
    arm = ellipsoid("DEER_REPOSE_RELAXED_ARM", (0.48, -0.005, 0.92), (0.137, 0.175, 0.385), coat, character)
    arm.rotation_euler.y = -0.24
    pieces.extend([arm, ellipsoid("DEER_REPOSE_RELAXED_HAND", (0.56, -0.053, 0.645), (0.145, 0.17, 0.185), coat, character)])
    for center, scale in [((-0.48, -0.025, 1.12), (0.22, 0.175, 0.16)),
                          ((-0.70, -0.065, 1.12), (0.22, 0.155, 0.14)),
                          ((-0.88, -0.105, 1.11), (0.185, 0.145, 0.135)),
                          ((-0.995, -0.15, 1.115), (0.135, 0.13, 0.12))]:
        pieces.append(ellipsoid("DEER_REPOSE_LANTERN_ARM", center, scale, coat, character))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in pieces:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = torso
    bpy.ops.object.join()
    torso.name = original_name
    union = torso.modifiers.new("Continuous reposed shoulder and arm", "REMESH")
    union.mode, union.voxel_size, union.use_smooth_shade = "VOXEL", 0.010, True
    bpy.ops.object.modifier_apply(modifier=union.name)
    smoothing = torso.modifiers.new("Soft shoulder transition", "SMOOTH")
    smoothing.factor, smoothing.iterations = 0.7, 5
    bpy.ops.object.modifier_apply(modifier=smoothing.name)
    torso.data.calc_loop_triangles()
    coordinates = np.array([torso.matrix_world @ vertex.co for vertex in torso.data.vertices])
    normals = np.array([(torso.matrix_world.to_3x3() @ vertex.normal).normalized() for vertex in torso.data.vertices])
    triangles = np.array([tuple(triangle.vertices) for triangle in torso.data.loop_triangles])
    positions = coordinates[triangles]
    areas = np.linalg.norm(np.cross(positions[:, 1] - positions[:, 0], positions[:, 2] - positions[:, 0]), axis=1)
    generator = np.random.default_rng(20261024)
    selected = triangles[generator.choice(len(triangles), 62000, p=areas / areas.sum())]
    barycentric = generator.random((len(selected), 2))
    reflected = barycentric.sum(axis=1) > 1
    barycentric[reflected] = 1 - barycentric[reflected]
    weights = np.column_stack((1 - barycentric.sum(axis=1), barycentric))
    roots = (coordinates[selected] * weights[:, :, None]).sum(axis=1)
    directions = (normals[selected] * weights[:, :, None]).sum(axis=1)
    directions /= np.maximum(np.linalg.norm(directions, axis=1, keepdims=True), 0.001)
    belly = (roots[:, 0] / 0.335) ** 2 + ((roots[:, 2] - 0.812) / 0.435) ** 2
    keep = ~((belly < 1.03) & (roots[:, 1] < -0.20))
    roots, directions = roots[keep], directions[keep]
    gravity = np.broadcast_to([0, 0, -1.0], roots.shape).copy()
    groom = gravity - directions * (gravity * directions).sum(axis=1, keepdims=True)
    groom /= np.maximum(np.linalg.norm(groom, axis=1, keepdims=True), 0.001)
    progression = np.linspace(0, 1, 5)[None, :, None]
    lengths = 0.0122 * np.clip(generator.normal(1, 0.18, len(roots)), 0.55, 1.5)
    positions = (roots[:, None, :] - directions[:, None, :] * 0.00035
                 + directions[:, None, :] * lengths[:, None, None] * (0.76 * progression - 0.12 * progression ** 2)
                 + groom[:, None, :] * lengths[:, None, None] * 0.59 * progression ** 1.5)
    hair = bpy.data.hair_curves.new(original_name + "_GROOM_DATA")
    hair.add_curves([5] * len(roots))
    hair.attributes["position"].data.foreach_set("vector", positions.astype(np.float32).ravel())
    radii = hair.attributes.new("radius", "FLOAT", "POINT")
    radii.data.foreach_set("value", (0.00076 * generator.uniform(0.75, 1.2, (len(roots), 1))
                                   * np.array([1, 0.85, 0.65, 0.40, 0.035])[None, :]).astype(np.float32).ravel())
    fur = bpy.data.objects.new(original_name + "_FILM_FUR", hair)
    fur_collection.objects.link(fur)
    hair.materials.append(fur_surface)
    fur["source_mesh"], fur["strand_count"] = original_name, len(roots)


def kitten_proportions(coordinates):
    result = coordinates.copy()
    height = coordinates[:, 2]
    result[:, 2] = 0.84 * height + 0.022 * np.logaddexp(0, (height - 1.9) / 0.1)
    return result


def fine_groom(character):
    for obj in character.all_objects:
        if obj.type != "CURVES":
            continue
        radii = obj.data.attributes.get("radius")
        if radii:
            values = np.empty(len(radii.data), dtype=np.float32)
            radii.data.foreach_get("value", values)
            radii.data.foreach_set("value", values * 0.72)
            obj.data.update_tag()


def add_lantern(character, studio):
    bronze = material("REFERENCE | aged bronze lantern frame", (0.29, 0.22, 0.14), 0.32, 0.78)
    brass = material("REFERENCE | hand-polished brass edges", (0.64, 0.44, 0.19), 0.28, 0.83)
    glass = material("REFERENCE | warm clear lantern glass", (1.0, 0.94, 0.77), 0.075)
    shader = glass.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Transmission Weight"].default_value = 1.0
    shader.inputs["IOR"].default_value = 1.46
    flame = material("REFERENCE | amber lantern flame", (1.0, 0.65, 0.12), 0.3)
    shader = flame.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Emission Color"].default_value = (1.0, 0.32, 0.028, 1)
    shader.inputs["Emission Strength"].default_value = 7.0
    center = (-1.005, -0.15)
    lathe("DEER_LANTERN_STEPPED_BASE", [(0.15, 0.13), (0.19, 0.14), (0.20, 0.16),
          (0.20, 0.185), (0.18, 0.20), (0.17, 0.215)], center, bronze, character)
    lathe("DEER_LANTERN_LOWER_BRASS_RIM", [(0.172, 0.20), (0.178, 0.208),
          (0.178, 0.225), (0.166, 0.23)], center, brass, character)
    chimney = lathe("DEER_LANTERN_GLASS_CHIMNEY", [(0.155, 0.225), (0.166, 0.27),
                    (0.162, 0.55), (0.14, 0.64)], center, glass, character)
    thickness = chimney.modifiers.new("Real thin glass wall", "SOLIDIFY")
    thickness.thickness = 0.008
    lathe("DEER_LANTERN_VENTED_CAP", [(0.19, 0.625), (0.19, 0.65), (0.152, 0.675),
          (0.116, 0.71), (0.09, 0.75), (0.055, 0.76)], center, bronze, character)
    lathe("DEER_LANTERN_CAP_BRASS_RIM", [(0.18, 0.637), (0.19, 0.645),
          (0.19, 0.657)], center, brass, character)
    lathe("DEER_LANTERN_WICK_HOLDER", [(0.06, 0.23), (0.065, 0.26),
          (0.025, 0.28), (0.025, 0.3)], center, bronze, character)
    ellipsoid("DEER_LANTERN_AMBER_FLAME", (center[0], center[1], 0.37),
              (0.048, 0.043, 0.105), flame, character)
    for side in [-1, 1]:
        curve_object("DEER_LANTERN_SIDE_GUARD_" + str(side),
                     [(center[0] + side * 0.175, center[1], 0.20),
                      (center[0] + side * 0.195, center[1], 0.38),
                      (center[0] + side * 0.172, center[1], 0.65)], 0.014, bronze, character)
        curve_object("DEER_LANTERN_CROSS_GUARD_" + str(side),
                     [(center[0] + side * 0.14, center[1] - 0.09, 0.23),
                      (center[0], center[1] - 0.175, 0.425),
                      (center[0] - side * 0.13, center[1] - 0.09, 0.62)], 0.010, bronze, character)
    ellipsoid("DEER_LANTERN_GUARD_CENTER_RIVET", (center[0], center[1] - 0.177, 0.425),
              (0.025, 0.013, 0.025), brass, character)
    curve_object("DEER_LANTERN_SWING_HANDLE", [(center[0] - 0.18, center[1], 0.68),
                 (center[0] - 0.21, center[1], 0.94), (center[0], center[1], 1.13),
                 (center[0] + 0.21, center[1], 0.94), (center[0] + 0.18, center[1], 0.68)],
                 0.014, bronze, character)
    coat = bpy.data.objects["DEER_BODY_CONTINUOUS_SCULPT"].data.materials[0]
    for index in range(3):
        ellipsoid("DEER_LANTERN_GRIP_FINGER_" + str(index),
                  (center[0] + (index - 1) * 0.063, -0.245, 1.115 - abs(index - 1) * 0.012),
                  (0.045, 0.066, 0.052), coat, character)
    light = bpy.data.lights.new("REFERENCE_LANTERN_AMBER_BOUNCE", "POINT")
    light.energy, light.color, light.shadow_soft_size = 9, (1.0, 0.40, 0.075), 0.09
    obj = bpy.data.objects.new(light.name, light)
    studio.objects.link(obj)
    obj.location = (center[0], center[1] - 0.025, 0.39)


def refine_deer(character, studio):
    rebuild_deer_arm(character)
    for obj in character.all_objects:
        if "ANTLER_ORGANIC" in obj.name:
            def shorter_antler(coordinates):
                result = coordinates.copy()
                result[:, 2] = 2.48 + (result[:, 2] - 2.48) * 0.88
                return result
            deform_object(obj, shorter_antler)
        if obj.name.startswith("DEER_PUPIL_"):
            obj.scale.x *= 1.20
            obj.scale.z *= 1.08
    for original in list(character.all_objects):
        if not any(marker in original.name for marker in ("SCARF_DRAPED_TAIL", "SCARF_TAIL_KNIT", "SCARF_SOFT_FRINGE")):
            continue
        duplicate = original.copy()
        duplicate.data = original.data.copy()
        duplicate.name = original.name.replace("DRAPED_TAIL", "DRAPED_SECOND_TAIL").replace("TAIL_KNIT", "SECOND_TAIL_KNIT").replace("SOFT_FRINGE", "SECOND_SOFT_FRINGE")
        original.users_collection[0].objects.link(duplicate)

        def second_tail(coordinates):
            result = coordinates.copy()
            result[:, 0] = 0.40 + (coordinates[:, 0] - 0.249) * 0.82
            result[:, 1] += 0.035
            result[:, 2] = 1.405 + (coordinates[:, 2] - 1.405) * 0.72
            return result

        deform_object(duplicate, second_tail)
        if duplicate.type == "CURVES":
            duplicate["source_mesh"] = "DEER_SCARF_DRAPED_SECOND_TAIL"
    for surface in bpy.data.materials:
        if "amber iris" in surface.name.lower():
            for node in surface.node_tree.nodes:
                if node.type == "VALTORGB":
                    elements = node.color_ramp.elements
                    elements[0].color = (0.022, 0.009, 0.003, 1)
                    elements[-1].color = (0.23, 0.10, 0.025, 1)
    add_lantern(character, studio)
    return {"raisedLanternHand": True, "lantern": "separate modeled bronze, glass, wick, flame, guards and handle",
            "scarf": "original knit geometry plus second shorter draped end", "shorterVelvetAntlers": True,
            "largerPupils": True}


def refine_kitten(character):
    for obj in list(character.all_objects):
        deform_object(obj, kitten_proportions)
        if "vertical_pupil" in obj.name:
            obj.scale.x *= 1.46
            obj.scale.z *= 0.93
    for surface in bpy.data.materials:
        if surface.name.startswith("CAT | amethyst woven cloak"):
            surface.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (*linear_color((0.50, 0.115, 0.48)), 1)
        if surface.name.startswith("CAT | dusky lilac cloak lining"):
            surface.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (*linear_color((0.63, 0.31, 0.52)), 1)
    brow = material("REFERENCE | soft ink blue kitten eyebrows", (0.13, 0.22, 0.28), 0.65)
    for obj in character.all_objects:
        if "CAT_BROW_" in obj.name:
            obj.data.materials.clear()
            obj.data.materials.append(brow)
    gold = next(obj.data.materials[0] for obj in character.all_objects if "CLOAK_embroidery_" in obj.name)
    for original in list(character.all_objects):
        if "CLOAK_embroidery_" not in original.name:
            continue
        points = [original.matrix_world @ point.co for spline in original.data.splines for point in spline.bezier_points]
        if not points:
            continue
        center = sum(points, Vector()) / len(points)
        vertices = []
        normal = Vector((center.x, center.y, 0)).normalized()
        tangent = Vector((-normal.y, normal.x, 0))
        for index in range(10):
            angle = math.pi / 2 + index * math.pi / 5
            radius = 0.026 if index % 2 == 0 else 0.011
            vertices.append(tuple(center + normal * 0.003 + tangent * math.cos(angle) * radius
                                  + Vector((0, 0, math.sin(angle) * radius))))
        star = mesh_object(original.name + "_FIVE_POINT_STAR", vertices, [tuple(range(10))], gold, character)
        thickness = star.modifiers.new("Raised thread embroidery", "SOLIDIFY")
        thickness.thickness = 0.0015
        bpy.data.objects.remove(original, do_unlink=True)
    return {"proportions": "shorter body and relatively larger head; accessories and groom transformed together",
            "pupils": "rounder open pupils", "cloak": "berry-amethyst cloth with existing gold piping",
            "embroidery": "separate raised five-point gold stars", "preserved": ["wand", "brooch", "satchel", "whiskers", "tuft", "tail"]}


def studio_light(collection, name, position, target, energy, color, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.color, data.shape, data.size = energy, color, "DISK", size
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_studio(scene, character, studio, character_id):
    studio_light(studio, "REFERENCE_SOFT_WARM_KEY", (-3.5, -4.8, 5.0), (0, 0, 1.7), 430, (1.0, 0.86, 0.70), 4.0)
    studio_light(studio, "REFERENCE_COOL_FILL", (3.5, -3.0, 3.6), (0, 0, 1.7), 180, (0.76, 0.86, 1.0), 3.0)
    studio_light(studio, "REFERENCE_GOLDEN_FUR_RIM", (-0.8, 2.2, 4.4), (0, 0, 1.8), 560, (1.0, 0.79, 0.56), 3.0)
    studio_light(studio, "REFERENCE_EYE_REFLECTION", (-1.2, -4.0, 3.2), (0, 0, 2.0), 24, (1.0, 0.96, 0.90), 1.25)
    studio_light(studio, "REFERENCE_BACK_ACCESSORY_FILL", (3.0, 3.0, 2.5), (0, 0, 1.4), 160, (0.91, 0.85, 1.0), 3.0)
    scene.world.use_nodes = True
    background = next(node for node in scene.world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.62, 0.68, 0.78, 1)
    background.inputs["Strength"].default_value = 0.18
    scene.render.engine = "CYCLES"
    scene.cycles.use_denoising = True
    scene.cycles.adaptive_threshold = 0.012
    scene.cycles.max_bounces = 10
    scene.cycles.transmission_bounces = 8
    scene.cycles.transparent_max_bounces = 12
    scene.render.use_persistent_data = True
    preferences = bpy.context.preferences.addons["cycles"].preferences
    scene.cycles.device = "CPU"
    for backend in ["OPTIX", "CUDA"]:
        try:
            preferences.compute_device_type = backend
            preferences.get_devices()
            devices = [device for device in preferences.devices if device.type == backend]
            if devices:
                for device in preferences.devices:
                    device.use = device.type == backend
                scene.cycles.device = "GPU"
                break
        except (TypeError, RuntimeError):
            continue
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "16"
    scene.render.image_settings.compression = 35
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(corner) for obj in character.all_objects if obj.type == "MESH" for corner in obj.bound_box]
    minimum = np.array([min(point[axis] for point in corners) for axis in range(3)])
    maximum = np.array([max(point[axis] for point in corners) for axis in range(3)])
    center = (minimum + maximum) / 2
    height = maximum[2] - minimum[2]
    scale = max(height * 1.15, (maximum[0] - minimum[0]) * 1.17 * 1.15)
    target = Vector((center[0], 0, center[2]))
    for view, direction in [("hero", (2.7, -12, 1.35)), ("front", (0, -12, 0)),
                            ("side", (12, 0, 0)), ("back", (0, 12, 0))]:
        data = bpy.data.cameras.new("REFERENCE_CAMERA_" + view)
        data.type, data.ortho_scale, data.lens = "ORTHO", scale, 85
        camera = bpy.data.objects.new(data.name, data)
        studio.objects.link(camera)
        camera.location = target + Vector(direction)
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    focus = (0, -0.08, 1.97 if character_id == "lili" else 2.20)
    data = bpy.data.cameras.new("REFERENCE_CAMERA_detail")
    data.type, data.ortho_scale = "ORTHO", 1.66
    camera = bpy.data.objects.new(data.name, data)
    studio.objects.link(camera)
    camera.location = Vector(focus) + Vector((1.0, -10, 0.75))
    camera.rotation_euler = (Vector(focus) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = bpy.data.objects["REFERENCE_CAMERA_hero"]
    return {"minimum": minimum.tolist(), "maximum": maximum.tolist()}


def main():
    parser = argparse.ArgumentParser(description="Refine the original character .blend without replacing product assets")
    parser.add_argument("--character", required=True, choices=["lili", "lumi"])
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--size", type=int, default=1800)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--views", nargs="+", choices=["hero", "front", "side", "back", "detail"], default=["hero", "front", "side", "back", "detail"])
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--render-only", action="store_true")
    arguments = parser.parse_args()
    if not 256 <= arguments.size <= 8192 or not 1 <= arguments.samples <= 4096:
        parser.error("Invalid render resolution or sample count")
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = Path(bpy.data.filepath).resolve(strict=True)
    target = output / (arguments.character + "-reference-v3.blend")
    scene = bpy.context.scene
    bpy.context.preferences.filepaths.save_version = 0
    prefix = "DEER_CHARACTER_ONLY" if arguments.character == "lili" else "MICROGLOW_CAT_ONLY"
    character = next(collection for collection in scene.collection.children if collection.name.startswith(prefix))
    if arguments.render_only:
        if scene.get("reference_revision") != REVISION:
            raise RuntimeError("Render-only requires the prepared v3 candidate, not the original source")
        manifest = json.loads((output / "candidate-manifest.json").read_text(encoding="utf-8"))
    else:
        if source == target or scene.get("reference_revision"):
            raise RuntimeError("Start from the original source; do not refine an already modified candidate twice")
        for obj in list(scene.objects):
            if obj.name not in character.all_objects:
                bpy.data.objects.remove(obj, do_unlink=True)
        studio = bpy.data.collections.new("REFERENCE_CAMERAS_AND_LIGHTS_NO_GEOMETRY")
        scene.collection.children.link(studio)
        changes = refine_deer(character, studio) if arguments.character == "lili" else refine_kitten(character)
        fine_groom(character)
        bounds = setup_studio(scene, character, studio, arguments.character)
        scene["reference_revision"] = REVISION
        scene["reference_source_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        scene["production_status"] = "Editable look-development candidate; no new rig, animations or hand retopology"
        scene["reference_scope"] = "Single character and worn or held accessories only. No background geometry."
        manifest = {"revision": REVISION, "character": arguments.character, "sourceBlend": source.name,
                    "sourceSha256": scene["reference_source_sha256"], "blend": target.name,
                    "blender": bpy.app.version_string, "method": "original model refinement through local Blender MCP bridge",
                    "aiRefinementUsed": False, "comfyUIUsed": False, "productAssetsReplaced": False,
                    "changes": changes, "bounds": bounds, "groomStrands": sum(len(obj.data.curves) for obj in character.all_objects if obj.type == "CURVES"),
                    "rigged": False, "manuallyRetopologized": False, "renders": []}
    manifest["backgroundGeometry"] = [obj.name for obj in scene.objects if obj.type == "MESH" and obj.name not in character.all_objects]
    if manifest["backgroundGeometry"]:
        raise RuntimeError("Unexpected geometry outside the isolated character")
    scene.render.resolution_x, scene.render.resolution_y = arguments.size, round(arguments.size * 7 / 6)
    scene.cycles.samples = arguments.samples
    scene.camera = bpy.data.objects["REFERENCE_CAMERA_hero"]
    scene.render.filepath = str(output / (arguments.character + "-hero.png"))
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(target), compress=True)
    if not arguments.prepare_only:
        for view in arguments.views:
            scene.camera = bpy.data.objects["REFERENCE_CAMERA_" + view]
            scene.render.resolution_y = arguments.size if view == "detail" else round(arguments.size * 7 / 6)
            scene.render.filepath = str(output / (arguments.character + "-" + view + ".png"))
            bpy.ops.render.render(write_still=True)
            manifest["renders"] = [entry for entry in manifest["renders"] if entry["view"] != view]
            manifest["renders"].append({"view": view, "file": Path(scene.render.filepath).name,
                                       "width": scene.render.resolution_x, "height": scene.render.resolution_y,
                                       "samples": arguments.samples, "transparent": True, "bitDepth": 16})
            (output / "candidate-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    scene.camera = bpy.data.objects["REFERENCE_CAMERA_hero"]
    scene.render.resolution_y = round(arguments.size * 7 / 6)
    scene.render.filepath = str(output / (arguments.character + "-hero.png"))
    manifest["blendSha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
    (output / "candidate-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
