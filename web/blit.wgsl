@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> B: vec4f;   // x = screen px per internal px, y = crosshair, z = art-pixel scale (Skarpa), w bit 1: Mjuka kanter, bit 2: dithering
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
// same surface: equal surface id (alpha) and no strong colour jump (water bands, shadows edges stay pixel)
const LV = 16.; const DW = 0.25;   // levels per channel, half-width of the dithered zone around each step
fn sim(a: vec4f, b: vec4f) -> bool { let e = abs(a - b); return e.a < 0.002 && e.r + e.g + e.b < 0.5; }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ip = vec2i(fc.xy / B.x); var c = textureLoad(src, ip, 0);
  let fl = u32(B.w);
  if ((fl & 1u) != 0u) {
    // 'Mjuka kanter': Scale2x-style corner rule on the internal pixels, with an anti-aliased 45-degree
    // cut instead of a hard quadrant, so staircases turn into smooth diagonals (5 loads, no blur on flat areas)
    let q = fc.xy / B.x; let f = fract(q) - 0.5; let s = select(vec2i(-1), vec2i(1), f >= vec2f(0.));
    let m = vec2i(textureDimensions(src)) - 1;
    let A = textureLoad(src, clamp(ip + vec2i(s.x, 0), vec2i(0), m), 0); let V = textureLoad(src, clamp(ip + vec2i(0, s.y), vec2i(0), m), 0);
    let C = textureLoad(src, clamp(ip - vec2i(s.x, 0), vec2i(0), m), 0); let D = textureLoad(src, clamp(ip - vec2i(0, s.y), vec2i(0), m), 0);
    if (sim(A, V) && !sim(A, c) && !sim(V, C) && !sim(A, D)) {
      let k = abs(f) * 2.;   // 0 at the pixel centre .. 1 at the corner shared with A and V
      c = vec4f(mix(c.rgb, (A.rgb + V.rgb) * 0.5, clamp((k.x + k.y - 1.) * B.x * 0.35 + 0.5, 0., 1.)), 1.);
    }
  }
  if ((fl & 2u) != 0u) {
    // SNES-style ordered dithering: 4x4 Bayer threshold per art pixel, quantised to a limited palette per channel
    let z = max(B.z, 1.); let q = vec2u(floor(fc.xy / (B.x * z))) & vec2u(3u);
    let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
    // flat bands with a dithered transition around each band edge (not dither everywhere)
    let v = c.rgb * LV; let f = fract(v); let th = (f32(m[q.y * 4u + q.x]) + 0.5) / 16.;
    c = vec4f((floor(v) + select(vec3f(0.), vec3f(1.), clamp((f - 0.5 + DW) / (2. * DW), vec3f(0.), vec3f(1.)) > vec3f(th))) / LV, 1.);
  }
  if (B.y > 0.5) {
    // tiny pixel crosshair at the low internal resolution (first-person view); art-pixel sized in Skarpa
    let z = max(B.z, 1.);
    let d = abs(vec2i(floor(fc.xy / (B.x * z))) - vec2i(vec2f(textureDimensions(src)) / z) / 2);
    let arm = (d.x == 0 && d.y >= 1 && d.y <= 3) || (d.y == 0 && d.x >= 1 && d.x <= 3);
    let rim = !arm && d.x <= 4 && d.y <= 4 && (d.x <= 1 || d.y <= 1);
    if (arm) { c = vec4f(1., 0.97, 0.75, 1.); } else if (rim) { c = vec4f(c.rgb * 0.45, 1.); }
  }
  return c;
}
// ---------- v13: 'SS+palett' edges and 'SNES-läge' (entry fq; only built when one of them is on) ----------
// Both end in the same palette snap: the colour is cut to 15 bits (5-5-5, like the SNES) and looked up in a
// 32x32x32 table (1024x32 texture) that holds the nearest of 256 palette colours built from the block colours.
@group(0) @binding(2) var lut: texture_2d<f32>;
// Q[0] = (letterbox x, y in screen px, mode 1 = SS / 2 = SNES, dither), Q[1] = (sin pitch, cos pitch, tanV, camera height),
// Q[2] = (view distance, fog start fraction, fog strength, -), Q[3].rgb = horizon fog colour
@group(0) @binding(3) var<uniform> Q: array<vec4f, 4>;
fn palQ(c: vec3f, cell: vec2i, dit: bool) -> vec3f {
  var v = c;
  if (dit) {
    let q = vec2u(cell) & vec2u(3u); let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
    v += ((f32(m[q.y * 4u + q.x]) + 0.5) / 16. - 0.5) * 0.09;
  }
  let k = vec3i(round(clamp(v, vec3f(0.), vec3f(1.)) * 31.));
  return textureLoad(lut, vec2i(k.r + k.b * 32, k.g), 0).rgb;
}
@fragment fn fq(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(src)); let m = dims - 1;
  var c: vec3f; var cell: vec2i; var gd = dims;
  if (Q[0].z > 1.5) {
    // SNES: fixed 256x224, integer scale (nearest), black letterbox around it
    let l = fc.xy - Q[0].xy; cell = vec2i(floor(l / B.x));
    if (any(l < vec2f(0.)) || any(cell > m)) { return vec4f(0., 0., 0., 1.); }
    c = textureLoad(src, cell, 0).rgb;
    // HDMA-style horizon fog: one value per scanline from where that line's centre ray meets the ground plane
    let ny = (1. - 2. * (f32(cell.y) + 0.5) / f32(dims.y)) * Q[1].z; let dz = Q[1].x - Q[1].y * ny;
    var f = 1. - clamp((ny - Q[1].x / Q[1].y) / (0.24 * Q[1].z), 0., 1.);   // above the horizon: fades out over ~12% of the screen
    if (dz > 0.) { f = smoothstep(Q[2].x * Q[2].y, Q[2].x, Q[1].w * (Q[1].y + Q[1].x * ny) / dz); }
    // fog colour: the sky just above the horizon (4 samples on that line) when it is on screen, else Q[3]
    let hr = i32(floor((1. - Q[1].x / Q[1].y / Q[1].z) * 0.5 * f32(dims.y))) - 2; var fc3 = Q[3].rgb;
    if (hr >= 0 && hr < dims.y) { fc3 = vec3f(0.); for (var k = 0; k < 4; k++) { fc3 += textureLoad(src, vec2i(dims.x * (2 * k + 1) / 8, hr), 0).rgb * 0.25; } }
    c = mix(c, fc3, f * Q[2].z);
  } else {
    // SS: 2x2 internal pixels per output pixel, box-filtered, then snapped (clean edges, no shimmer)
    cell = vec2i(floor(fc.xy / (B.x * 2.))); let b = cell * 2; gd = dims / 2;
    c = (textureLoad(src, min(b, m), 0).rgb + textureLoad(src, min(b + vec2i(1, 0), m), 0).rgb
       + textureLoad(src, min(b + vec2i(0, 1), m), 0).rgb + textureLoad(src, min(b + vec2i(1, 1), m), 0).rgb) * 0.25;
  }
  c = palQ(c, cell, Q[0].w > 0.5);
  if (B.y > 0.5) {
    let d = abs(cell - gd / 2);
    let arm = (d.x == 0 && d.y >= 1 && d.y <= 3) || (d.y == 0 && d.x >= 1 && d.x <= 3);
    let rim = !arm && d.x <= 4 && d.y <= 4 && (d.x <= 1 || d.y <= 1);
    if (arm) { c = vec3f(1., 0.97, 0.75); } else if (rim) { c *= 0.45; }
  }
  return vec4f(c, 1.);
}
// builds the 15-bit -> palette table once: texel (r + 32 b, g) = nearest palette colour (red-mean weighted RGB)
@group(0) @binding(4) var<uniform> PAL: array<vec4f, 256>;
@fragment fn fp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let x = u32(fc.x); let c = vec3f(f32(x & 31u), floor(fc.y), f32(x >> 5u)) / 31.;
  var bd = 1e9; var bc = vec3f(0.);
  for (var i = 0; i < 256; i++) {
    let p = PAL[i].rgb; let e = c - p; let r = (c.r + p.r) * 0.5;
    let d = (2. + r) * e.r * e.r + 4. * e.g * e.g + (3. - r) * e.b * e.b;
    if (d < bd) { bd = d; bc = p; }
  }
  return vec4f(bc, 1.);
}
