// Mode7craft scene: per-pixel sprite-stack slice renderer (no meshes).
// The world is a stack of horizontal 1/8-block slices; each pixel walks
// down the slice planes (Mode 7 projection per plane) until it hits a texel.
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
@group(0) @binding(0) var<uniform> U: array<vec4f, 20>;   // U[9].z = torch count
@group(0) @binding(1) var vox: texture_3d<u32>;
@group(0) @binding(2) var hm: texture_2d<u32>;
@group(0) @binding(3) var<uniform> TL: array<vec4f, 32>;   // nearest torches: xyz + flicker (own buffer: keeps U small)

const N = 128; const NZ = 16; const S = 8.; const ZW = 2.75; const CB = 15.5; 
const TR = 0.34; // trunk radius
const SUN = vec3f(-0.5, 0.42, 0.757);
const FOG = vec3f(0.761, 0.859, 0.941);
// HQ lighting ('AAA shaders' setting): a pipeline-overridable constant. The standard pipeline is
// built with HQ=false, so every `if (HQ)` block is dead code there and the classic look is untouched.
override HQ = false;

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
fn vn(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2i(1, 0)), u.x), mix(h2(i + vec2i(0, 1)), h2(i + vec2i(1, 1)), u.x), u.y);
}
// sparse puffy clouds: a few domes per 12-block cell, returns stack height in slices
// which 12-block cloud cell (= one cloud cluster; domes never leave their cell) covers p
fn cloudCell(p: vec2f) -> vec2i { return vec2i(floor((p + vec2f(U[0].z * 0.9, U[0].z * 0.3)) / 12.)); }
// cell of the cloud a segment from the camera to point e crosses (its cloud base), or a sentinel
fn occCell(o: vec3f, e: vec3f) -> vec2i {
  if (o.z <= CB || e.z >= CB) { return vec2i(-99999); }
  let q = mix(o.xy, e.xy, (o.z - CB) / (o.z - e.z));
  return select(vec2i(-99999), cloudCell(q), cloud(q) > 0.);
}
fn bayer4(p: vec2i) -> f32 {
  let x = u32(p.x) & 3u; let y = u32(p.y) & 3u;
  let m = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  return (f32(m[y * 4u + x]) + 0.5) / 16.;
}
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
struct Hit { t: f32, id: u32, n: vec3f };
fn sinv(d: vec3f) -> vec3f { return 1. / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9)); }
// exact ray/AABB slab test: (t enter, t exit) + entry normal
fn slab(ro: vec3f, inv: vec3f, rd: vec3f, b0: vec3f, b1: vec3f, n: ptr<function, vec3f>) -> vec2f {
  let a = (b0 - ro) * inv; let b = (b1 - ro) * inv; let lo = min(a, b); let hi = max(a, b);
  let tn = max(max(lo.x, lo.y), lo.z);
  if (tn == lo.x) { *n = vec3f(-sign(rd.x), 0., 0.); } else if (tn == lo.y) { *n = vec3f(0., -sign(rd.y), 0.); } else { *n = vec3f(0., 0., -sign(rd.z)); }
  return vec2f(tn, min(min(hi.x, hi.y), hi.z));
}
// Exact voxel traversal (Amanatides-Woo DDA) over the block grid. Replaces fixed
// slice stepping, which skipped texels at grazing angles and mis-guessed faces.
fn traceBlocks(ro: vec3f, rd: vec3f, tA: f32, tB: f32, steps: i32) -> Hit {
  var h: Hit; h.t = tB; h.id = 0u; h.n = vec3f(0., 0., 1.);
  let inv = sinv(rd); var n = vec3f(0., 0., 1.);
  let w = slab(ro, inv, rd, vec3f(0.), vec3f(f32(N), f32(N), f32(NZ)), &n);
  var t = max(tA, w.x); let te = min(tB, w.y);
  if (t >= te) { return h; }
  if (w.x < tA) { n = -sign(rd) * vec3f(0., 0., 1.); }
  let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.));
  var c = clamp(vec3i(floor(ro + rd * (t + 1e-4))), vec3i(0), vec3i(N - 1, N - 1, NZ - 1));
  let dl = abs(inv);
  var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv;
  for (var i = 0; i < steps; i++) {
    let id = block(c);
    if (id == 5u) {
      // birch log: analytic vertical cylinder inside the voxel (caps + side), no meshes
      let cc = vec2f(c.xy) + .5; let tx = min(min(tm.x, tm.y), tm.z);
      let pe = ro + rd * t;
      if (abs(n.z) > 0.5 && length(pe.xy - cc) < TR) {
        // entered through a z face inside the circle: a cap, unless the log continues there (joint)
        h.t = t; h.id = 5u;
        h.n = select(n, vec3f(normalize(pe.xy - cc + 1e-5), 0.), block(c + vec3i(n)) == 5u);
        return h;
      }
      let oc = ro.xy - cc; let a = dot(rd.xy, rd.xy); let b = dot(oc, rd.xy); let k = dot(oc, oc) - TR * TR;
      let disc = b * b - a * k;
      if (a > 1e-9 && disc > 0.) {
        let t1 = (-b - sqrt(disc)) / a;
        if (t1 >= t - 1e-4 && t1 <= tx) { h.t = t1; h.id = 5u; h.n = vec3f(normalize(ro.xy + rd.xy * t1 - cc), 0.); return h; }
      }
    } else if (id != 0u && id != 8u) { h.t = t; h.id = id; h.n = n; return h; }   // torches: drawn from the light list
    if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; n = vec3f(f32(-st.x), 0., 0.); }
    else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; n = vec3f(0., f32(-st.y), 0.); }
    else { t = tm.z; tm.z += dl.z; c.z += st.z; n = vec3f(0., 0., f32(-st.z)); }
    if (t > te || any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { break; }
  }
  return h;
}
// Exact texel DDA through the sprite-stacked avatar's bounding box (texel space).
fn tracePlayer(ro: vec3f, rd: vec3f, tB: f32) -> Hit {
  var h: Hit; h.t = tB; h.id = 0u; h.n = vec3f(0., 0., 1.);
  let P = U[5]; let z0 = floor(P.z * S + 0.01);
  let o = ro * S; let inv = sinv(rd); var n = vec3f(0., 0., 1.);
  let r = slab(o, inv, rd, vec3f(P.xy * S - 5., z0), vec3f(P.xy * S + 5., z0 + 15.), &n);
  if (r.x > r.y || r.y < 0. || r.x > tB * S) { return h; }
  var t = max(r.x, 0.);
  let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.));
  var c = vec3i(floor(o + rd * (t + 1e-3)));
  let dl = abs(inv);
  var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - o) * inv;
  for (var i = 0; i < 40; i++) {
    let id = player(c);
    if (id != 0u) { if (t / S < tB) { h.t = t / S; h.id = id; h.n = n; } return h; }
    if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; n = vec3f(f32(-st.x), 0., 0.); }
    else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; n = vec3f(0., f32(-st.y), 0.); }
    else { t = tm.z; tm.z += dl.z; c.z += st.z; n = vec3f(0., 0., f32(-st.z)); }
    if (t > r.y) { break; }
  }
  return h;
}
// 1 = lit, 0 = shadowed (blocks, avatar, clouds)
fn shadow(p: vec3f) -> f32 {
  if (traceBlocks(p, SUN, 0.0, 16., 28).id != 0u) { return 0.; }
  if (tracePlayer(p, SUN, 16.).id != 0u) { return 0.; }
  let qc = p.xy + SUN.xy * ((CB + 0.6 - p.z) / SUN.z);
  if (cloud((floor(qc * S) + .5) / S) > 0.) { return 0.; }
  return 1.;
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
    case 5u: { c = select(c3(0xebe7dcu), c3(0x3b3b3bu), r < .2); }
    case 6u: { c = select(select(c3(0x86b83au), c3(0xa6d24eu), r > .88), c3(0x5f9029u), r < .22); }
    case 7u: {
      let vv = select(l.z, l.y, face == 0); let uu = select(l.x, l.y, face == 1); let row = (vv >> 2u) + b.z * 2;
      c = c3(0xb8915au) * (0.93 + 0.1 * h2(vec2i(row, b.x * 7 + b.y)));
      if ((vv & 3) == 3 || uu == ((row * 5 + b.x + b.y) & 7)) { c *= 0.72; } else if (r < .12) { c *= 0.9; }
    }
    case 8u: {
      // torch: dark-grained stick, 2-texel flame on top that flickers
      c = select(c3(0x7a5230u), c3(0x5c3c22u), ((l.x + l.z) & 1) == 1);
      if (l.z >= 5) { let f = h3(vec3i(l.x, l.y, l.z + i32(U[0].z * 12.))); c = select(select(c3(0xff9a2eu), c3(0xffd65cu), f > 0.45), c3(0xfff3c0u), l.z == 6 && f > 0.75); }
    }
    case 10u: { c = c3(0x2b3a8cu); }
    case 11u: { c = c3(0x3fa9c9u); }
    case 12u: { c = c3(0xe0a878u); }
    case 13u: { c = c3(0x4a3020u); }
    case 14u: { c = c3(0x1a1a2au); }
    default: { c = c3(0x2a2a2au); }
  }
  return c;
}
// birch bark wrapped around the cylinder by angle; cap shows rings
fn birch(p: vec3f, n: vec3f) -> vec3f {
  let cell = vec3i(floor(p - n * 0.002)); let cc = vec2f(cell.xy) + .5;
  if (abs(n.z) > 0.5) {
    let r = length(p.xy - cc) * S;
    if (r > 2.1) { return c3(0xebe7dcu); }
    return select(c3(0xe0cfa0u), c3(0xc2a873u), (i32(floor(r)) & 1) == 1);
  }
  let ang = atan2(p.y - cc.y, p.x - cc.x);
  let u = i32(floor((ang / 6.2831853 + .5) * 18.)) % 18; let v = i32(floor(p.z * S));
  var c = select(c3(0xefebe1u), c3(0xd8d3c7u), h2(vec2i(u, v) + cell.xy * 31) > 0.8);
  // lenticels: short thin horizontal dashes; knots: rare small black marks
  let dsh = h2(vec2i(u / 4 + cell.x * 13, v + cell.y * 17 + cell.z * 8));
  if (dsh > 0.84 && u % 4 != 3) { c = select(c3(0x55555au), c3(0x2e2e32u), dsh > 0.93); }
  if (h2(vec2i(u / 2 + cell.y * 5, v / 2 + cell.x * 3 + cell.z * 4)) > 0.985 && (v & 1) == 0) { c = c3(0x18181bu); }
  return c;
}
// ---- layered water (v7): stepped depth bands over a visible, teal-tinted sea floor ----
struct WR { c: vec3f, k: f32, a: f32 };   // colour, k=1 foam/sparkle (stays bright), a = band opacity
fn hcl(b: vec2i) -> f32 { return f32(min(height(b), 3)); }
// solid at water level under texel t (blocks, leaves, round logs; torches don't count)
fn wsol(t: vec2i) -> bool {
  let b = vec3i(t >> vec2u(3u), 2); let id = block(b);
  if (id == 0u || id == 8u) { return false; }
  if (id == 5u) { let e = (vec2f(t) + .5) / S - vec2f(b.xy) - .5; return dot(e, e) < TR * TR; }
  return true;
}
// any solid within k texels (4-neighbourhood); only cells across a block border are loaded,
// since the water texel's own cell is empty (unless it holds a log)
fn wedge(t: vec2i, k: i32, own: bool) -> bool {
  let l = t & vec2i(7);
  return ((own || l.x + k > 7) && wsol(t + vec2i(k, 0))) || ((own || l.x < k) && wsol(t - vec2i(k, 0))) ||
         ((own || l.y + k > 7) && wsol(t + vec2i(0, k))) || ((own || l.y < k) && wsol(t - vec2i(0, k)));
}
fn water(d: vec3f, p: vec3f, sh: f32, dark: bool) -> WR {
  let t = vec2i(floor(p.xy * S)); let tc = (vec2f(t) + .5) / S; let tm = U[0].z;
  // depth: sea floor height smoothed over block columns (rounded, jittered band contours)
  let g = tc - 0.5; let gi = vec2i(floor(g)); let gf = fract(g);
  let hs = mix(mix(hcl(gi), hcl(gi + vec2i(1, 0)), gf.x), mix(hcl(gi + vec2i(0, 1)), hcl(gi + vec2i(1, 1)), gf.x), gf.y);
  let dj = (h2(t >> vec2u(1u)) - 0.5) * 0.4;
  var dv = ZW - hs; var under = vec3f(0.); var seen = false;
  if (dv + dj < 2.45) {
    // see-through: refracted ray to the sea floor / object bases / the avatar's legs (open deep sea is opaque: skipped)
    let rd = refract(d, vec3f(0., 0., 1.), 0.75);
    var h = traceBlocks(p, rd, 0., min(p.z / max(-rd.z, 0.1), 8.), 12);
    if (U[7].x < 0.5) { let hp = tracePlayer(p, rd, h.t); if (hp.id != 0u) { h = hp; } }
    let q = p + rd * h.t;
    if (h.id != 0u) {
      let ht = vec3i(floor((q - h.n * 0.002) * S));
      under = select(matCol(h.id, ht, select(select(2, 1, abs(h.n.x) > 0.5), 0, h.n.z > 0.5)), birch(q, h.n), h.id == 5u);
      under *= select(0.8, 1., h.n.z > 0.5);
    } else { under = c3(0xa08a5au); }
    dv = mix(ZW - q.z, dv, 0.5); seen = true;
  }
  let db = dv + dj;
  var c = c3(0x1a5a8eu); var a = 1.;
  if (db < 1.) { c = c3(0x45ada9u); a = 0.5; } else if (db < 1.45) { c = c3(0x3299a6u); a = 0.64; }
  else if (db < 1.95) { c = c3(0x25849du); a = 0.78; } else if (db < 2.45) { c = c3(0x1e6e96u); a = 0.9; }
  if (seen) { c = mix(under * vec3f(0.55, 0.74, 0.74), c, a); }
  let lit = sh > 0.5; var k = 0.;
  if (!lit && dark) { c *= vec3f(0.6, 0.68, 0.8); }   // shadow patches from trees, objects, clouds
  // sparkles: fixed spots twinkling in frame steps, mostly over shallow lit water
  if (lit && h2(t) > select(0.9985, 0.982, db < 1.95) && ((i32(tm * 2.) + i32(h2(t + vec2i(71, 3)) * 5.)) % 5) < 2) {
    c = select(c3(0xbfeaf7u), vec3f(0.97, 0.99, 1.), h2(t + vec2i(5, 9)) > 0.45); k = 1.;
  }
  // 1-px shoreline where the surface meets anything solid (coast, placed blocks, trunks), pulsing slowly
  let ph = i32(tm * 1.5);
  let lg = block(vec3i(t >> vec2u(3u), 2)) == 5u;
  if (wedge(t, 1, lg)) { c = select(c3(0xb8e6f6u), vec3f(0.95, 0.99, 1.), h2(t + vec2i(ph * 13, ph * 7)) > 0.3); k = 1.; }
  else if (wedge(t, 2, lg) && ((ph + i32(h2(t) * 4.)) & 3) == 0) { c = mix(c, c3(0xc8eefau), 0.55); }
  // wading: foam ring at the avatar's legs + a slow ripple
  let P = U[5].xyz;
  if (P.z < ZW && P.z > ZW - 1.6) {
    let r = length(tc - P.xy); let ro = 0.48 + fract(tm * 0.6) * 0.45;
    if (r > 0.26 && r < 0.38 && h2(t + vec2i(ph * 5, 0)) > 0.25) { c = vec3f(0.95, 0.99, 1.); k = 1.; }
    else if (abs(r - ro) < 0.06 && h2(t) > 0.35) { c = mix(c, c3(0xc8eefau), 0.7); }
  }
  return WR(c, k, a);
}
fn sky(d: vec3f) -> vec3f { return mix(FOG, vec3f(0.55, 0.72, 0.92), clamp(d.z * 3., 0., 1.)); }

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let res = U[0].xy; let uv = fc.xy / res * 2. - 1.;
  let nd = vec2f(uv.x * U[3].w, -uv.y) * U[0].w;
  let o = U[1].xyz; let F = U[2].xyz; let R = U[3].xyz; let Up = U[4].xyz;
  let d = normalize(F + R * nd.x + Up * nd.y);
  let far = U[2].w; let fogOn = U[1].w;
  let fps = U[7].x > 0.5; let up = d.z > 0.;
  // ---- clouds: stacked blob slices (walked top-down, or bottom-up when looking up) ----
  var cc = vec3f(1.); var ca = 0.; var ct = 0.;
  if (abs(d.z) > 1e-4) {
  for (var k = 0; k < 10; k++) {
    let j = select(9 - k, k, up); let z = CB + f32(select(j + 1, j, up)) / S; let t = (z - o.z) / d.z;
    if (t < 0.) { continue; } if (t > far) { break; }
    let q = (floor((o.xy + d.xy * t) * S) + .5) / S;
    let th = cloud(q);
    if (th > f32(j)) {
      if (up && j == 0) { cc = select(vec3f(0.8, 0.85, 0.94), vec3f(0.74, 0.8, 0.91), h2(vec2i(floor(q * S))) > 0.85); }   // underside seen from below
      else if (th >= f32(j + 1) && j < 9) { cc = select(select(vec3f(0.97, 0.98, 1.), vec3f(0.86, 0.9, 0.96), j < 4), vec3f(0.73, 0.8, 0.91), j < 2); }
      else if (h2(vec2i(floor(q * S))) > 0.9) { cc = vec3f(0.94, 0.96, 1.); }
      // Retro see-through: the WHOLE cloud cluster that hides the avatar (camera->head/centre/feet
      // crosses its base) or that it stands under is drawn at a uniform ~50% with a screen-stable
      // 4x4 Bayer dither. Near-camera clouds step down in quantised dither levels. No soft halo.
      var a = 1.;
      if (!fps) {
        let P = U[5].xyz; let cell = cloudCell(q);
        let pc = P + vec3f(0., 0., 0.9);
        var hit = cloud(P.xy) > 0. && all(cell == cloudCell(P.xy));
        // 3x3 samples over the avatar's silhouette (+margin), across the view: feet/centre/head x left/mid/right
        for (var i = 0; i < 9 && !hit; i++) {
          let e = P + R * (f32(i % 3) - 1.) * 0.9 + vec3f(0., 0., f32(i / 3) * 1.);
          hit = all(cell == occCell(o, e));
        }
        if (hit) { a = 0.5; }
        a = min(a, ceil(smoothstep(0.1, 0.45, t / length(pc - o)) * 4.) / 4.);
      }
      if (bayer4(vec2i(floor(fc.xy))) < a) { ca = 1.; ct = t; }
      break;
    }
  }
  }
  let cloudCol = mix(cc, FOG, fogOn * smoothstep(far * 0.4, far, ct));
  // camera above the cloud layer: nothing can be in front of a cloud hit
  if (ca > 0.5 && o.z > CB + 1.3) { if (HQ) { return vec4f(hqCloud(cc, ct, o, d), 1.); } return vec4f(cloudCol, 1.); }
  // ---- terrain: exact DDA through the block grid, then the avatar ----
  let tw = select(1e9, (ZW - o.z) / d.z, d.z < 0.);
  let tEnd = select(min(far, tw), min(ct, tw), ca > 0.5);
  var hb = traceBlocks(o, d, 0., tEnd, 320);
  if (!fps) { let hp = tracePlayer(o, d, hb.t); if (hp.id != 0u) { hb = hp; } }
  // break particles: tiny analytic cubes
  var part = false;
  if (U[9].y > 0.5) {
    let inv = sinv(d);
    for (var i = 0; i < 8; i++) {
      let P = U[10 + i]; if (P.w <= 0.) { continue; }
      var pn = vec3f(0.); let r = slab(o, inv, d, P.xyz - P.w, P.xyz + P.w, &pn);
      if (r.x <= r.y && r.x > 0. && r.x < hb.t) { hb.t = r.x; hb.id = u32(U[9].x); hb.n = pn; part = true; }
    }
  }
  // torches: a 2x2-texel stick + flame box per listed torch (analytic, outside the DDA hot loop)
  for (var i = 0; i < i32(U[9].z); i++) {
    var tn = vec3f(0.); let b0 = floor(TL[i].xyz) + vec3f(0.375, 0.375, 0.);
    let r = slab(o, sinv(d), d, b0, b0 + vec3f(0.25, 0.25, 0.8125), &tn);
    if (r.x <= r.y && r.x > 0. && r.x < hb.t) { hb.t = r.x; hb.id = 8u; hb.n = tn; part = false; }
  }
  var col: vec3f; var tt = hb.t;
  if (hb.id == 0u && ca > 0.5 && ct < tw) { if (HQ) { return vec4f(hqCloud(cc, ct, o, d), 1.); } return vec4f(cloudCol, 1.); }
  if (hb.id == 0u) {
    if (tw > far) { col = sky(d); tt = 0.; if (HQ) { col = hqSky(d); tt = far; } }
    else {
      tt = tw;
      let p = o + d * tw;
      if (HQ) { col = hqWater(p, d); }
      else { col = water(d, p, shadow(vec3f((floor(p.xy * S) + .5) / S, ZW)), true).c; if (U[9].z > 0.) { col += col * torchL(p, vec3f(0., 0., 1.), false) * 0.6; } }
    }
  } else {
    let p = o + d * hb.t; let n = hb.n;
    let ht = vec3i(floor((p - n * 0.002) * S));          // texel inside the hit voxel, robust on faces
    let face = select(select(2, 1, abs(n.x) > 0.5), 0, n.z > 0.5);
    let isLog = hb.id == 5u && !part;
    col = select(matCol(hb.id, ht, face), birch(p, n), isLog); let base0 = col;
    var lit = 1.;
    if (HQ) { col = hqShade(p, n, ht, hb.id, isLog, part, col); }
    else if (isLog) {
      let ld = dot(n, SUN);
      lit = select(0., select(0.84, 1.0, ld > 0.45), ld > 0.05);
    } else if (face == 0) {
      let l = ht & vec3i(7); let b = ht >> vec3u(3u);
      if (hb.id < 5u && !part) {
        // contour: dark line at the foot of a higher step; rim light towards the sun
        if ((l.x == 0 && block(b + vec3i(-1, 0, 1)) != 0u) || (l.x == 7 && block(b + vec3i(1, 0, 1)) != 0u) ||
            (l.y == 0 && block(b + vec3i(0, -1, 1)) != 0u) || (l.y == 7 && block(b + vec3i(0, 1, 1)) != 0u)) { col *= 0.72; }
        if ((l.x == 7 && block(b + vec3i(1, 0, 0)) == 0u) || (l.y == 0 && block(b + vec3i(0, -1, 0)) == 0u)) { lit = 0.86; }
        if ((l.x == 0 && block(b - vec3i(1, 0, 0)) == 0u) || (l.y == 7 && block(b + vec3i(0, 1, 0)) == 0u)) { lit = 1.12; }
      }
    } else if (n.z < -0.5) { lit = 0.5; }
    else { lit = select(0., 0.9, dot(n.xy, SUN.xy) > 0.); }
    if (HQ) { } else if (lit == 0.) {
      // face turned away from the sun: already in form shadow, use the shadow tint once
      col *= vec3f(0.64, 0.7, 0.84);
    } else {
      // shadow probe from the texel centre on the face (stable, pixel-art crisp)
      let q = select((vec3f(ht) + .5) / S + n * (0.5 / S + 0.01), p + n * 0.03, isLog);
      col *= lit;
      if (shadow(q) < 0.5) { col *= vec3f(0.58, 0.64, 0.8); }
    }
    if (!HQ && U[9].z > 0.) { col += base0 * torchL(p + n * 0.03, n, false) * 0.8; }
    if (hb.id == 8u && !part && (ht.z & 7) >= 5) { col = select(base0, lin(base0) * 4., HQ); }   // flame: emissive
    // targeted block: pixel-crisp dark outline on its edges + light face tint
    if (U[8].w > 0.5 && !part && hb.id < 10u) {
      let cell = vec3i(floor(p - n * 0.002));
      if (all(cell == vec3i(U[8].xyz))) {
        let f = p - vec3f(cell); let e3 = min(f, 1. - f); var e = 1.;
        if (abs(n.x) < 0.5) { e = min(e, e3.x); } if (abs(n.y) < 0.5) { e = min(e, e3.y); } if (abs(n.z) < 0.5) { e = min(e, e3.z); }
        let pix = hb.t * 2. * U[0].w / U[0].y;
        if (e < max(0.06, pix * 1.2)) { col = vec3f(0.07, 0.07, 0.1); } else { col = select(mix(col, vec3f(1.), 0.18), col * 1.5 + 0.02, HQ); }
      }
    }
  }
  if (HQ) { return vec4f(hqAtmo(o, d, tt, far, fogOn, col, fc.xy), 1.); }
  col = mix(col, FOG, fogOn * smoothstep(far * 0.35, far, tt));
  return vec4f(col, 1.);
}

// warm point lights from the nearest torches (list filled by JS). HQ adds an occlusion ray.
fn torchL(p: vec3f, n: vec3f, occl: bool) -> vec3f {
  var s = 0.;
  for (var i = 0; i < i32(U[9].z); i++) {
    let L = TL[i]; let v = L.xyz - p; let d2 = dot(v, v);
    if (d2 > 64.) { continue; }
    let d = sqrt(d2); let a = 1. - d / 8.; var k = a * a * L.w * (0.3 + 0.7 * max(dot(n, v / d), 0.));
    if (occl && k > 0.004) { let o = traceBlocks(p, v / d, 0., d, 16).id; if (o != 0u && o != 8u) { k = 0.; } }
    s += k;
  }
  return vec3f(1., 0.56, 0.24) * s;
}
// ======================= HQ lighting (only reachable when HQ = true) =======================
// Linear-ish HDR: palette colours are squared (gamma 2), lit by sun + sky + one bounce,
// tonemapped (ACES fit) and square-rooted again in hq.wgsl. Sun: U[18] dir, U[19] colour,
// U[7].yzw sky ambient. All lookups stay on the voxel grid so it keeps the pixel-art look.
fn lin(c: vec3f) -> vec3f { return c * c; }
fn sunL() -> vec3f { return U[18].xyz; }
fn occ(b: vec3i) -> f32 { let i = block(b); return select(0., 1., i != 0u && i != 5u && i != 8u); }
// Minecraft-style per-voxel AO: the 8 cells around the face's air cell, bilinear over the face
fn hqAO(c: vec3i, n: vec3f, p: vec3f) -> f32 {
  let a = c + vec3i(round(n));
  var u = vec3i(1, 0, 0); var v = vec3i(0, 1, 0);
  if (abs(n.x) > 0.5) { u = vec3i(0, 1, 0); v = vec3i(0, 0, 1); } else if (abs(n.y) > 0.5) { v = vec3i(0, 0, 1); }
  let l = (floor((p - vec3f(c)) * S) + .5) / S;           // texel-quantised position on the face
  let f = vec2f(dot(l, vec3f(u)), dot(l, vec3f(v)));
  let xm = occ(a - u); let xp = occ(a + u); let ym = occ(a - v); let yp = occ(a + v);
  let c00 = 3. - select(xm + ym + occ(a - u - v), 3., xm + ym > 1.5);
  let c10 = 3. - select(xp + ym + occ(a + u - v), 3., xp + ym > 1.5);
  let c01 = 3. - select(xm + yp + occ(a - u + v), 3., xm + yp > 1.5);
  let c11 = 3. - select(xp + yp + occ(a + u + v), 3., xp + yp > 1.5);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y) / 3.;
}
// sun transmittance along a ray: leaves pass light through texel gaps (dappled light), logs are
// round, torches let light by, anything else is opaque
fn hqTrans(ro: vec3f, rd: vec3f, steps: i32) -> f32 {
  let inv = sinv(rd); var n = vec3f(0.);
  let w = slab(ro, inv, rd, vec3f(0.), vec3f(f32(N), f32(N), f32(NZ)), &n);
  var t = max(0., w.x); if (t >= w.y) { return 1.; }
  let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.)); let dl = abs(inv);
  var c = clamp(vec3i(floor(ro + rd * (t + 1e-4))), vec3i(0), vec3i(N - 1, N - 1, NZ - 1));
  var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv; var T = 1.;
  for (var i = 0; i < steps; i++) {
    let id = block(c); let tx = min(min(tm.x, tm.y), tm.z);
    if (id == 6u) {
      T *= select(0.12, 0.8, h3(vec3i(floor((ro + rd * (t + tx) * 0.5) * S))) < 0.4);
      if (T < 0.02) { return 0.; }
    } else if (id == 5u) {
      let oc = ro.xy - (vec2f(c.xy) + .5); let a = max(dot(rd.xy, rd.xy), 1e-9);
      if (length(oc + rd.xy * clamp(-dot(oc, rd.xy) / a, t, tx)) < TR) { return 0.; }
    } else if (id != 0u && id != 8u) { return 0.; }
    if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; }
    else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; }
    else { t = tm.z; tm.z += dl.z; c.z += st.z; }
    if (t > w.y || any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { break; }
  }
  return T;
}
// soft sun shadow: 3 rays in a small cone (rotated per texel), so it is sharp at contact and
// widens with blocker distance; clouds cast a translucent shadow
fn hqShadow(p: vec3f, k: f32) -> f32 {
  let L = sunL(); if (L.z < 0.02) { return 0.; }
  let t1 = normalize(cross(L, vec3f(0., 0., 1.))); let t2 = cross(L, t1); var v = 0.;
  for (var i = 0; i < 3; i++) {
    let a = (f32(i) + k) * 2.0944; let r = normalize(L + (t1 * cos(a) + t2 * sin(a)) * 0.075);
    if (tracePlayer(p, r, 16.).id == 0u) { v += hqTrans(p, r, 28); }
  }
  let qc = p.xy + L.xy * ((CB + 0.6 - p.z) / L.z);
  return v / 3. * select(1., 0.3, cloud((floor(qc * S) + .5) / S) > 0.);
}
fn hqSky(d: vec3f) -> vec3f {
  let L = sunL(); let sc = U[19].xyz; let mu = max(dot(d, L), 0.);
  let hz = lin(FOG) * U[19].w + sc * 0.12 * pow(max(dot(normalize(d.xy + 1e-5), normalize(L.xy + 1e-5)), 0.), 3.) * (1. - U[19].w * 0.7);
  var c = mix(hz, U[7].yzw * vec3f(1., 1.5, 2.3), sqrt(clamp(d.z, 0., 1.)));
  c += sc * (pow(mu, 32.) * 0.15 + select(0., 12., mu > 0.9993));   // halo + sun disc (blooms)
  return c;
}
// lights a palette colour on a surface (shared by direct hits and reflections)
fn hqLight(alb: vec3f, n: vec3f, ao: f32, sh: f32, gnd: vec3f) -> vec3f {
  let ndl = max(dot(n, sunL()), 0.);
  return alb * (U[19].xyz * ndl * sh + U[7].yzw * ao * (1.5 - 0.3 * n.z) + gnd * U[19].xyz * ao * (0.5 - 0.5 * n.z));
}
fn hqShade(p: vec3f, n: vec3f, ht: vec3i, id: u32, isLog: bool, part: bool, base: vec3f) -> vec3f {
  let c = vec3i(floor(p - n * 0.002));
  var ao = 1.; if (!part && !isLog && id < 10u) { ao = 0.25 + 0.75 * hqAO(c, n, p); }
  var sh = 0.;
  if (dot(n, sunL()) > 0.) {
    let q = select((vec3f(ht) + .5) / S + n * (0.5 / S + 0.01), p + n * 0.03, isLog);
    sh = hqShadow(q, h3(ht));
  }
  // one cheap bounce: colour of the ground in front of / below the face (green from grass, blue water)
  var g = block(c + vec3i(round(n)) - vec3i(0, 0, 1));
  if (g == 0u) { g = block(c + vec3i(round(n)) - vec3i(0, 0, 2)); }
  let gc = select(lin(matCol(g, vec3i(4), 0)), vec3f(0.06, 0.2, 0.45), g == 0u);
  var c2 = hqLight(lin(base), n, ao, sh, gc * 0.6);
  let q = p + n * 0.03;
  if (id == 6u && dot(n, sunL()) <= 0. && sunL().z > 0.02) {
    // backlit leaves: sun transmitted through the crown, strongest looking towards the sun
    let mu = max(dot(normalize(p - U[1].xyz), sunL()), 0.);
    c2 += lin(base) * U[19].xyz * hqTrans(q, sunL(), 12) * (0.12 + pow(mu, 4.));
  }
  if (U[9].z > 0.) { c2 += lin(base) * torchL(q, n, true) * 1.5; }
  return c2;
}
fn hqWater(p: vec3f, d: vec3f) -> vec3f {
  let tq = (floor(p.xy * S) + .5) / S; let tm = U[0].z;
  let sh = hqShadow(vec3f(tq, ZW), 0.5);
  let w = water(d, p, sh, false); let base = lin(w.c);   // layered palette: bands, sea floor, foam, sparkles
  let amb = U[7].yzw; let sun = U[19].xyz;
  var tl = vec3f(0.); if (U[9].z > 0.) { tl = torchL(p, vec3f(0., 0., 1.), false) * 1.5; }
  if (w.k > 0.5) { return base * (amb * 0.8 + sun * (0.4 + 0.45 * sh) + tl); }   // foam/sparkle: diffuse, no reflection
  let wn = normalize(vec3f(vn(tq * 1.7 + tm * 0.7) - .5, vn(tq.yx * 1.3 - tm * 0.6) - .5, 9.));
  let r = reflect(d, wn);
  var rc = hqSky(r);
  let h = traceBlocks(vec3f(tq, ZW + 0.01), r, 0., 40., 64);
  if (h.id != 0u) {
    let q = vec3f(tq, ZW) + r * h.t;
    let a = select(matCol(h.id, vec3i(floor((q - h.n * 0.002) * S)), select(1, 0, h.n.z > 0.5)), birch(q, h.n), h.id == 5u);
    rc = hqLight(lin(a), h.n, 0.8, 0.85, vec3f(0.));
  }
  // reflections: strongest over deep (opaque) bands at grazing angles, weak over the shallow shelf
  let fr = (0.03 + 0.6 * pow(1. - abs(d.z), 5.)) * mix(0.3, 1., w.a * w.a);
  var c = mix(base * (amb * 0.85 + sun * (0.12 + 0.38 * sh)), rc, fr);
  c += base * tl;
  return c + sun * pow(max(dot(r, sunL()), 0.), 900.) * 8. * sh * w.a;   // sun glint
}
fn hqCloud(cc: vec3f, t: f32, o: vec3f, d: vec3f) -> vec3f {
  let c = lin(cc) * (U[19].xyz * 1.1 + U[7].yzw * 0.6);
  return mix(c, hqSky(d), smoothstep(U[2].w * 0.4, U[2].w, t) * U[1].w);
}
// aerial perspective + light shafts: a few dithered samples along the view ray test the cloud
// shadow (and terrain under the sample), in-scatter ~ sun phase; distance fades into the sky
fn hqAtmo(o: vec3f, d: vec3f, tt: f32, far: f32, fogOn: f32, col: vec3f, fc: vec2f) -> vec3f {
  let L = sunL(); let len = min(tt, 56.); let j = bayer4(vec2i(floor(fc)));
  var vis = 0.; let ph = 0.05 + 3. * pow(max(dot(d, L), 0.), 6.);
  for (var k = 0; k < 6; k++) {
    let q = o + d * (len * (f32(k) + j) / 6.);
    let qc = q.xy + L.xy * ((CB + 0.6 - q.z) / max(L.z, 0.05)); let hq = f32(height(vec2i(floor(q.xy))));
    let lit = q.z > hq && (q.z > CB || cloud((floor(qc * S) + .5) / S) <= 0.);
    if (lit) { vis += select(1., hqTrans(q, L, 8), ph > 0.4 && q.z < hq + 7.); }   // crown gaps (near the ground, towards the sun)
  }
  // in-scatter: strongly forward (shafts show when looking towards the sun), denser near the
  // ground so crown gaps throw visible rays even over a few blocks
  let dens = 1. - exp(-len * 0.006);
  var c = col + U[19].xyz * (vis / 6.) * ph * (1. - exp(-len * 0.03)) * 0.12 + U[7].yzw * dens * 0.02;
  return mix(c, hqSky(d), fogOn * smoothstep(far * 0.35, far, tt));
}
