// The playable maps.
//
// `scale` converts the GLB's authoring units into game metres. The character is 1.8m, so
// props with a known real-world size are what calibrate it — get this wrong and the pug
// reads as a toy or a giant no matter how good the art is.
//
// `solid` / `ground` / `prop` are matched against each mesh's name *and* its material
// name, because these models come from different pipelines: the city kit carries meaning
// in its object names, while the warehouse ships as Cube.031 with a material called
// "floor". Matching both means neither model has to be renamed.

export const MAPS = {
  city: {
    label: 'Neon Suburbs',
    describe: 'open streets · long sightlines',
    credit: 'map made by kenny',
    file: 'neonpugshootermap.glb',
    scale: 1,
    interior: false,
    grass: true,
    solid: /building|planter|construction|barrier|fence|light-square|light-curved/i,
    ground: /plane|road|driveway|crossroad|intersection|sidewalk/i,
    prop: /planter|construction|barrier|cone|fence/i,
  },

  warehouse: {
    label: 'Cold Storage',
    describe: 'interior · close quarters',
    credit: 'map made by argonius',
    file: '/neonpugshootercomponents/coldStoragemap.glb',
    // Authored ~1.33× life size: its barrels are 0.75u across and its pallets 1.58u,
    // against a real drum's 0.58m and a real pallet's 1.2m. 0.75 lands both on the money
    // and puts the floor at 35m square under a 9.3m roof, with 2.5m industrial doors.
    scale: 0.75,
    interior: true,
    grass: false,
    // Compact props only. The shell pieces — walls, roof, girders, supports — are single
    // meshes spanning the whole building, and a bounding box round one of those covers the
    // entire floor, which makes every spawn point look blocked. Rapier tests them exactly
    // from the trimesh anyway; the boxes are only here to keep spawns off the clutter.
    solid: /container|barrel|pallet|box|crate|shelf|metal_bars|forkli/i,
    ground: /floor/i,
    // rounded or irregular clutter, where a tight rectangle overshoots badly
    prop: /barrel|pallet|box|crate|cone|forkli/i,
    // A roof that casts shadows puts the entire floor in the dark, because the only key
    // light is above it. Let the sun through it instead — it still receives shadow, so
    // the ceiling reads solid, but the racks and the pugs below actually get lit.
    letLightThrough: /roof|ceiling/i,
    // The model ships its own light fittings. Hanging a lamp under each one puts pools on
    // the floor, which is most of what sells a shed as interior rather than a lit box.
    lamps: { match: /^Lamp/i, color: '#ffd9a8', intensity: 26, distance: 26, max: 6 },
  },
};

export const DEFAULT_MAP = 'city';
