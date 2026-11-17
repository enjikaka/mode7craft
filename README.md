# Mode7craft v8

![Mode7craft](docs/screenshot.png)

A tiny Minecraft-style island rendered SNES Mode 7 / sprite-stacking style: no meshes, no polygons.

- `core/`: Rust `no_std` -> wasm32 (no wasm-bindgen). It handles world gen (a 128x128x16 voxel island with birch trees), player physics/collision, and the mutable world: `pick` (DDA raycast), `break_block`, `place_block` (refuses cells that overlap the player; z=0 is bedrock) and incremental heightmap updates.
- Block editing: only the touched voxel and heightmap texel are re-uploaded to the GPU. Hotbar: grass, dirt, stone, sand, birch log, leaves, planks, torch. Edits persist in localStorage (`m7c-edits-1`); `?reset` clears them.
- Birch logs are analytic ray-cylinder hits (they cast round shadows too) with procedural bark: off-white, dark dashes and sparse knots.
- `web/scene.wgsl`: one full-screen fragment shader, no meshes. Terrain and trees use an exact voxel DDA (Amanatides-Woo) over the block grid. The sprite-stacked avatar uses a texel DDA in its own bounding box. Clouds are stacked 2D slices. The whole cloud cluster that hides the avatar, or that it stands under, is drawn at ~50% with a screen-stable 4x4 Bayer dither; clouds near the camera step down in dither levels. Views: chase, first person (with a pixel crosshair drawn in the blit pass) and top-down. V, Y or VIEW cycles them. 8x8 procedural pixel textures, shadows, water/foam and fog.
- Edges (v8, settings row `Kanter`, saved as `m7c-edge`, `?edge=0|1|2`). The default `Pixel` is the classic look and is pixel-identical to v7.
  - `Mjuka` (cheap): edge-aware upscale in `blit.wgsl`. The scene writes a surface id into alpha (coplanar faces share one), and the blit applies a Scale2x-style corner rule with an anti-aliased 45-degree cut only where real geometry meets. Staircases on silhouettes, block steps and the shore become smooth diagonals; texture texels, dithering and water bands stay pixel-sharp. It costs 5 texel loads per screen pixel and nothing extra in the scene. Works in Standard and HQ.
  - `Skarpa` (native-res): rays are traced at up to native resolution. The budget is 1.0M internal pixels in Standard and 0.5M in HQ, DPR-aware, with a fractional scale. Because all shading already reads the 8x8 texel grid (textures, shadow probes, water texels, cloud cells), surfaces keep their big SNES texels while silhouettes, the shoreline, water-band edges and the avatar become crisp at screen resolution. Cloud dither, the target outline and the crosshair are scaled back to the classic pixel size (`U[9].w` / blit `B.z`). Dynamic resolution still steps the budget down by 0.75 until about 45 fps holds, so weak phones end up near the classic resolution.
- Layered water (v7, Standard and HQ), after asynkimo's "Basic water tile vs Layered water":
  - Stepped depth bands, from semi-transparent shallow teal over the sand to opaque deep blue-teal. Depth comes from the sea-floor height, smoothed over block columns and jittered per 2x2 texels, so band edges are pixel-art steps that follow the slope.
  - The sea floor slopes at about half the land slope (generator change below sea level only), so there are wide shallow shelves.
  - Through the shallow bands a short refracted ray (12 DDA steps) shows the sea floor, the submerged bases of blocks and trunks, and the avatar's legs, all tinted teal. Open deep sea skips that ray.
  - A 1-texel light-blue/white shoreline where the surface touches anything solid: the coast, placed blocks, round logs. It pulses slowly, with a dotted second ring.
  - Shadows from trees, objects and clouds darken the water and suppress sparkles.
  - Sparkles are fixed spots that twinkle in frame steps, mostly over shallow lit water.
  - Wading: the shallow shelf (floor 0.75 below the surface) is walkable, with a foam ring and a slow ripple around the avatar. Deeper sea is still a wall.
  - In HQ the layered colour is lit by sun and sky. Reflections are weak over the shallows and strongest over deep water at grazing angles, and the sun glint is kept. Foam and sparkles are lit diffusely without reflection.
  - Everything outside water is unchanged from v6 in Standard: verified with `tools/maskdiff.py` against a water-mask build.
- Torches (hotbar slot 8): pixel-art stick with a flickering flame, no collision (you can walk through them and place them where you stand). The nearest 32 torches (re-sorted every 0.3 s) go into a 512-byte uniform list; each is a warm point light with range 8 and per-torch flicker. Standard adds a subtle unoccluded warm glow. HQ uses an emissive flame (it blooms) and a shadow ray per torch, so walls block the light.
- Sunlight through tree crowns (HQ only): sun shadow rays pass through leaves with a per-voxel transmittance (some voxels let 80% of the light through, the rest 12%), which gives dappled light on the ground. Backlit leaves glow when you look toward the sun, and the light shafts trace the canopy near the ground.
- World save/share (settings panel, row `Värld`):
  - `Exportera värld` downloads `mode7craft.m7c`.
  - `Importera värld` opens a file picker. The file is validated, and you are asked to confirm before it replaces a world that has edits.
  - `Dela länk` creates `...#w=<base64url>`. On phones it uses the share sheet; on desktop it copies the link to the clipboard. Links over 30k chars are refused; use the file instead.
  - Opening a `#w=` link loads the world, removes the hash and saves the world to localStorage.
  - File format v1: `M7C` + version byte (1) + flags byte (1 = deflate-raw), then the deflate-raw (CompressionStream) payload, which is 3 bytes per edit: `(index delta << 4) | block id`, big-endian, with indices sorted. A typical house with torches (~80 edits) is about 90 bytes.
- `web/blit.wgsl`: nearest-neighbour integer upscale of the low-res target.
- Settings (gear button top-right, `G`, or Xbox Start/Menu): `Grafik: Standard / HQ` and `Tid (HQ): Dag / Kväll / Cykel`, saved in localStorage (`m7c-fx`, `m7c-tod`). Standard is the default and renders pixel-identically to v4. In the open panel (rows Grafik, Tid, Kanter, Värld), arrow keys / D-pad pick a row and change the value. On the `Värld` row, Enter / A runs the selected action. Esc / G / B / Start close the panel.
- HQ ("AAA shaders"): the same `scene.wgsl` built a second time with the pipeline-overridable constant `HQ=true`, so the standard pipeline compiles none of the HQ code. HQ lighting:
  - per-voxel AO
  - soft sun shadows (3-ray cone, sharp at contact), with translucent cloud shadows
  - sky light plus one coloured bounce from the ground block
  - water with reflection ray, Fresnel, refraction tint and sun glint
  - dithered light shafts/haze through cloud shadows
  - sun disc
  - rgba16float HDR target, quarter-res bloom (`web/hq.wgsl`), hue-preserving ACES tonemap
  - day / golden hour / 4-min day-night cycle
  HQ textures are allocated only while HQ is on, and its dynamic resolution starts lower (70k vs 115k internal pixels).
- `web/main.js`: WebGPU setup plus input (touch, gamepad, keyboard/mouse).

    node tools/build.ts                  # build -> dist/ (+ .gz/.br)
    node tools/serve.ts                  # http://localhost:8787
    node tools/shot.ts URL out.png W H   # headless Chrome (SwiftShader WebGPU) screenshot
    node tools/map.ts [seed]             # ASCII map of the generated island
    node tools/test-edit.ts              # Node tests for pick/break/place/collision
    FREEZE=1 NOUI=1 node tools/shot.ts ...  # frozen clock + hidden DOM overlays: deterministic, diffable frames
    python3 tools/diff.py a.png b.png    # pixel diff (used to prove Standard == v4)
    python3 tools/maskdiff.py old.png new.png mask.png  # changed pixels outside water (Standard v6 vs v7 check)

URL params (debug): `?fx=0|1` graphics Standard/HQ, `?edge=0|1|2` edges Pixel/Mjuka/Skarpa, `?tod=day|eve|cyc|<hours>` HQ sun, `?area=` internal pixel budget, `?v=0|1|2` chase / first person / top-down, `?z=1.5` zoom, `?r=3.14` camera yaw offset, `?pt=0.4` pitch, `?p=75,65` teleport, `?t=40` cloud time offset.
wasm-opt is looked up on PATH, then in node_modules/.bin.

Controls:
- Settings: gear button (tap/click), `G`, or Xbox Start/Menu.
- Desktop: WASD move, Space jump, Shift run, V view. In first person, click to lock the pointer; LMB breaks, RMB places, and 1-8 or the wheel picks a block. In chase/top-down, click breaks at the pointer, right-click places, drag looks and the wheel zooms. X/C break/place at the block ahead.
- Xbox: left stick move, right stick look, A jump, B/L3 run, Y view, RT break, LT place, LB/RB zoom, D-pad left/right block. In the settings panel: D-pad navigates and A runs a world action (the file picker needs a tap or click, so browsers block it from the gamepad).
- Touch: left side is the joystick, right side drag-look. Tap acts in BREAK/PLACE mode (toggle button); long-press places. In first person the ● button acts at the crosshair. Tap hotbar slots to pick a block.
