@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> B: vec4f;
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(fc.xy / B.x), 0);
}
