# Mode7craft v5

![Mode7craft](docs/screenshot.png)

A tiny Minecraft-style island rendered SNES Mode 7 / sprite-stacking style: no meshes, no polygons.

- `core/`: Rust `no_std` -> wasm32 (no wasm-bindgen). It handles world gen (a 128x128x16 voxel island with birch trees), player physics/collision, and the mutable world: `pick` (DDA raycast), `break_block`, `place_block` (refuses cells that overlap the player; z=0 is bedrock) and incremental heightmap updates.
- Block editing: only the touched voxel and heightmap texel are re-uploaded to the GPU. Hotbar: grass, dirt, stone, sand, birch log, leaves, planks. Edits persist in localStorage (`m7c-edits-1`); `?reset` clears them.
- Birch logs are analytic ray-cylinder hits (they cast round shadows too) with procedural bark: off-white, dark dashes and sparse knots.
- `web/scene.wgsl`: one full-screen fragment shader, no meshes. Terrain and trees use an exact voxel DDA (Amanatides-Woo) over the block grid. The sprite-stacked avatar uses a texel DDA in its own bounding box. Clouds are stacked 2D slices. The whole cloud cluster that hides the avatar, or that it stands under, is drawn at ~50% with a screen-stable 4x4 Bayer dither; clouds near the camera step down in dither levels. Views: chase, first person (with a pixel crosshair drawn in the blit pass) and top-down. V, Y or VIEW cycles them. 8x8 procedural pixel textures, shadows, water/foam and fog.
- `web/blit.wgsl`: nearest-neighbour integer upscale of the low-res target.
- Settings (gear button top-right, `G`, or Xbox Start/Menu): `Grafik: Standard / HQ` and `Tid (HQ): Dag / Kväll / Cykel`, saved in localStorage (`m7c-fx`, `m7c-tod`). Standard is the default and renders pixel-identically to v4. In the open panel, arrow keys / D-pad pick a row and change the value, and Esc / G / B / Start close it.
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

URL params (debug): `?fx=0|1` graphics Standard/HQ, `?tod=day|eve|cyc|<hours>` HQ sun, `?area=` internal pixel budget, `?v=0|1|2` chase / first person / top-down, `?z=1.5` zoom, `?r=3.14` camera yaw offset, `?pt=0.4` pitch, `?p=75,65` teleport, `?t=40` cloud time offset.
wasm-opt is looked up on PATH, then in node_modules/.bin.

Controls:
- Settings: gear button (tap/click), `G`, or Xbox Start/Menu.
- Desktop: WASD move, Space jump, Shift run, V view. In first person, click to lock the pointer; LMB breaks, RMB places, and 1-7 or the wheel picks a block. In chase/top-down, click breaks at the pointer, right-click places, drag looks and the wheel zooms. X/C break/place at the block ahead.
- Xbox: left stick move, right stick look, A jump, B/L3 run, Y view, RT break, LT place, LB/RB zoom, D-pad left/right block.
- Touch: left side is the joystick, right side drag-look. Tap acts in BREAK/PLACE mode (toggle button); long-press places. In first person the ● button acts at the crosshair. Tap hotbar slots to pick a block.
