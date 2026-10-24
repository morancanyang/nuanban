import math

import bpy
from mathutils import Matrix, Vector


def smoothstep(minimum, maximum, value):
    progress = max(0.0, min(1.0, (value - minimum) / (maximum - minimum)))
    return progress * progress * (3.0 - 2.0 * progress)


def add_track(owner, action, name):
    animation = owner.animation_data
    track = animation.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(action.frame_range[0]), action)
    strip.action_slot = action.slots[0]
    strip.extrapolation = "NOTHING"
    animation.action = None
    return track


def add_eyelids(collection, objects):
    material = bpy.data.materials.new("Lili_Natural_Soft_Eyelids")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    head = next(obj for obj in objects if obj["source_object"] == "DEER_HEAD_SCULPT")
    head_shader = next(node for node in head.data.materials[0].node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = head_shader.inputs["Base Color"].default_value
    shader.inputs["Roughness"].default_value = 0.9
    eyelids = []
    for side in (-1, 1):
        center = Vector((side * 0.278, -0.384, 1.982))
        rotation = Matrix.Rotation(side * math.radians(12), 4, "Z")
        for half in (-1, 1):
            def coordinates(closed):
                result = []
                for band in range(5):
                    edge = math.radians(77) if not closed else -0.015
                    latitude = half * (edge + (math.pi / 2 - edge) * band / 4)
                    for segment in range(25):
                        longitude = math.pi * segment / 24
                        local = Vector((0.154 * math.cos(longitude),
                                        -0.187 * math.sin(longitude) * math.cos(latitude),
                                        0.148 * math.sin(longitude) * math.sin(latitude)))
                        result.append(tuple(center + rotation @ local))
                return result

            vertices = coordinates(False)
            faces = []
            for band in range(4):
                for segment in range(24):
                    offset = band * 25 + segment
                    face = (offset, offset + 1, offset + 26, offset + 25)
                    faces.append(face if half == 1 else tuple(reversed(face)))
            name = f"DEER_BLINK_LID_{side}_{half}"
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(vertices, [], faces)
            mesh.materials.append(material)
            for polygon in mesh.polygons:
                polygon.use_smooth = True
            obj = bpy.data.objects.new(name, mesh)
            collection.objects.link(obj)
            obj["source_object"] = name
            obj.shape_key_add(name="Basis")
            closed = obj.shape_key_add(name="blink")
            for vertex, coordinate in zip(closed.data, coordinates(True)):
                vertex.co = coordinate
            for frame, value in [(1, 0), (3, 0.5), (4, 1), (5, 1), (7, 0.4), (10, 0)]:
                closed.value = value
                closed.keyframe_insert(data_path="value", frame=frame)
            closed.value = 0
            action = obj.data.shape_keys.animation_data.action
            action.name = name + "_blink"
            add_track(obj.data.shape_keys, action, "blink")
            objects.append(obj)
            eyelids.append(obj)
    return eyelids


def body_weights(position):
    horizontal, depth, height = position
    side = "L" if horizontal >= 0 else "R"
    chest = smoothstep(0.45, 1.3, height)
    weights = {"Pelvis": 1 - chest, "Chest": chest}
    leg = 1 - smoothstep(0.25, 0.48, height)
    arm = smoothstep(0.39, 0.57, abs(horizontal)) * smoothstep(0.65, 0.83, height) * (1 - smoothstep(1.31, 1.47, height))
    if arm > 0:
        forearm = smoothstep(0.55, 0.69, abs(horizontal)) if side == "R" else 1 - smoothstep(0.86, 1.05, height)
        weights = {name: weight * (1 - arm) for name, weight in weights.items()}
        weights["Arm." + side] = arm * (1 - forearm)
        weights["Forearm." + side] = arm * forearm
    if leg > 0:
        weights = {name: weight * (1 - leg) for name, weight in weights.items()}
        weights["Leg." + side] = leg
    largest = sorted(((name, weight) for name, weight in weights.items() if weight > 0.0001), key=lambda item: -item[1])[:4]
    total = sum(weight for name, weight in largest)
    return [(name, weight / total) for name, weight in largest]


def bind_natural_actions(collection, root, objects):
    add_eyelids(collection, objects)
    skeleton = bpy.data.armatures.new("Lili_Natural_v4_Skeleton")
    rig = bpy.data.objects.new("Lili_Natural_v4_Rig", skeleton)
    collection.objects.link(rig)
    rig.parent = root
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    joints = [
        ("Root", (0, 0, 0.08), None),
        ("Pelvis", (0, 0.025, 0.45), "Root"),
        ("Chest", (0, 0.025, 0.9), "Pelvis"),
        ("Neck", (0, 0, 1.35), "Chest"),
        ("Head", (0, 0, 1.55), "Neck"),
        ("Ear.L", (0.55, 0.02, 2.35), "Head"),
        ("Ear.R", (-0.55, 0.02, 2.35), "Head"),
        ("Arm.L", (0.38, 0, 1.22), "Chest"),
        ("Forearm.L", (0.56, -0.04, 0.97), "Arm.L"),
        ("Arm.R", (-0.38, 0, 1.22), "Chest"),
        ("Forearm.R", (-0.68, -0.08, 1.04), "Arm.R"),
        ("Hand.R", (-0.97, -0.19, 1.03), "Forearm.R"),
        ("Lantern", (-0.97, -0.13, 1.03), "Hand.R"),
        ("Leg.L", (0.25, -0.04, 0.42), "Pelvis"),
        ("Leg.R", (-0.25, -0.04, 0.42), "Pelvis"),
        ("Tail", (0, 0.33, 0.7), "Pelvis"),
        ("Scarf", (0.27, -0.18, 1.36), "Neck"),
        ("Scarf.Second", (0.38, -0.15, 1.36), "Neck"),
    ]
    for name, position, parent in joints:
        bone = skeleton.edit_bones.new(name)
        bone.head = position
        bone.tail = Vector(position) + Vector((0, 0, 0.12))
        if parent:
            bone.parent = skeleton.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    for obj in objects:
        world = obj.matrix_world.copy()
        obj.data.transform(world, shape_keys=True)
        obj.matrix_world = Matrix.Identity(4)
        obj.parent = rig
        groups = {name: obj.vertex_groups.new(name=name) for name, position, parent in joints}
        source = obj["source_object"]
        if "BODY_CONTINUOUS" in source or "HAND_CREASE" in source:
            for vertex in obj.data.vertices:
                for name, weight in body_weights(vertex.co):
                    groups[name].add([vertex.index], weight, "REPLACE")
        else:
            if "LANTERN" in source:
                name = "Hand.R" if "GRIP_FINGER" in source else "Lantern"
            elif "EAR_" in source:
                name = "Ear.R" if "_-1" in source else "Ear.L"
            elif "SCARF" in source:
                name = "Neck" if "COLLAR" in source else "Scarf.Second" if "SECOND" in source else "Scarf"
            elif "TAIL" in source:
                name = "Tail"
            elif "HOOF" in source:
                name = "Leg.R" if "_-1" in source else "Leg.L"
            elif "BELLY" in source:
                for vertex in obj.data.vertices:
                    chest = smoothstep(0.45, 1.3, vertex.co.z)
                    groups["Pelvis"].add([vertex.index], 1 - chest, "REPLACE")
                    groups["Chest"].add([vertex.index], chest, "REPLACE")
                name = None
            else:
                name = "Head"
            if name:
                groups[name].add(list(range(len(obj.data.vertices))), 1, "REPLACE")
        modifier = obj.modifiers.new("Lili natural deformation", "ARMATURE")
        modifier.object = rig

    scene = bpy.context.scene
    scene.render.fps = 30
    clips = [("idle", 180), ("look", 126), ("wave", 84), ("nod", 63)]
    for name, duration in clips:
        for frame in range(0, duration + 1, 3):
            progress = frame / duration
            envelope = math.sin(math.pi * progress) ** 2
            breath = math.sin(math.tau * progress)
            for bone in rig.pose.bones:
                bone.rotation_mode = "XYZ"
                bone.rotation_euler = (0, 0, 0)
                bone.scale = (1, 1, 1)
            rig.pose.bones["Chest"].scale = (1 + 0.003 * breath, 1 + 0.006 * breath, 1 + 0.004 * breath)
            rig.pose.bones["Head"].rotation_euler.x = math.radians(0.7) * breath
            rig.pose.bones["Head"].rotation_euler.z = math.radians(0.8) * math.sin(math.tau * progress) ** 3
            rig.pose.bones["Tail"].rotation_euler.y = math.radians(3) * math.sin(math.tau * progress)
            rig.pose.bones["Lantern"].rotation_euler.z = math.radians(1.1) * math.sin(math.tau * progress)
            rig.pose.bones["Scarf"].rotation_euler.x = math.radians(0.7) * math.sin(math.tau * progress)
            rig.pose.bones["Scarf.Second"].rotation_euler.x = -math.radians(0.5) * math.sin(math.tau * progress)
            rig.pose.bones["Ear.L"].rotation_euler.z = math.radians(1.2) * envelope * math.sin(math.tau * progress)
            rig.pose.bones["Ear.R"].rotation_euler.z = -math.radians(0.8) * envelope * math.sin(math.tau * progress)
            if name == "look":
                rig.pose.bones["Head"].rotation_euler.y = math.radians(9) * envelope * math.sin(math.tau * progress)
                rig.pose.bones["Neck"].rotation_euler.y = math.radians(2) * envelope * math.sin(math.tau * progress)
            elif name == "wave":
                rig.pose.bones["Arm.L"].rotation_euler.z = math.radians(64) * envelope
                rig.pose.bones["Forearm.L"].rotation_euler.z = math.radians(19) * envelope + math.radians(7) * envelope * math.sin(6 * math.pi * progress)
                rig.pose.bones["Head"].rotation_euler.z = -math.radians(3) * envelope
            elif name == "nod":
                rig.pose.bones["Head"].rotation_euler.x = math.radians(7) * envelope * math.sin(4 * math.pi * progress)
            for bone in rig.pose.bones:
                bone.keyframe_insert(data_path="rotation_euler", frame=frame + 1)
                bone.keyframe_insert(data_path="scale", frame=frame + 1)
        action = rig.animation_data.action
        action.name = name
        add_track(rig, action, name)
    for bone in rig.pose.bones:
        bone.rotation_euler = (0, 0, 0)
        bone.scale = (1, 1, 1)
    scene.frame_start = 1
    scene.frame_end = 181
    scene.frame_set(1)
    root["rigged"] = True
    root["actions"] = "idle,blink,look,wave,nod"
    return rig
