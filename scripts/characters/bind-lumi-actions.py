import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector


CLIPS = {"Idle_Breathe": 120, "Blink_Soft": 9, "Listen_Curious": 90,
         "Wave_Gentle": 75, "Nod_Encourage": 60, "Guide_Point": 90, "Step_InPlace": 60}


def smooth(value):
    value = max(0, min(1, value))
    return value * value * (3 - 2 * value)


def envelope(frame, start, peak, hold, end):
    return smooth((frame - start) / (peak - start)) * (1 - smooth((frame - hold) / (end - hold)))


def make_rig(collection, root):
    data = bpy.data.armatures.new("Lumi_Deform_Skeleton")
    rig = bpy.data.objects.new("Lumi_Rig", data)
    collection.objects.link(rig)
    rig.parent = root
    rig.show_in_front = True
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(name, head, tail, parent=None, deform=True):
        result = data.edit_bones.new(name)
        result.head = head
        result.tail = tail
        result.use_deform = deform
        if parent:
            result.parent = data.edit_bones[parent]
        result.inherit_scale = "NONE"
        return result

    bone("root", (0, 0, 0), (0, 0, 0.2))
    bone("pelvis", (0, 0, 0.65), (0, 0, 0.95), "root")
    bone("spine", (0, 0, 0.95), (0, 0, 1.25), "pelvis")
    bone("chest", (0, 0, 1.25), (0, 0, 1.51), "spine")
    bone("neck", (0, 0, 1.51), (0, 0, 1.73), "chest")
    bone("head", (0, 0, 1.73), (0, 0, 2.60), "neck")
    for side, sign in (("R", -1), ("L", 1)):
        bone("ear." + side, (sign * 0.43, 0, 2.69), (sign * 0.48, 0.01, 3.10), "head")
        bone("gaze." + side, (sign * 0.27, -0.50, 2.31), (sign * 0.27, -0.65, 2.31), "head")
        shoulder = (sign * 0.31, -0.02, 1.45)
        elbow = (sign * 0.50, -0.15, 1.18) if side == "R" else (0.59, -0.17, 1.33)
        wrist = (-0.60, -0.35, 0.95) if side == "R" else (0.84, -0.44, 1.36)
        tip = (-0.61, -0.39, 0.82) if side == "R" else (0.86, -0.46, 1.45)
        bone("upper_arm." + side, shoulder, elbow, "chest")
        bone("forearm." + side, elbow, wrist, "upper_arm." + side)
        bone("hand." + side, wrist, tip, "forearm." + side)
        if side == "R":
            bone("hand_ik.R", wrist, tip, "root", False)
        hip = (sign * 0.258, 0.02, 0.56)
        knee = (sign * 0.265, -0.10, 0.34)
        ankle = (sign * 0.27, -0.06, 0.14)
        foot_end = (sign * 0.27, -0.30, 0.14)
        bone("thigh." + side, hip, knee, "pelvis")
        bone("shin." + side, knee, ankle, "thigh." + side)
        bone("foot." + side, ankle, foot_end, "shin." + side)
        bone("foot_ik." + side, ankle, foot_end, "root", False)
    tail_points = [(-0.19, 0.29, 0.54), (-0.48, 0.43, 0.43),
                   (-0.85, 0.40, 0.49), (-1.04, 0.35, 0.80), (-1.02, 0.30, 1.12)]
    for index in range(4):
        bone("tail." + str(index), tail_points[index], tail_points[index + 1],
             "pelvis" if index == 0 else "tail." + str(index - 1))
    bone("cloak.0", (0, 0.22, 1.43), (0, 0.40, 1.02), "chest")
    bone("cloak.1", (0, 0.40, 1.02), (0, 0.48, 0.69), "cloak.0")
    bone("cloak.2", (0, 0.48, 0.69), (0, 0.49, 0.38), "cloak.1")
    bone("bag", (-0.52, -0.27, 0.96), (-0.68, -0.35, 0.65), "chest")
    bpy.ops.object.mode_set(mode="OBJECT")
    for side in ("L", "R"):
        constraint = rig.pose.bones["shin." + side].constraints.new("IK")
        constraint.target = rig
        constraint.subtarget = "foot_ik." + side
        constraint.chain_count = 2
        constraint.use_stretch = False
        rotation = rig.pose.bones["foot." + side].constraints.new("COPY_ROTATION")
        rotation.target = rig
        rotation.subtarget = "foot_ik." + side
    constraint = rig.pose.bones["forearm.R"].constraints.new("IK")
    constraint.target = rig
    constraint.subtarget = "hand_ik.R"
    constraint.chain_count = 2
    constraint.use_stretch = False
    rotation = rig.pose.bones["hand.R"].constraints.new("COPY_ROTATION")
    rotation.target = rig
    rotation.subtarget = "hand_ik.R"
    for pose in rig.pose.bones:
        pose.rotation_mode = "XYZ"
    return rig


def pair(first, second, blend):
    blend = smooth(blend)
    return {first: 1 - blend, second: blend}


def weights(name, point):
    horizontal, depth, height = point
    if name.endswith("_FUR"):
        name = name[:-4]
    if name.startswith("CAT_EAR_"):
        side = "R" if "_L_" in name else "L"
        return pair("head", "ear." + side, (height - 2.69) / 0.22)
    if name.startswith("CAT_EYE_"):
        side = "R" if "_L_" in name else "L"
        return {"head" if "sclera" in name or "limbal" in name else "gaze." + side: 1}
    if name.startswith(("CAT_HEAD", "CAT_EYELID", "CAT_BROW", "CAT_NOSE", "CAT_PHILTRUM",
                        "CAT_SMILE", "CAT_WHISKER", "CAT_FOREHEAD", "LUMI_LID")):
        return pair("neck", "head", (height - 1.58) / 0.28)
    if name.startswith("CAT_WAND") or name.startswith("CAT_PAW_R"):
        return {"hand.L": 1}
    if name.startswith("CAT_PAW_L"):
        return {"hand.R": 1}
    if name.startswith("CAT_ARM_"):
        side = "R" if "_L_" in name else "L"
        elbow = Vector((-0.50, -0.15, 1.18) if side == "R" else (0.59, -0.17, 1.33))
        shoulder = Vector((-0.31, -0.02, 1.45) if side == "R" else (0.31, -0.02, 1.45))
        axis = (elbow - shoulder).normalized()
        distance = (Vector(point) - elbow).dot(axis)
        return pair("upper_arm." + side, "forearm." + side, (distance + 0.11) / 0.22)
    if name.startswith(("CAT_FOOT", "CAT_TOE")):
        return {"foot.R" if horizontal < 0 else "foot.L": 1}
    if name.startswith("CAT_LEG"):
        side = "R" if horizontal < 0 else "L"
        return pair("shin." + side, "thigh." + side, (height - 0.23) / 0.22)
    if name.startswith("CAT_TAIL"):
        centers = [Vector(value) for value in [(-0.29, 0.36, 0.49), (-0.65, 0.42, 0.46),
                                              (-0.95, 0.37, 0.63), (-1.03, 0.32, 0.96)]]
        closest = sorted(range(4), key=lambda index: (Vector(point) - centers[index]).length_squared)[:2]
        distances = [1 / max(0.0001, (Vector(point) - centers[index]).length_squared) ** 2 for index in closest]
        total = sum(distances)
        return {"tail." + str(index): distance / total for index, distance in zip(closest, distances)}
    if name.startswith("CAT_BAG"):
        if "strap" in name.lower() or "crossbody" in name.lower():
            return pair("bag", "chest", (height - 0.85) / 0.52)
        return {"bag": 1}
    if name.startswith("CAT_CLOAK"):
        if "collar" in name or height > 1.46:
            return {"chest": 1}
        if height > 1.15:
            return pair("cloak.0", "chest", (height - 1.15) / 0.31)
        if height > 0.83:
            return pair("cloak.1", "cloak.0", (height - 0.83) / 0.32)
        return pair("cloak.2", "cloak.1", (height - 0.44) / 0.39)
    if name.startswith("CAT_BROOCH"):
        return {"chest": 1}
    if height < 0.74:
        return {"pelvis": 1}
    if height < 1.20:
        return pair("pelvis", "spine", (height - 0.74) / 0.46)
    return pair("spine", "chest", (height - 1.20) / 0.35)


def bind_meshes(objects, rig):
    for obj in objects:
        matrix = obj.matrix_world.copy()
        obj.parent = rig
        obj.matrix_world = matrix
        source_name = obj.get("source_surface", obj.get("source_object", obj.name))
        groups = {}
        for vertex in obj.data.vertices:
            values = weights(source_name, obj.matrix_world @ vertex.co)
            total = sum(values.values())
            for name, value in values.items():
                if value < 0.00001:
                    continue
                group = groups.get(name)
                if not group:
                    group = obj.vertex_groups.new(name=name)
                    groups[name] = group
                group.add([vertex.index], value / total, "REPLACE")
        modifier = obj.modifiers.new("Lumi normalized skin weights", "ARMATURE")
        modifier.object = rig
        modifier.use_deform_preserve_volume = False


def lids(collection, root):
    result = []
    material = next(item for item in bpy.data.materials if item.name.split(".")[0] == "CAT | warm ivory undercoat")
    for side, direction in (("L", -1), ("R", 1)):
        for upper in (True, False):
            vertices, closed, faces = [], [], []
            for row in range(7):
                blend = row / 6
                for column in range(33):
                    horizontal = column / 16 - 1
                    arc = math.sqrt(max(0, 1 - horizontal ** 2))
                    outer = (0.205 if upper else -0.205) * arc
                    opened = (0.201 if upper else -0.201) * arc
                    shut = -0.102 * arc + (-0.001 if upper else 0.001)

                    def point(height):
                        radius = min(1, horizontal ** 2 + (height / 0.205) ** 2)
                        depth = -0.568 + 0.034 * radius
                        angle = direction * 0.24
                        offset = 0.166 * horizontal
                        return (direction * 0.266 + offset * math.cos(angle) - (depth + 0.515) * math.sin(angle),
                                -0.47 + offset * math.sin(angle) + (depth + 0.515) * math.cos(angle),
                                2.31 + height - 0.006 * horizontal ** 2)

                    vertices.append(point(outer * (1 - blend) + opened * blend))
                    closed.append(point(outer * (1 - blend) + shut * blend))
            for row in range(6):
                for column in range(32):
                    current = row * 33 + column
                    faces.append((current, current + 1, current + 34, current + 33))
            mesh = bpy.data.meshes.new("Lumi sculpted rolling eyelid")
            mesh.from_pydata(vertices, [], faces)
            mesh.materials.append(material)
            for polygon in mesh.polygons:
                polygon.use_smooth = True
            obj = bpy.data.objects.new("LUMI_LID_" + side + ("_upper" if upper else "_lower"), mesh)
            collection.objects.link(obj)
            obj.parent = root
            obj["source_object"] = obj.name
            obj.shape_key_add(name="Basis")
            key = obj.shape_key_add(name="Blink_" + side)
            for target, coordinate in zip(key.data, closed):
                target.co = coordinate
            result.append(obj)
    return result


def insert_track(owner, name, end):
    action = owner.animation_data.action
    action.name = name + "_" + owner.name
    track = owner.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, action)
    strip.action_frame_start = 0
    strip.action_frame_end = end
    strip.frame_start = 0
    strip.frame_end = end
    strip.extrapolation = "NOTHING"
    track.mute = True
    owner.animation_data.action = None


def animate(rig, eyelids):
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start = 0
    scene.frame_end = 120
    for name, end in CLIPS.items():
        if name == "Blink_Soft":
            for obj in eyelids:
                shape = obj.data.shape_keys
                shape.animation_data_create()
                shape.animation_data.action = bpy.data.actions.new(name)
                key = shape.key_blocks[1]
                for frame, value in ((0, 0), (2, 0.52), (3, 1), (4, 1), (6, 0.55), (9, 0)):
                    key.value = value
                    key.keyframe_insert(data_path="value", frame=frame)
                insert_track(shape, name, end)
                key.value = 0
            continue
        rig.animation_data_create()
        rig.animation_data.action = bpy.data.actions.new(name)
        for frame in range(end + 1):
            for pose in rig.pose.bones:
                pose.location = (0, 0, 0)
                pose.rotation_euler = (0, 0, 0)
                pose.scale = (1, 1, 1)
            poses = rig.pose.bones

            def rotation(bone, angles):
                poses[bone].rotation_euler = tuple(math.radians(value) for value in angles)

            def translation(bone, offset):
                poses[bone].location = poses[bone].bone.matrix_local.to_3x3().inverted() @ Vector(offset)

            if name == "Idle_Breathe":
                breath = envelope(frame, 0, 46, 51, 114)
                poses["spine"].scale = (1 + 0.005 * breath, 1, 1 + 0.006 * breath)
                poses["chest"].scale = (1 + 0.003 * breath, 1, 1 + 0.0035 * breath)
                rotation("tail.3", (0, 0, 0.8 * math.sin(math.tau * frame / end) ** 3))
                rotation("cloak.1", (0.12 * envelope(frame, 5, 51, 56, 119), 0, 0))
            elif name == "Listen_Curious":
                head = envelope(frame, 18, 42, 66, 90)
                gaze = envelope(frame, 15, 36, 63, 87)
                rotation("head", (0, 12 * head, 5 * head))
                rotation("chest", (0, 1.5 * head, 0))
                rotation("ear.R", (10 * envelope(frame, 20, 43, 65, 90), 0, 0))
                rotation("ear.L", (6 * envelope(frame, 24, 47, 65, 90), 0, 0))
                rotation("tail.3", (0, 0, 6 * envelope(frame, 28, 50, 70, 90)))
                for side in ("L", "R"):
                    poses["gaze." + side].location.x = -0.007 * gaze
            elif name == "Wave_Gentle":
                raised = envelope(frame, 0, 18, 43, 75)
                translation("hand_ik.R", (-0.08 * raised, -0.035 * raised, 0.70 * raised))
                swing = 8 * envelope(frame, 20, 29, 32, 44) - 4 * envelope(frame, 32, 40, 43, 54)
                rotation("hand_ik.R", (0, swing, 150 * raised))
                rotation("head", (0, 0, -1.2 * envelope(frame, 7, 25, 40, 70)))
                rotation("cloak.1", (0.4 * envelope(frame, 5, 24, 47, 75), 0, 0.6 * raised))
            elif name == "Nod_Encourage":
                rotation("head", (5.0 * envelope(frame, 12, 27, 28, 46), 0, 0))
                for side in ("L", "R"):
                    rotation("ear." + side, (-0.9 * envelope(frame, 15, 30, 31, 49), 0, 0))
            elif name == "Guide_Point":
                raised = envelope(frame, 15, 35, 62, 90)
                translation("hand_ik.R", (-0.24 * raised, -0.05 * raised, 0.47 * raised))
                rotation("hand_ik.R", (-10 * raised, 0, 80 * raised))
                rotation("head", (0, -10 * envelope(frame, 5, 28, 60, 87), 0))
                for side in ("L", "R"):
                    poses["gaze." + side].location.x = 0.006 * envelope(frame, 1, 20, 60, 84)
                rotation("cloak.1", (0.5 * envelope(frame, 20, 40, 65, 90), 0, 0))
                rotation("tail.2", (0, 0, -2 * raised))
            elif name == "Step_InPlace":
                for side, offset in (("L", 0), ("R", 30)):
                    phase = (frame - offset) / 30
                    lift = math.sin(math.pi * phase) ** 2 if 0 <= phase <= 1 else 0
                    translation("foot_ik." + side, (0, 0, 0.045 * lift))
                    rotation("foot_ik." + side, (4 * lift, 0, 0))
                poses["pelvis"].location.x = -0.013 * math.sin(math.tau * frame / 60) ** 3
                rotation("tail.1", (0, 0, 1.8 * math.sin(math.tau * frame / 60) ** 3))
                rotation("bag", (0, 0, 1.1 * math.sin(math.tau * (frame - 4) / 60) * math.sin(math.pi * frame / 60) ** 2))
                rotation("cloak.2", (0.7 * math.sin(math.tau * frame / 60) ** 3, 0, 0))
            for pose in rig.pose.bones:
                for path in ("location", "rotation_euler", "scale"):
                    pose.keyframe_insert(data_path=path, frame=frame, group=pose.name)
        insert_track(rig, name, end)
    for owner in [rig] + [obj.data.shape_keys for obj in eyelids]:
        for track in owner.animation_data.nla_tracks:
            track.mute = False
            track.strips[0].blend_type = "REPLACE"
    scene.frame_set(0)


def build(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = bpy.data.objects.get("Lumi_Natural_v4_Rigged")
    if not root or root.get("character_id") != "lumi-animated-v4" or bpy.data.objects.get("Lumi_Rig"):
        raise RuntimeError("Open the prepared, unbound v4 runtime scene before binding")
    collection = bpy.data.collections["MICROGLOW_CAT_RUNTIME"]
    objects = [obj for obj in collection.all_objects if obj.type == "MESH"]
    eyelids = lids(collection, root)
    objects.extend(eyelids)
    rig = make_rig(collection, root)
    bind_meshes(objects, rig)
    animate(rig, eyelids)
    for obj in objects:
        obj.hide_render = False
        obj.hide_set(False)
    for obj in bpy.context.scene.objects:
        if obj.type == 'LIGHT':
            obj.hide_render = False
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects + [root, rig]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    model_path = output / "Lumi_Natural_v4_Animated.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(model_path), export_format="GLB", use_selection=True,
        export_apply=False, export_yup=True, export_cameras=False, export_lights=False,
        export_animations=True, export_animation_mode="NLA_TRACKS", export_frame_range=False,
        export_merge_animation="NLA_TRACK", export_force_sampling=True,
        export_anim_single_armature=False, export_skins=True, export_all_influences=False,
        export_morph=True, export_morph_normal=True, export_extras=True,
        export_vertex_color="ACTIVE", export_image_format="AUTO",
    )
    data = model_path.read_bytes()
    document = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
    triangles = sum(document["accessors"][primitive["indices"]]["count"] // 3
                    for mesh in document["meshes"] for primitive in mesh["primitives"])
    exported_clips = {item["name"] for item in document.get("animations", [])}
    if triangles > 100000 or document.get("cameras") or not document.get("skins") or exported_clips != set(CLIPS):
        raise RuntimeError("Rigged asset violates the character-only geometry or animation contract")
    source_path = Path("work/lumi-animated-v4/lumi-natural-v4-rigged.blend").resolve()
    source_path.parent.mkdir(parents=True, exist_ok=True)
    for owner in [rig] + [obj.data.shape_keys for obj in eyelids]:
        for track in owner.animation_data.nla_tracks:
            track.mute = track.name != "Idle_Breathe"
    bpy.context.scene.frame_set(0)
    bpy.ops.wm.save_as_mainfile(filepath=str(source_path), compress=True)
    manifest = {
        "schemaVersion": "1.0.0",
        "character": {"id": "lumi-animated-v4", "name": "露米 Lumi · 自然动作版", "assetVersion": "4.1.0"},
        "source": {"file": "lumi-natural-v4.blend", "sha256": root["source_blend_sha256"],
                   "riggedFile": source_path.name, "riggedSha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
                   "sourceGroomStrands": root["source_groom_strands"]},
        "runtime": {
            "file": model_path.name, "fileBytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "triangleCount": triangles, "meshCount": len(document["meshes"]), "frameRate": 30,
            "skeleton": {"boneCount": len(document["skins"][0]["joints"]),
                         "naming": "Anatomical L/R: left paw holds the wand; right paw waves"},
            "groom": {"cards": root["runtime_groom_cards"], "strandsPerCard": 5, "lossless": False},
            "animations": [{"name": name, "duration": frames / 30, "loop": name in {"Idle_Breathe", "Step_InPlace"},
                            "layer": "face" if name == "Blink_Soft" else "body"} for name, frames in CLIPS.items()],
            "morphTargets": ["Blink_L", "Blink_R"],
            "textures": [image["name"] for image in document.get("images", [])],
            "limitations": ["Runtime meshes and skinned groom cards, not lossless offline curve hair.",
                            "Cape and bag use authored secondary bones, not live cloth simulation.",
                            "No lip sync, full facial expression set or physical-device mobile performance certification."],
        },
    }
    (output / "character_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("LUMI_RIG_EXPORT " + json.dumps(manifest["runtime"]), flush=True)


if __name__ == "__main__":
    parameters = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    build(parameters[0])
