"""Convert the shipped FBX assets to GLB.

Three.js parses a 16MB FBX in tens of seconds; the same content as GLB loads in
about a second. Run with:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/convert_assets.py
"""
import os
import sys

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "assets")
TEXTURES = os.path.join(OUT, "stadium", "textures")


def wipe():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path):
    bpy.ops.import_scene.fbx(
        filepath=path,
        automatic_bone_orientation=True,
        ignore_leaf_bones=True,
    )


def relink_images():
    """The FBX points at dead Windows paths — repoint every image by basename."""
    found, missing = 0, []
    for img in bpy.data.images:
        if not img.filepath:
            continue
        base = img.filepath.replace("\\", "/").split("/")[-1]
        candidate = os.path.join(TEXTURES, base)
        if os.path.exists(candidate):
            img.filepath = candidate
            try:
                img.reload()
                found += 1
            except RuntimeError:
                missing.append(base)
        else:
            missing.append(base)
    print(f"[textures] relinked {found}, missing {len(missing)}: {sorted(set(missing))}")


def export_glb(path, animations=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_draco_mesh_compression_enable=False,
        export_yup=True,
    )
    size = os.path.getsize(path) / 1e6
    print(f"[export] {os.path.relpath(path, ROOT)} — {size:.1f} MB")


def convert(src, dst, animations=True, relink=False):
    print(f"\n=== {src} -> {dst}")
    wipe()
    import_fbx(src)
    if relink:
        relink_images()
    export_glb(dst, animations)


JOBS = [
    # (source fbx, destination glb, keep animations, relink textures)
    ("neon-kickoff-stadium/glow-stadium-pbr.fbx", "stadium/stadium.glb", False, True),
    ("striker/Offensive Idle.fbx", "striker/idle.glb", True, False),
    ("striker/Strike Foward Jog.fbx", "striker/strike.glb", True, False),
    ("striker/Jog Forward.fbx", "striker/jog.glb", True, False),
    ("goalie/Goalkeeper Idle.fbx", "goalie/idle.glb", True, False),
    ("goalie/Goalkeeper Catch.fbx", "goalie/catch.glb", True, False),
    ("goalie/Goalkeeper Diving Save L.fbx", "goalie/dive-left.glb", True, False),
    ("goalie/Goalkeeper Diving Save R.fbx", "goalie/dive-right.glb", True, False),
]

for src, dst, anims, relink in JOBS:
    src_path = os.path.join(ROOT, src)
    if not os.path.exists(src_path):
        print(f"!! missing source: {src}", file=sys.stderr)
        continue
    convert(src_path, os.path.join(OUT, dst), anims, relink)

print("\n[done] all conversions finished")
