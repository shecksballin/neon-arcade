#!/bin/zsh
# Convert all 9 Mixamo FBX animations to GLB, merge into one multi-clip GLB.
set -e
BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"
SRC="/Users/sheck/Downloads/fable 5 fighter game/neon clumsy"
GAME="/Users/sheck/Downloads/fable 5 fighter game/neon-clumsy-game"
OUT="$GAME/build_glb"
TOOLS="$GAME/tools"

mkdir -p "$OUT"

convert() {
  echo "=== converting: $1 -> $2 ==="
  "$BLENDER" -b -P "$TOOLS/fbx2glb52.py" -- "$SRC/$1" "$OUT/$2" 2>&1 | grep -E "imported|NLA|normals|patch|done|WARNING|Error|error" || true
}

convert "Happy Idle.fbx"        idle.glb
convert "Walking.fbx"           walk.glb
convert "Sprint.fbx"            sprint.glb
convert "Sprint Turn right.fbx" sprintturnr.glb
convert "Sprint Turn left.fbx"  sprintturnl.glb
convert "Jumping Up.fbx"        jump.glb
convert "Falling.fbx"           fall.glb
convert "Soccer Trip.fbx"       trip.glb
convert "Getting Up.fbx"        getup.glb

echo "=== merging ==="
python3 "$TOOLS/glb_merge_anims.py" "$OUT/idle.glb" \
  "$OUT/walk.glb:Walk" \
  "$OUT/sprint.glb:Sprint" \
  "$OUT/sprintturnr.glb:SprintTurnR" \
  "$OUT/sprintturnl.glb:SprintTurnL" \
  "$OUT/jump.glb:Jump" \
  "$OUT/fall.glb:Fall" \
  "$OUT/trip.glb:Trip" \
  "$OUT/getup.glb:GetUp" \
  "$GAME/assets/models/mummy.glb"

echo "=== renaming base clip ==="
python3 "$TOOLS/rename_clip.py" "$GAME/assets/models/mummy.glb" "mixamo.com" "Idle"

echo "=== inspecting ==="
python3 "$TOOLS/glb_inspect.py" "$GAME/assets/models/mummy.glb"
echo "=== ALL DONE ==="
ls -la "$GAME/assets/models/"
