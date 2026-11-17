// HQ post, all at the low internal res: quarter-res thresholded bloom, then bloom + tonemap +
// gamma into an rgba8 target that the standard blit upscales (so full-res cost is unchanged).
// Only compiled when the HQ setting is enabled.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var blm: texture_2d<f32>;
@group(0) @binding(2) var sm: sampler;
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
// bloom: each quarter-res texel gathers 16 taps over an 8x8 footprint of the bright part
@fragment fn fb(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let m = vec2i(textureDimensions(src)) - 1; let c = vec2i(fc.xy) * 4; var s = vec3f(0.);
  for (var i = 0; i < 16; i++) {
    let v = textureLoad(src, clamp(c + vec2i(i % 4, i / 4) * 2 - 2, vec2i(0), m), 0).rgb;
    s += max(v - 1.8, vec3f(0.));
  }
  return vec4f(s / 16., 1.);
}
fn aces(x: vec3f) -> vec3f { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.), vec3f(1.)); }
@fragment fn fo(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ip = vec2i(fc.xy); let ds = vec2f(textureDimensions(src));
  let c4 = textureLoad(src, ip, 0); var c = c4.rgb;
  // pixel-quantised bloom lookup (keeps the glow blocky like the rest), tent of 5 bilinear taps
  let uv = (vec2f(ip) + .5) / ds; let o = 6. / ds; var b = textureSampleLevel(blm, sm, uv, 0.).rgb * 2.;
  b += textureSampleLevel(blm, sm, uv + vec2f(o.x, o.y), 0.).rgb + textureSampleLevel(blm, sm, uv - vec2f(o.x, o.y), 0.).rgb;
  b += textureSampleLevel(blm, sm, uv + vec2f(o.x, -o.y), 0.).rgb + textureSampleLevel(blm, sm, uv - vec2f(o.x, -o.y), 0.).rgb;
  let q = o * 1.2;   // + axis taps: round glow instead of an X
  b += textureSampleLevel(blm, sm, uv + vec2f(q.x, 0.), 0.).rgb + textureSampleLevel(blm, sm, uv - vec2f(q.x, 0.), 0.).rgb;
  b += textureSampleLevel(blm, sm, uv + vec2f(0., q.y), 0.).rgb + textureSampleLevel(blm, sm, uv - vec2f(0., q.y), 0.).rgb;
  b *= 0.6;
  // hue-preserving ACES on the max channel keeps the saturated palette; very hot pixels go white
  c = (c + b * 0.5) * 0.85; let m = max(max(c.r, c.g), max(c.b, 1e-4)); let tm = aces(vec3f(m)).x;
  c = sqrt(mix(c * (tm / m), vec3f(tm), smoothstep(1., 6., m)));
  return vec4f(c, c4.a);   // alpha = surface id for the 'Mjuka kanter' upscale (1 otherwise)
}
