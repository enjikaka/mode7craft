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
// ---------- v13.2 HQ anti-aliasing (HQ + Skarpa): temporal super-resolution to the native screen ----------
// Each frame the scene rays are jittered (Halton 2,3 over 16 frames) inside their internal pixel. This pass runs
// at the full screen resolution: it rebuilds the current frame from the 3x3 jittered samples around the pixel
// (Gaussian by distance to each sample), reprojects last frame's result with the hit distance and the previous
// camera (Catmull-Rom, keeps it sharp), clips that history to the colour range of the current neighbourhood
// (YCoCg variance box, no ghosting) and blends. Static views converge to ~16+ rays per screen pixel.
@group(0) @binding(3) var cur: texture_2d<f32>;   // tonemapped scene (internal res)
@group(0) @binding(4) var dep: texture_2d<f32>;   // HDR scene, alpha = hit distance (6e4 = sky)
@group(0) @binding(5) var his: texture_2d<f32>;   // last frame's result (screen res)
// A[0] = (o, px), A[1] = (F, tan), A[2] = (R, aspect), A[3] = (Up, reset); A[4..7] = the same for the previous
// frame; A[8] = (jitter xy, extent xy = internal size * px), A[9] = (previous extent xy, -, -)
@group(0) @binding(6) var<uniform> A: array<vec4f, 10>;
fn ycc(c: vec3f) -> vec3f { return vec3f(c.r * .25 + c.g * .5 + c.b * .25, c.r * .5 - c.b * .5, c.g * .5 - c.r * .25 - c.b * .25); }
fn rgb(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
fn hcr(p: vec2f) -> vec3f {
  let ds = vec2f(textureDimensions(his)); let s = p - .5; let t1 = floor(s) + .5; let f = s - floor(s);
  let w0 = f * (-.5 + f * (1. - .5 * f)); let w1 = 1. + f * f * (-2.5 + 1.5 * f); let w2 = f * (.5 + f * (2. - 1.5 * f)); let w3 = f * f * (-.5 + .5 * f);
  let w12 = w1 + w2; let t0 = (t1 - 1.) / ds; let t3 = (t1 + 2.) / ds; let tc = (t1 + w2 / w12) / ds;
  var c = textureSampleLevel(his, sm, vec2f(tc.x, t0.y), 0.).rgb * (w12.x * w0.y) + textureSampleLevel(his, sm, vec2f(t0.x, tc.y), 0.).rgb * (w0.x * w12.y);
  c += textureSampleLevel(his, sm, tc, 0.).rgb * (w12.x * w12.y);
  c += textureSampleLevel(his, sm, vec2f(t3.x, tc.y), 0.).rgb * (w3.x * w12.y) + textureSampleLevel(his, sm, vec2f(tc.x, t3.y), 0.).rgb * (w12.x * w3.y);
  let n = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / n, vec3f(0.));
}
@fragment fn ft(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let m = vec2i(textureDimensions(cur)) - 1; let q = fc.xy / A[0].w; let ip = vec2i(floor(q));
  var s = vec3f(0.); var ws = 0.; var wm = 0.; var m1 = vec3f(0.); var m2 = vec3f(0.); var lo = vec3f(9.); var hi = vec3f(-9.); var z = 1e9;
  for (var k = 0; k < 9; k++) {
    let o = vec2i(k % 3 - 1, k / 3 - 1); let p = clamp(ip + o, vec2i(0), m);
    let c = ycc(textureLoad(cur, p, 0).rgb);
    let e = q - (vec2f(ip + o) + .5 + A[8].xy); let w = exp(-3. * dot(e, e));
    s += c * w; ws += w; wm = max(wm, w); m1 += c; m2 += c * c; lo = min(lo, c); hi = max(hi, c);
    z = min(z, textureLoad(dep, p, 0).a);
  }
  let c = s / ws;
  // where was this surface last frame (hit distance + both cameras)
  let uv = fc.xy / A[8].zw * 2. - 1.; let nd = vec2f(uv.x * A[2].w, -uv.y) * A[1].w;
  let d = normalize(A[1].xyz + A[2].xyz * nd.x + A[3].xyz * nd.y);
  let v = select(A[0].xyz + d * z - A[4].xyz, d, z > 5e4);
  let pz = dot(v, A[5].xyz); let pn = vec2f(dot(v, A[6].xyz) / A[6].w, -dot(v, A[7].xyz)) / (pz * A[5].w);
  let hp = (pn * .5 + .5) * A[9].xy;
  if (A[3].w > .5 || pz <= 0. || any(hp < vec2f(0.)) || any(hp > vec2f(textureDimensions(his)))) { return vec4f(rgb(c), 1.); }
  // clip the history towards the current neighbourhood's mean, inside its min/max and +-1.25 sigma box
  let mu = m1 / 9.; let sg = sqrt(max(m2 / 9. - mu * mu, vec3f(0.)));
  let bl = max(lo, mu - sg * 1.25); let bh = min(hi, mu + sg * 1.25);
  var h = ycc(hcr(hp)); let cen = (bl + bh) * .5; let ext = max((bh - bl) * .5, vec3f(1e-4)); let r = abs((h - cen) / ext);
  let rm = max(r.x, max(r.y, r.z)); if (rm > 1.) { h = cen + (h - cen) / rm; }
  // blend: about 1/10 new where a ray landed near this pixel, less where the nearest ray was further away
  return vec4f(rgb(mix(h, c, clamp(.1 * wm, .02, 1.))), 1.);
}
