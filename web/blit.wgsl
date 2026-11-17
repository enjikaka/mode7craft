@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> B: vec4f;   // x = screen px per internal px, y = crosshair, z = art-pixel scale (Skarpa), w = 1: Mjuka kanter
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
// same surface: equal surface id (alpha) and no strong colour jump (water bands, shadows edges stay pixel)
fn sim(a: vec4f, b: vec4f) -> bool { let e = abs(a - b); return e.a < 0.002 && e.r + e.g + e.b < 0.5; }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ip = vec2i(fc.xy / B.x); var c = textureLoad(src, ip, 0);
  if (B.w > 0.5) {
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
