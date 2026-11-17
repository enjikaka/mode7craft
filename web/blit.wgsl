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
