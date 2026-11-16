@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> B: vec4f;
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ip = vec2i(fc.xy / B.x); var c = textureLoad(src, ip, 0);
  if (B.y > 0.5) {
    // tiny pixel crosshair at the low internal resolution (first-person view)
    let d = abs(ip - vec2i(textureDimensions(src)) / 2);
    let arm = (d.x == 0 && d.y >= 1 && d.y <= 3) || (d.y == 0 && d.x >= 1 && d.x <= 3);
    let rim = !arm && d.x <= 4 && d.y <= 4 && (d.x <= 1 || d.y <= 1);
    if (arm) { c = vec4f(1., 0.97, 0.75, 1.); } else if (rim) { c = vec4f(c.rgb * 0.45, 1.); }
  }
  return c;
}
