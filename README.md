# Mode7craft v1

![Mode7craft](docs/screenshot.png)

A tiny Minecraft-style island rendered SNES Mode 7 / sprite-stacking style: no meshes, no polygons.

- `core/`: Rust `no_std` -> wasm32 (no wasm-bindgen). It handles world gen (128x128x16 voxel island, trees) and player physics/collision.
- `web/scene.wgsl`: one full-screen fragment shader. Each pixel walks down 1/8-block horizontal slices (a Mode 7 plane projection per slice) until it hits a texel, so the world, trees, avatar and clouds are all stacked 2D slices. Textures are procedural. It also does shadows, water/foam and fog.
- `web/blit.wgsl`: nearest-neighbour integer upscale of the low-res target.
- `web/main.js`: WebGPU setup plus input (touch, gamepad, keyboard/mouse).

    node tools/build.ts                  # build -> dist/ (+ .gz/.br)
    node tools/serve.ts                  # http://localhost:8787
    node tools/shot.ts URL out.png W H   # headless Chrome (SwiftShader WebGPU) screenshot
    node tools/map.ts [seed]             # ASCII map of the generated island

URL params: `?v=1` top-down view, `?z=1.5` zoom, `?r=3.14` camera yaw offset.
