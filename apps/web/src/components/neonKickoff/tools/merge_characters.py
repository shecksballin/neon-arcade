"""Merge each character's Mixamo clips into a single GLB.

Every Mixamo download ships the full skinned mesh, so seven separate exports
carried seven copies of the same body. Mixamo rigs share bone names, so the
extra clips can ride on one skeleton: import the base, keep only its mesh, and
graft every other file's action onto it.

  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/merge_characters.py
"""
import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "assets")

CHARACTERS = {
    "goalie": {
        "base": ("goalie/Goalkeeper Idle.fbx", "idle"),
        "extra": [
            ("goalie/Goalkeeper Catch.fbx", "catch"),
            ("goalie/Goalkeeper Diving Save L.fbx", "dive-left"),
            ("goalie/Goalkeeper Diving Save R.fbx", "dive-right"),
        ],
    },
    "striker": {
        "base": ("striker/Offensive Idle.fbx", "idle"),
        "extra": [
            ("striker/Strike Foward Jog.fbx", "strike"),
            ("striker/Jog Forward.fbx", "jog"),
        ],
    },
}


def import_fbx(rel):
    bpy.ops.import_scene.fbx(
        filepath=os.path.join(ROOT, rel),
        automatic_bone_orientation=True,
        ignore_leaf_bones=True,
    )
    return [o for o in bpy.context.selected_objects]


def armature_of(objects):
    for o in objects:
        if o.type == "ARMATURE":
            return o
    return None


def action_of(arm):
    ad = arm.animation_data
    return ad.action if ad else None


for name, spec in CHARACTERS.items():
    print(f"\n=== building {name}")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    base_objs = import_fbx(spec["base"][0])
    base_arm = armature_of(base_objs)
    base_action = action_of(base_arm)
    if base_action:
        base_action.name = spec["base"][1]
        base_action.use_fake_user = True
    print(f"  base armature {base_arm.name}, action {base_action.name if base_action else None}")

    for rel, clip_name in spec["extra"]:
        objs = import_fbx(rel)
        arm = armature_of(objs)
        act = action_of(arm)
        if act:
            act.name = clip_name
            act.use_fake_user = True   # survives the armature it came in on
            print(f"  + clip {clip_name}")
        # drop the duplicated body — the base skeleton plays every clip
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.ops.object.delete()

    # stash every action as an NLA strip so the exporter emits all of them
    if base_arm.animation_data is None:
        base_arm.animation_data_create()
    base_arm.animation_data.action = None
    for act in bpy.data.actions:
        track = base_arm.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, int(act.frame_range[0]), act)

    dst = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_apply=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_yup=True,
    )
    print(f"[export] {name}.glb — {os.path.getsize(dst)/1e6:.1f} MB, "
          f"{len(bpy.data.actions)} clips")

print("\n[done] characters merged")
