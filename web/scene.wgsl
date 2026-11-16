// Mode7craft scene: per-pixel sprite-stack slice renderer (no meshes).
// The world is a stack of horizontal 1/8-block slices; each pixel walks
// down the slice planes (Mode 7 projection per plane) until it hits a texel.
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
@group(0) @binding(0) var<uniform> U: array<vec4f, 8>;
@group(0) @binding(1) var vox: texture_3d<u32>;
@group(0) @binding(2) var hm: texture_2d<u32>;

const N = 128; const NZ = 16; const S = 8.; const ZW = 2.75; const CB = 15.5; 
const SUN = vec3f(-0.5, 0.42, 0.757);
const FOG = vec3f(0.761, 0.859, 0.941);

fn hh(a: u32) -> u32 { var n = a; n ^= n >> 16u; n *= 0x7feb352du; n ^= n >> 15u; n *= 0x846ca68bu; n ^= n >> 16u; return n; }
fn h2(p: vec2i) -> f32 { return f32(hh((u32(p.x) * 1597334677u) ^ hh(u32(p.y) + 0x9e3779b9u)) >> 8u) / 16777216.; }
fn h3(p: vec3i) -> f32 { return h2(vec2i(p.x + p.z * 7919, p.y ^ (p.z * 104729))); }
fn c3(h: u32) -> vec3f { return vec3f(f32((h >> 16u) & 255u), f32((h >> 8u) & 255u), f32(h & 255u)) / 255.; }

fn block(b: vec3i) -> u32 {
  if (b.x < 0 || b.y < 0 || b.z < 0 || b.x >= N || b.y >= N || b.z >= NZ) { return 0u; }
  return textureLoad(vox, b, 0).r;
}
fn height(b: vec2i) -> i32 {
  if (b.x < 0 || b.y < 0 || b.x >= N || b.y >= N) { return 0; }
  return i32(textureLoad(hm, b, 0).r);
}
// sprite-stacked avatar, ids 10.. ; t = texel coords
fn player(t: vec3i) -> u32 {
  let P = U[5]; let dz = t.z - i32(floor(P.z * S + 0.01));
  if (dz < 0 || dz > 14) { return 0u; }
  let d = vec2f(t.xy) + 0.5 - P.xy * S;
  if (dot(d, d) > 20.) { return 0u; }
  let f = U[6].xy; let v = dot(d, f); let u = dot(d, vec2f(f.y, -f.x));
  let iu = i32(floor(u + 0.5)) ; let iv = i32(floor(v + 0.5));
  let sw = i32(round(sin(U[6].z) * 1.6 * U[6].w));
  if (dz <= 4) {
    let m = select(10u, 15u, dz == 0);
    if ((iu == -1 || iu == -2) && (iv - sw == -1 || iv - sw == 0)) { return m; }
    if ((iu == 0 || iu == 1) && (iv + sw == -1 || iv + sw == 0)) { return m; }
    return 0u;
  }
  if (dz <= 9) {
    if (iu >= -2 && iu <= 1 && (iv == -1 || iv == 0)) { return 11u; }
    if (dz >= 5 && ((iu == -3 && (iv + sw == -1 || iv + sw == 0)) || (iu == 2 && (iv - sw == -1 || iv - sw == 0)))) { return select(11u, 12u, dz == 5); }
    return 0u;
  }
  if (iu >= -2 && iu <= 1 && iv >= -2 && iv <= 1) {
    if (dz >= 13 || iv == -2 || (dz == 12 && (iu == -2 || iu == 1) && iv < 1)) { return 13u; }
    if (iv == 1 && dz == 11 && (iu == -2 || iu == 1)) { return 14u; }
    return 12u;
  }
  return 0u;
}
fn solidT(t: vec3i) -> u32 {
  let pm = player(t); if (pm != 0u) { return pm; }
  let id = block(t >> vec3u(3u));
  if (id == 5u) { let l = t & vec3i(7); if (l.x < 2 || l.x > 5 || l.y < 2 || l.y > 5) { return 0u; } }
  if (id == 6u && h3(t) < 0.06) { return 0u; }
  return id;
}
fn vn(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2i(1, 0)), u.x), mix(h2(i + vec2i(0, 1)), h2(i + vec2i(1, 1)), u.x), u.y);
}
// sparse puffy clouds: a few domes per 12-block cell, returns stack height in slices
fn cloud(p: vec2f) -> f32 {
  let w = p + vec2f(U[0].z * 0.9, U[0].z * 0.3);
  let c = vec2i(floor(w / 12.));
  if (h2(c + vec2i(77, 13)) > 0.42) { return 0.; }
  var hmax = 0.;
  for (var i = 0; i < 4; i++) {
    let r1 = h2(c * 4 + vec2i(i, 91)); let r2 = h2(c * 4 + vec2i(i, 37)); let r3 = h2(c * 4 + vec2i(i, 53));
    let r = 1.3 + r3 * 2.2;
    let o = vec2f(c) * 12. + 6. + (vec2f(r1, r2) - .5) * (9. - 2. * r);
    let d = w - o; let q = r * r - dot(d, d);
    if (q > 0.) { hmax = max(hmax, sqrt(q) * 2.6 + 0.5); }
  }
  return hmax;
}
// 1 = lit, <1 shadowed (terrain/sprite shadow + cloud shadow)
fn shadow(q0: vec3f) -> f32 {
  var q = q0; var s = 1.;
  for (var j = 0; j < 30; j++) {
    q += SUN * (1.6 / S);
    if (q.z > 15.) { break; }
    if (solidT(vec3i(floor(q * S))) != 0u) { s = 0.; break; }
  }
  let qc = q0.xy + SUN.xy * ((CB + 0.6 - q0.z) / SUN.z);
  if (cloud((floor(qc * S) + .5) / S) > 0.) { s = min(s, 0.); }
  return s;
}
// layered greens: each height level gets its own band colour (light low, darker raised)
fn grassCol(hb: f32) -> vec3f {
  switch i32(hb) {
    case 4: { return c3(0x8fd24au); } case 5: { return c3(0x78c438u); } case 6: { return c3(0x66b232u); }
    case 7: { return c3(0x549f2cu); } default: { return c3(0x448c27u); }
  }
}
fn matCol(id: u32, t: vec3i, face: i32) -> vec3f {
  let r = h3(t); let l = t & vec3i(7); let b = t >> vec3u(3u);
  var c: vec3f;
  switch id {
    case 1u: {
      let g = grassCol(f32(b.z + 1));
      if (face == 0) { c = g * (0.94 + 0.1 * h2(b.xy)); if (r < 0.09) { c *= 0.78; } else if (r > 0.96) { c *= 1.12; } }
      else { let edge = 7 - l.z < 2 + i32(h3(vec3i(t.xy, 0)) * 2.5); c = select(c3(0x8a5a34u) * select(1., 0.82, r < .2), g * 0.8, edge); }
    }
    case 2u: { c = c3(0x8a5a34u) * select(1., 0.8, r < .25); }
    case 3u: { c = c3(0xd6c983u) * select(1., 0.92, r < .2); if (face != 0) { c *= 0.9; } }
    case 4u: { c = c3(0x959e9eu) * select(1., 0.86, r < .3); if (r > .95) { c *= 1.1; } }
    case 5u: { c = select(c3(0x7a5230u) * select(1., 0.8, l.x == 3 || l.y == 4), c3(0xb08a55u), face == 0); }
    case 6u: { c = c3(0x307026u) * select(1., select(0.78, 1.25, r > .5), r < .2 || r > .9); }
    case 10u: { c = c3(0x2b3a8cu); }
    case 11u: { c = c3(0x3fa9c9u); }
    case 12u: { c = c3(0xe0a878u); }
    case 13u: { c = c3(0x4a3020u); }
    case 14u: { c = c3(0x1a1a2au); }
    default: { c = c3(0x2a2a2au); }
  }
  return c;
}
fn water(p: vec2f, sh: f32) -> vec3f {
  let t = vec2i(floor(p * S)); let tm = U[0].z;
  let hb = height(t >> vec2u(3u));
  // distance to land in texels (rough, 4 dirs x 3)
  var dl = 9;
  for (var k = 1; k <= 3; k++) {
    if (height((t + vec2i(k, 0)) >> vec2u(3u)) >= 3 || height((t - vec2i(k, 0)) >> vec2u(3u)) >= 3 ||
        height((t + vec2i(0, k)) >> vec2u(3u)) >= 3 || height((t - vec2i(0, k)) >> vec2u(3u)) >= 3) { dl = min(dl, k); }
  }
  // depth from smoothed sea floor
  let n = h2(t >> vec2u(1u)) * 0.6;
  let dep = (2.7 - f32(hb)) + n - select(0., 1.2, dl <= 3);
  var c = c3(0x2f5bc4u);
  if (dep < 1.0) { c = c3(0x59c2c4u); } else if (dep < 1.9) { c = c3(0x3f8ad6u); }
  // moving sparkle dashes
  let wt = vec2i(floor(vec2f(p.x * S + tm * 3., p.y * S) / vec2f(3., 1.)));
  let sp = h2(wt + vec2i(i32(tm * 0.8) * 37, 0));
  if (sp > 0.985) { c = vec3f(0.95, 0.98, 1.); } else if (sp > 0.965) { c = mix(c, vec3f(0.62, 0.8, 1.), 0.7); }
  if (sh < 0.5) { c = mix(c, c3(0x1b2f78u), 0.55); }
  let ph = i32(tm * 3.);
  if (dl == 1 && h2(t + vec2i(ph * 13, 0)) > 0.15) { c = vec3f(0.96, 0.98, 1.); }
  else if (dl == 2 && h2(t + vec2i(0, ph * 7)) > 0.6) { c = mix(c, vec3f(1.), 0.8); }
  return c;
}
fn sky(d: vec3f) -> vec3f { return mix(FOG, vec3f(0.55, 0.72, 0.92), clamp(d.z * 3., 0., 1.)); }

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let res = U[0].xy; let uv = fc.xy / res * 2. - 1.;
  let nd = vec2f(uv.x * U[3].w, -uv.y) * U[0].w;
  let o = U[1].xyz; let d = normalize(U[2].xyz + U[3].xyz * nd.x + U[4].xyz * nd.y);
  let far = U[2].w; let fogOn = U[1].w;
  if (d.z > -0.002) { return vec4f(sky(d), 1.); }
  // clouds: stacked blob slices above the terrain
  for (var k = 0; k < 10; k++) {
    let j = 9 - k; let z = CB + f32(j + 1) / S; let t = (z - o.z) / d.z;
    if (t < 0.) { continue; } if (t > far) { break; }
    let q = (floor((o.xy + d.xy * t) * S) + .5) / S;
    // SNES-style checkerboard dither so clouds never fully hide the avatar
    let qi = vec2i(floor(fc.xy));
    if (length(q - U[5].xy) < 5. && ((qi.x + qi.y) & 1) == 0) { continue; }
    let th = cloud(q);
    if (th > f32(j)) {
      // puffy: white tops, cool blue-grey rim on the lower, shadowed side
      var c = vec3f(1.);
      if (th >= f32(j + 1) && j < 9) { c = select(select(vec3f(0.97, 0.98, 1.), vec3f(0.86, 0.9, 0.96), j < 4), vec3f(0.73, 0.8, 0.91), j < 2); }
      else if (h2(vec2i(floor(q * S))) > 0.9) { c = vec3f(0.94, 0.96, 1.); }
      return vec4f(mix(c, FOG, fogOn * smoothstep(far * 0.4, far, t)), 1.);
    }
  }
  var hit = 0u; var ht = vec3i(0); var hp = vec3f(0.); var face = 0; var prev = vec3i(-9999); var tt = 0.;
  for (var k = NZ * 8 - 1; k >= 22; k--) {
    let t = (f32(k + 1) / S - o.z) / d.z;
    if (t < 0.) { continue; } if (t > far) { break; }
    let p = o + d * t;
    if (p.x < -1. || p.y < -1. || p.x > f32(N) + 1. || p.y > f32(N) + 1.) { prev = vec3i(-9999); continue; }
    let tx = vec3i(vec2i(floor(p.xy * S)), k);
    let m = solidT(tx);
    if (m != 0u) {
      hit = m; ht = tx; hp = p; tt = t;
      if (solidT(tx + vec3i(0, 0, 1)) == 0u) { face = 0; }
      else if (prev.x != tx.x && (prev.y == tx.y || abs(d.x) > abs(d.y))) { face = 1; } else { face = 2; }
      break;
    }
    prev = tx;
  }
  var col: vec3f;
  if (hit == 0u) {
    let t = (ZW - o.z) / d.z;
    if (t > far) { return vec4f(sky(d), 1.); }
    tt = t;
    let p = o + d * t;
    col = water(p.xy, shadow(vec3f((floor(p.xy * S) + .5) / S, ZW)));
  } else {
    col = matCol(hit, ht, face);
    var q = (vec3f(ht) + vec3f(.5, .5, 1.02)) / S;
    var lit = 1.;
    if (face == 0) {
      // stepped-edge contour: darken top texels next to a drop, light rim towards the sun
      let l = ht & vec3i(7); let b = ht >> vec3u(3u);
      if (hit < 5u) {
        // contour: dark line at the foot of a higher step
        if ((l.x == 0 && block(b + vec3i(-1, 0, 1)) != 0u) || (l.x == 7 && block(b + vec3i(1, 0, 1)) != 0u) ||
            (l.y == 0 && block(b + vec3i(0, -1, 1)) != 0u) || (l.y == 7 && block(b + vec3i(0, 1, 1)) != 0u)) { col *= 0.72; }
        if ((l.x == 7 && block(b + vec3i(1, 0, 0)) == 0u) || (l.y == 0 && block(b + vec3i(0, -1, 0)) == 0u)) { lit = 0.86; }
        if ((l.x == 0 && block(b - vec3i(1, 0, 0)) == 0u) || (l.y == 7 && block(b + vec3i(0, 1, 0)) == 0u)) { lit = 1.12; }
      }
    } else {
      let nrm = select(vec2f(0., -sign(d.y)), vec2f(-sign(d.x), 0.), face == 1);
      q = (vec3f(ht) + .5) / S + vec3f(nrm * 0.7 / S, 0.);
      lit = select(0.66, 0.9, dot(nrm, SUN.xy) > 0.);
    }
    let sh = shadow(q);
    col *= lit;
    if (sh < 0.5) { col *= vec3f(0.58, 0.64, 0.8); }
  }
  col = mix(col, FOG, fogOn * smoothstep(far * 0.35, far, tt));
  return vec4f(col, 1.);
}
