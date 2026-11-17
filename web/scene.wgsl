// Mode7craft scene: per-pixel sprite-stack slice renderer (no meshes).
// The world is a stack of horizontal 1/8-block slices; each pixel walks
// down the slice planes (Mode 7 projection per plane) until it hits a texel.
struct V { @builtin(position) p: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var o: V; let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  o.p = vec4f(x * 2. - 1., 1. - y * 2., 0., 1.); return o;
}
@group(0) @binding(0) var<uniform> U: array<vec4f, 22>;   // U[9].z = torch count, U[9].w = art-pixel scale ('Skarpa kanter'; 0 = off, -1 = write surface ids for 'Mjuka kanter')
@group(0) @binding(1) var vox: texture_3d<u32>;
@group(0) @binding(2) var hm: texture_2d<u32>;   // r16: terrain h | top-of-anything h << 5 | top id << 10
@group(0) @binding(8) var OCC: texture_3d<u32>;    // 4x4x4 bricks: 0 = nothing visible (empty-space skipping)
// U[20] = (heightmap-march start tH, shadow-cache window x0, y0, size), U[21] = (edge-fog start fraction, splat count, -, -)
@group(0) @binding(3) var<uniform> TL: array<vec4f, 32>;   // nearest torches: xyz + flicker (own buffer: keeps U small)
// HQ sun-shadow cache, one byte per block cell (4 per u32): 0 = all dark, 255 = all lit, 128 = mixed/unknown.
// Baked by the `bake` compute pass only when the sun moves or the world changes.
@group(0) @binding(4) var<storage, read> SC: array<u32>;
@group(0) @binding(7) var<storage, read_write> SCW: array<u32>;   // same buffer, written only by the bake pass

const N = 256; const NZ = 16; const S = 8.; const ZW = 2.75; const CB = 15.5; 
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
  return (textureLoad(vox, vec3i(b.x >> 1u, b.y, b.z), 0).r >> (u32(b.x & 1) * 4u)) & 15u;   // 4 bits per voxel
}
fn height(b: vec2i) -> i32 {
  if (b.x < 0 || b.y < 0 || b.x >= N || b.y >= N) { return 0; }
  return i32(textureLoad(hm, b, 0).r & 31u);
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
// ---- porous leaves (v10, 'Löv'): every face a ray crosses into, out of or between leaf voxels is an
// alpha-tested 8x8 pixel-art leaf sprite (flipped/rotated per face), so crowns get holes, inner layers
// and a ragged rim. Off (LEAF = 0) compiles the old solid-block path.
override LEAF = 0;   // pipeline constant: 1 = porous leaves
fn leafOn() -> bool { return LEAF > 0; }
fn lbit(q: vec2i, f: u32) -> bool {   // q in 0..7: transpose / mirror (x ^ 7 = 7 - x) per variant, then one mask bit
  var a = select(q, q.yx, (f & 1u) != 0u); a ^= vec2i(select(0, 7, (f & 2u) != 0u), select(0, 7, (f & 4u) != 0u));
  return ((select(0x66dff56cu, 0x9ebbef66u, a.y < 4) >> u32((a.y & 3) * 8 + a.x)) & 1u) != 0u;
}
// face texel coords + sprite variant for a point on a block face with normal n
fn lface(pe: vec3f, n: vec3f) -> vec3i {
  let an = abs(n); let uv = select(select(pe.xy, pe.xz, an.y > 0.5), pe.yz, an.x > 0.5);
  let k = vec3i(floor(pe - an * 0.5));
  return vec3i(clamp(vec2i(floor(fract(uv) * S)), vec2i(0), vec2i(7)), (k.x * 5 + k.y * 3 + k.z * 7 + (k.x ^ k.y) * 2) & 7);
}
// branch-light (it runs inside the DDA loops): sprite bit, and on outer faces half the rim texels drop out
fn leafHit(pe: vec3f, n: vec3f, outer: bool) -> bool {
  let q = lface(pe, n); let t = vec3i(floor(pe * S));
  let rim = outer && (any(q.xy == vec2i(0)) || any(q.xy == vec2i(7))) && ((u32(t.x * 73 + t.y * 151 + t.z * 211) * 0x9e3779b9u) >> 31u) == 0u;
  return lbit(q.xy, u32(q.z)) && !rim;
}
fn lbitC(q: vec2i, f: u32) -> bool { return all(q >= vec2i(0)) && all(q <= vec2i(7)) && lbit(q, f); }
// leaf colour: light where the leaf sprite has a gap above, dark with a gap below, speckled mid green
fn leafCol(p: vec3f, n: vec3f) -> vec3f {
  let q = lface(p, n); let f = u32(q.z);
  if (!lbitC(q.xy + vec2i(0, 1), f)) { return c3(0xa6d24eu); }
  if (!lbitC(q.xy - vec2i(0, 1), f)) { return c3(0x4f7d24u); }
  return select(c3(0x86b83au), c3(0x6fa233u), h3(vec3i(floor(p * S))) < 0.3);
}
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
fn traceB0(ro: vec3f, rd: vec3f, tA: f32, tB: f32, steps: i32) -> Hit {
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
    if (textureLoad(OCC, c >> vec3u(2u), 0).r == 0u) {
      // empty 4x4x4 brick: jump straight to the cell where the ray leaves it
      let b0 = (c >> vec3u(2u)) * 4;
      let ex = (vec3f(b0) + select(vec3f(0.), vec3f(4.), rd > vec3f(0.)) - ro) * inv;
      var k = 2; if (ex.x < ex.y && ex.x < ex.z) { k = 0; } else if (ex.y < ex.z) { k = 1; }
      t = ex[k];
      c = clamp(vec3i(floor(ro + rd * t)), b0, b0 + 3); c[k] = select(b0[k] - 1, b0[k] + 4, st[k] > 0);
      n = vec3f(0.); n[k] = f32(-st[k]);
      tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv;
      if (t > te || any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { break; }
      continue;
    }
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
// porous leaves (LEAF): the DDA above stops at a leaf cell as before; this walks the leaf cells
// (testing every face crossed against the leaf sprite) and resumes the DDA behind them. Kept out of
// the hot loop so the plain path compiles as before.
fn leafWalk(ro: vec3f, rd: vec3f, t0: f32, n0: vec3f, skip: bool) -> Hit {
  var h: Hit; h.id = 0u; h.n = n0; h.t = t0;
  let inv = sinv(rd); let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.)); let dl = abs(inv);
  var c = vec3i(floor(ro + rd * (t0 + 1e-4)));
  var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv;
  var t = t0; var n = n0; var pl = false; var il = true;
  for (var i = 0; i < 10; i++) {
    if (i > 0) { il = block(c) == 6u; }
    let id = block(c);
    if ((i > 0 || !skip) && leafHit(ro + rd * t, n, il != pl || i == 0)) { h.t = t; h.id = 6u; h.n = n; return h; }
    if (!il) { h.t = t; h.n = n; h.id = select(id, 0u, id == 0u || id == 5u || id == 8u); if (h.id == 0u) { h.id = 255u; } return h; }
    pl = il;
    if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; n = vec3f(f32(-st.x), 0., 0.); }
    else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; n = vec3f(0., f32(-st.y), 0.); }
    else { t = tm.z; tm.z += dl.z; c.z += st.z; n = vec3f(0., 0., f32(-st.z)); }
    if (any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { h.t = t; h.id = 255u; return h; }
  }
  h.t = t; h.id = 255u; return h;
}
fn traceBlocks(ro: vec3f, rd: vec3f, tA: f32, tB: f32, steps: i32) -> Hit {
  if (!leafOn()) { return traceB0(ro, rd, tA, tB, steps); }
  var ta = tA; var h: Hit;
  for (var k = 0; k < 4; k++) {
    h = traceB0(ro, rd, ta, tB, steps);
    if (h.id != 6u) { break; }
    let r = leafWalk(ro, rd, h.t, h.n, h.t <= tA + 1e-4);
    if (r.t >= tB) { h.t = tB; h.id = 0u; break; }
    if (r.id != 255u) { h = r; break; }   // a leaf texel or a solid block right behind the leaves
    ta = r.t + 1e-4; h.id = 0u; h.t = tB;
  }
  return h;
}
// far field (v11): beyond tH a block is ~1 art pixel, so march the 2.5D column heightmap instead of
// the voxel grid (Voxel Space style; steps grow with distance, about one pixel each)
fn hmMarch(ro: vec3f, rd: vec3f, tA: f32, tB: f32) -> Hit {
  var h: Hit; h.t = tB; h.id = 0u; h.n = vec3f(0., 0., 1.);
  // start where the ray drops below the tallest column (z 16); steps grow with distance (about one pixel)
  // but never skip more than half a block of height, so steep rays cannot jump over a column
  var t = tA; if (rd.z < 0.) { t = max(t, (f32(NZ) - ro.z) / rd.z); } var pt = t; let dz = 0.5 / max(abs(rd.z), 1e-3);
  for (var i = 0; i < 128; i++) {
    if (hmIn(ro + rd * t)) {
      // bisect back to the first column the ray dips into, then snap to its top or side
      var a = pt; var b = t;
      for (var j = 0; j < 5; j++) { let m = (a + b) * 0.5; if (hmIn(ro + rd * m)) { b = m; } else { a = m; } }
      let p = ro + rd * b; let v = textureLoad(hm, vec2i(floor(p.xy)), 0).r; let top = f32((v >> 5u) & 31u);
      let tt = (top - ro.z) / rd.z;
      if (rd.z < 0. && tt >= a - 1e-3 && tt <= b + 0.3) { h.t = tt; h.n = vec3f(0., 0., 1.); }
      else { h.t = a; h.n = select(vec3f(0., -sign(rd.y), 0.), vec3f(-sign(rd.x), 0., 0.), abs(rd.x) > abs(rd.y)); }
      h.id = (v >> 10u) & 15u; return h;
    }
    if (t >= tB) { break; }
    pt = t; t = min(t + min(max(0.3, t * 0.015), dz), tB);
  }
  return h;
}
fn hmIn(p: vec3f) -> bool {
  let c = vec2i(floor(p.xy)); if (any(c < vec2i(0)) || c.x >= N || c.y >= N) { return false; }
  return p.z < f32((textureLoad(hm, c, 0).r >> 5u) & 31u);
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
struct WR { c: vec3f, k: f32, a: f32, g: f32 };   // colour, k=1 foam/sparkle (stays bright), a = band opacity, g = sun glitter
// sun path: each texel is a random facet (re-rolled in frame steps); it flashes when its tilt would mirror
// the sun into the eye, so flashes crowd into a glittering path under the sun (long when the sun is low)
fn glit(t: vec2i, d: vec3f, L: vec3f) -> f32 {
  if (L.z < 0.02) { return 0.; }
  let hv = normalize(L - d); let s = hv.xy / max(hv.z, 0.05);
  let pr = exp(-dot(s, s) * 110.); let st = i32(U[0].z * 5.); let r = h2(t + vec2i(st * 37, st * 11));
  return select(0., select(0.55, 1., r < pr * 0.12), r < pr * 0.32);
}
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
  var sg = 0.; if (lit) { sg = glit(t, d, select(sunL(), SUN, dark)); }
  if (sg > 0. && dark) { c = mix(c, c3(0xfff2c4u), sg); k = 1.; }
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
  return WR(c, k, a, sg);
}
fn sky(d: vec3f) -> vec3f { return mix(FOG, vec3f(0.55, 0.72, 0.92), clamp(d.z * 3., 0., 1.)); }

var<private> gZ = 1.;   // HQ: depth of the visible surface (for the leaf splats' depth test)
fn zdep(t: f32, d: vec3f) -> f32 { return 1. - 0.05 / max(t * dot(d, U[2].xyz), 0.05); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f { return shade(fc); }
struct FO { @location(0) c: vec4f, @builtin(frag_depth) z: f32 };
@fragment fn fsh(@builtin(position) fc: vec4f) -> FO { let c = shade(fc); return FO(c, gZ); }
fn shade(fc: vec4f) -> vec4f {
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
      if (bayer4(vec2i(floor(fc.xy / max(U[9].w, 1.)))) < a) { ca = 1.; ct = t; }   // dither cells stay art-pixel sized
      break;
    }
  }
  }
  let cloudCol = mix(cc, sky(d), fogOn * smoothstep(far * U[21].x, far, ct));
  // camera above the cloud layer: nothing can be in front of a cloud hit
  if (ca > 0.5 && o.z > CB + 1.3) { if (HQ) { gZ = zdep(ct, d); return vec4f(hqCloud(cc, ct, o, d), 1.); } return vec4f(cloudCol, 1.); }
  // ---- terrain: exact DDA through the block grid, then the avatar ----
  let tw = select(1e9, (ZW - o.z) / d.z, d.z < 0.);
  let tEnd = select(min(far, tw), min(ct, tw), ca > 0.5);
  let tH = U[20].x;
  var hb = traceBlocks(o, d, 0., min(tEnd, tH), 320);
  if (hb.id == 0u && tEnd > tH) { hb = hmMarch(o, d, tH, tEnd); }
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
  var col: vec3f; var tt = hb.t; var gid = 251.;   // surface id (sky 251, water 250, planes 0..239, avatar 253)
  if (hb.id == 0u && ca > 0.5 && ct < tw) { if (HQ) { gZ = zdep(ct, d); return vec4f(hqCloud(cc, ct, o, d), 1.); } return vec4f(cloudCol, 1.); }
  if (hb.id == 0u) {
    if (tw > far) { col = sky(d); tt = 0.; if (HQ) { col = hqSky(d); tt = far; } }
    else {
      tt = tw; gid = 250.;
      let p = o + d * tw;
      if (HQ) { col = hqWater(p, d); }
      else { col = water(d, p, shadow(vec3f((floor(p.xy * S) + .5) / S, ZW)), true).c; if (U[9].z > 0.) { col += col * torchL(p, vec3f(0., 0., 1.), false) * 0.6; } }
    }
  } else {
    let p = o + d * hb.t; let n = hb.n;
    let ht = vec3i(floor((p - n * 0.002) * S));          // texel inside the hit voxel, robust on faces
    let face = select(select(2, 1, abs(n.x) > 0.5), 0, n.z > 0.5);
    let isLog = hb.id == 5u && !part;
    // coplanar faces share an id, so only real geometry edges (silhouettes, steps, shore) get smoothed
    gid = f32((u32(face + select(0, 3, dot(n, vec3f(1.)) < 0.)) * 41u + u32(round(abs(dot(p, n))) + 64.) * 7u) % 240u);
    if (isLog) { gid = f32(hh(u32(floor(p.x)) * 977u + u32(floor(p.y))) % 240u); }
    if (hb.id >= 8u || part) { gid = select(248., 253., hb.id >= 10u); }
    col = select(matCol(hb.id, ht, face), birch(p, n), isLog); if (hb.id == 6u && leafOn() && !part) { col = leafCol(p, n); } let base0 = col;
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
        if (e < max(0.06, pix * 1.2 * max(U[9].w, 1.))) { col = vec3f(0.07, 0.07, 0.1); } else { col = select(mix(col, vec3f(1.), 0.18), col * 1.5 + 0.02, HQ); }
      }
    }
  }
  let ga = select(1., gid / 255., U[9].w < 0.);
  if (HQ) { if (tt > 0. && tt < far * 0.999) { gZ = zdep(tt, d); } return vec4f(hqAtmo(o, d, tt, far, fogOn, col, fc.xy), ga); }
  col = mix(col, sky(d), fogOn * smoothstep(far * U[21].x, far, tt));
  return vec4f(col, ga);
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
fn hqT0(ro: vec3f, rd: vec3f, tA: f32, steps: i32) -> vec2f {   // (transmittance, where it stopped at leaves or -1)
  let inv = sinv(rd); var n = vec3f(0.);
  let w = slab(ro, inv, rd, vec3f(0.), vec3f(f32(N), f32(N), f32(NZ)), &n);
  var t = max(tA, w.x); if (t >= w.y) { return vec2f(1., -1.); }
  let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.)); let dl = abs(inv);
  var c = clamp(vec3i(floor(ro + rd * (t + 1e-4))), vec3i(0), vec3i(N - 1, N - 1, NZ - 1));
  var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv; var T = 1.;
  for (var i = 0; i < steps; i++) {
    let id = block(c); let tx = min(min(tm.x, tm.y), tm.z);
    if (id == 6u) {
      if (LEAF > 0) { return vec2f(T, t); }
      T *= select(0.12, 0.8, h3(vec3i(floor((ro + rd * (t + tx) * 0.5) * S))) < 0.4);
      if (T < 0.02) { return vec2f(0., -1.); }
    } else if (id == 5u) {
      let oc = ro.xy - (vec2f(c.xy) + .5); let a = max(dot(rd.xy, rd.xy), 1e-9);
      if (length(oc + rd.xy * clamp(-dot(oc, rd.xy) / a, t, tx)) < TR) { return vec2f(0., -1.); }
    } else if (id != 0u && id != 8u) { return vec2f(0., -1.); }
    if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; }
    else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; }
    else { t = tm.z; tm.z += dl.z; c.z += st.z; }
    if (t > w.y || any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { break; }
  }
  return vec2f(T, -1.);
}
fn hqTrans(ro: vec3f, rd: vec3f, steps: i32) -> f32 {
  if (LEAF == 0) { return hqT0(ro, rd, 0., steps).x; }
  var T = 1.; var ta = 0.;
  for (var k = 0; k < 4; k++) {
    let r = hqT0(ro, rd, ta, steps); T *= r.x; if (r.y < 0.) { break; }
    // walk the leaf cells: every sprite texel crossed lets 15% through
    let inv = sinv(rd); let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.)); let dl = abs(inv);
    var t = r.y; var c = vec3i(floor(ro + rd * (t + 1e-4))); var n = -vec3f(st) * vec3f(0., 0., 1.); var pl = false;
    var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv;
    { let f = abs(ro + rd * t - round(ro + rd * t)); n = select(select(vec3f(0., 0., -f32(st.z)), vec3f(0., -f32(st.y), 0.), f.y < f.z), vec3f(-f32(st.x), 0., 0.), f.x < min(f.y, f.z)); }
    for (var i = 0; i < 10; i++) {
      let id = block(c); let il = id == 6u;
      if ((il || pl) && (i > 0 || t > 1e-4) && leafHit(ro + rd * t, n, il != pl)) { T *= 0.15; if (T < 0.02) { return 0.; } }
      if (!il) { if (id != 0u && id != 5u && id != 8u) { return 0.; } break; }
      pl = il;
      if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; n = vec3f(f32(-st.x), 0., 0.); }
      else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; n = vec3f(0., f32(-st.y), 0.); }
      else { t = tm.z; tm.z += dl.z; c.z += st.z; n = vec3f(0., 0., f32(-st.z)); }
      if (any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { return T; }
    }
    ta = t + 1e-4;
  }
  return T;
}
// soft sun shadow: 3 rays in a small cone (rotated per texel), so it is sharp at contact and
// widens with blocker distance; clouds cast a translucent shadow
fn hqShadow(p: vec3f, k: f32) -> f32 {
  let L = sunL(); if (L.z < 0.02) { return 0.; }
  let sc = scache(vec3i(floor(p))); if (sc == 0u) { return 0.; }   // baked: whole cell in shadow
  let t1 = normalize(cross(L, vec3f(0., 0., 1.))); let t2 = cross(L, t1); var v = 0.;
  for (var i = 0; i < 3; i++) {
    let a = (f32(i) + k) * 2.0944; let r = normalize(L + (t1 * cos(a) + t2 * sin(a)) * 0.075);
    // baked fully-lit cells only test the (moving) avatar; mixed cells trace the world as before
    if (tracePlayer(p, r, 16.).id == 0u) { if (sc == 255u) { v += 1.; } else { v += hqTrans(p, r, 28); } }
  }
  let qc = p.xy + L.xy * ((CB + 0.6 - p.z) / L.z);
  return v / 3. * select(1., 0.3, cloud((floor(qc * S) + .5) / S) > 0.);
}
fn scache(c: vec3i) -> u32 {
  let ws = i32(U[20].w); let l = c - vec3i(i32(U[20].y), i32(U[20].z), 0);   // cache covers a ws x ws window
  if (any(l < vec3i(0)) || l.x >= ws || l.y >= ws || c.z >= NZ) { return 128u; }
  let i = (l.z * ws + l.y) * ws + l.x; return array<u32, 4>(0u, 255u, 128u, 128u)[(SC[i >> 4u] >> (u32(i & 15) * 2u)) & 3u];   // 2 bits per cell
}
// bake ray: 0 = blocked by a full block, 1 = clear, 2 = passes leaves / near a log (needs per-pixel tracing)
fn bakeRay(ro: vec3f, rd: vec3f) -> u32 {
  let inv = sinv(rd); var n = vec3f(0.);
  let w = slab(ro, inv, rd, vec3f(0.), vec3f(f32(N), f32(N), f32(NZ)), &n);
  var t = max(0., w.x); if (t >= w.y) { return 1u; }
  let st = select(vec3i(-1), vec3i(1), rd > vec3f(0.)); let dl = abs(inv);
  var c = clamp(vec3i(floor(ro + rd * (t + 1e-4))), vec3i(0), vec3i(N - 1, N - 1, NZ - 1));
  var tm = (vec3f(c) + select(vec3f(0.), vec3f(1.), rd > vec3f(0.)) - ro) * inv;
  for (var i = 0; i < 28; i++) {
    let id = block(c);
    if (id == 5u || id == 6u) { return 2u; } else if (id != 0u && id != 8u) { return 0u; }
    if (tm.x < tm.y && tm.x < tm.z) { t = tm.x; tm.x += dl.x; c.x += st.x; }
    else if (tm.y < tm.z) { t = tm.y; tm.y += dl.y; c.y += st.y; }
    else { t = tm.z; tm.z += dl.z; c.z += st.z; }
    if (t > w.y || any(c < vec3i(0)) || c.x >= N || c.y >= N || c.z >= NZ) { break; }
  }
  return 1u;
}
// classify one air cell next to a surface (or at water level): 3x3x3 points x the 3-ray sun cone
fn bakeCell(c: vec3i) -> u32 {
  let id = block(c); if (id != 0u && id != 8u) { return 128u; }
  var nb = c.z == 2;
  for (var k = 0; k < 6; k++) { var e = vec3i(0); e[k / 2] = select(-1, 1, (k & 1) == 0); let b = block(c + e); nb = nb || (b != 0u && b != 8u); }
  if (!nb) { return 128u; }
  let L = sunL(); if (L.z < 0.02) { return 0u; }
  let t1 = normalize(cross(L, vec3f(0., 0., 1.))); let t2 = cross(L, t1); var lit = 0u; var tot = 0u;
  for (var j = 0; j < 9; j++) {   // 8 corners + centre
    let o = vec3i(j & 1, (j >> 1) & 1, (j >> 2) & 1) * 2; var q = vec3f(c) + 0.02 + vec3f(o) * 0.48; if (j == 8) { q = vec3f(c) + 0.5; } let kk = h3(c * 3 + o + j);
    for (var i = 0; i < 6; i++) {   // pixel rays lie on a 0.075 cone; sample just inside/outside its rim all round
      let a = (f32(i) + kk) * 1.0472; let r = bakeRay(q, normalize(L + (t1 * cos(a) + t2 * sin(a)) * select(0.082, 0.068, (i & 1) == 0)));   // (covers the 0.4° the sun may drift before a rebake)
      if (r == 2u) { return 128u; }
      lit += r; tot += 1u; if (lit != 0u && lit != tot) { return 128u; }
    }
  }
  return select(0u, 255u, lit > 0u);
}
@compute @workgroup_size(64) fn bake(@builtin(global_invocation_id) g: vec3u) {
  let ws = i32(U[20].w); if (g.x >= u32(ws * ws * NZ / 16)) { return; }
  var o = 0u; let w0 = vec3i(i32(U[20].y), i32(U[20].z), 0);
  for (var j = 0u; j < 16u; j++) {   // 16 cells per word, 2 bits each: 0 shadow, 1 lit, 2 unknown
    let i = i32(g.x * 16u + j); let v = bakeCell(w0 + vec3i(i % ws, (i / ws) % ws, i / (ws * ws)));
    o |= select(select(2u, 1u, v == 255u), 0u, v == 0u) << (j * 2u);
  }
  SCW[g.x] = o;
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
  let gl = sun * w.g * 2.5 * sh;   // sun-path glitter (HDR: blooms, golden at a low sun)
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
  return c + gl + sun * pow(max(dot(r, sunL()), 0.), 900.) * 8. * sh * w.a;   // sun glint
}
fn hqCloud(cc: vec3f, t: f32, o: vec3f, d: vec3f) -> vec3f {
  let c = lin(cc) * (U[19].xyz * 1.1 + U[7].yzw * 0.6);
  return mix(c, hqSky(d), smoothstep(U[2].w * U[21].x, U[2].w, t) * U[1].w);
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
    if (lit) {   // crown gaps (near the ground, towards the sun); baked cells skip the trace
      var v = 1.; if (ph > 0.4 && q.z < hq + 7.) { let sc = scache(vec3i(floor(q))); if (sc == 0u) { v = 0.; } else if (sc != 255u) { v = hqTrans(q, L, 8); } }
      vis += v;
    }
  }
  // in-scatter: strongly forward (shafts show when looking towards the sun), denser near the
  // ground so crown gaps throw visible rays even over a few blocks
  let dens = 1. - exp(-len * 0.006);
  var c = col + U[19].xyz * (vis / 6.) * ph * (1. - exp(-len * 0.03)) * 0.12 + U[7].yzw * dens * 0.02;
  return mix(c, hqSky(d), fogOn * smoothstep(far * U[21].x, far, tt));
}

// ---- leaf splats (v10, HQ 'Löv+splats'): small swaying gaussian leaf sprites on the crown surface ----
// LF = exposed leaf voxels (index | open-face mask << 20), U[5].w = their count. Instance i is splat
// i / count of voxel i % count, so drawing fewer instances thins every crown evenly.
@group(0) @binding(5) var<storage, read> LF: array<u32>;
struct SV { @builtin(position) p: vec4f, @location(0) @interpolate(flat) c: vec4f, @location(1) q: vec2f };
struct SPL { P: vec3f, r: vec4f, fn3: vec3f, ok: bool };
// splat i: its (swaying) centre, random numbers and face; ok = survives distance thinning + view cull
fn splat(ii: u32) -> SPL {
  var s: SPL;
  let nv = u32(U[5].w); let e = LF[ii % nv]; let k = ii / nv; let ix = i32(e & 0xfffffu); let m = e >> 20u;
  let cell = vec3i(ix % N, (ix / N) % N, ix / (N * N));
  // hash of the cell as indexed on the old 128 island, so legacy splats match v10
  let h = hh((u32((cell.z * 128 + cell.y) * 128 + cell.x) | (m << 18u)) * 31u + k * 977u); s.r = vec4f(vec4u(h, h >> 8u, h >> 16u, h >> 24u) & vec4u(255u)) / 255.;
  // pick the (k-th) open face, sit on it and poke a little outwards
  var f = 0u; var c = 0u; let want = (k + h) % u32(countOneBits(m));
  for (var j = 0u; j < 6u; j++) { if (((m >> j) & 1u) != 0u) { if (c == want) { f = j; } c++; } }
  var n3 = vec3f(0.); n3[f / 2u] = select(-1., 1., (f & 1u) == 0u); s.fn3 = n3;
  let t = U[0].z; var P = vec3f(cell) + .5 + (s.r.xyz - .5) * 0.9 * (1. - abs(s.fn3)) + s.fn3 * (0.45 + s.r.w * 0.3);
  let ph = P.x * 0.7 + P.y * 0.9 + s.r.w * 6.3; let gust = 1. + 0.6 * sin(t * 0.37 + P.x * 0.06 + P.y * 0.04);
  P += (vec3f(sin(t * 1.6 + ph), cos(t * 1.3 + ph * 1.7), 0.) * 0.035 + vec3f(0., 0., sin(t * 2.1 + ph) * 0.015)) * gust;
  s.P = P; let v = P - U[1].xyz; let dist = length(v);
  // distance thinning (keep ~2 per voxel far away) + view cull
  s.ok = !(dot(v, U[2].xyz) < 1.2 || dist > U[2].w * 0.85 || f32(k) >= 8. * clamp(10. / dist, 0.3, 1.));
  return s;
}
// v11: splat lighting runs once per splat in this compute pass (it used to run in all 6 vertices);
// SPW[i] = lit + fogged colour as 4 halfs, alpha 0 = culled
@group(0) @binding(9) var<storage, read_write> SPW: array<vec2u>;
@compute @workgroup_size(64) fn slit(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u32(U[21].y)) { return; }
  let s = splat(g.x); if (!s.ok) { SPW[g.x] = vec2u(0u); return; }
  let P = s.P; let r = s.r; let v = P - U[1].xyz; let dist = length(v);
  // sun (baked cache, else one transmittance ray) + sky, palette-snapped
  let L = sunL(); let nr = normalize(s.fn3 + (r.zxy - .5) * 0.9 + vec3f(0., 0., 0.35));
  var sh = 0.;
  if (L.z > 0.02) {
    let sc = scache(vec3i(floor(P))); sh = select(select(hqTrans(P, L, 12), 1., sc == 255u), 0., sc == 0u);
    let qc = P.xy + L.xy * ((CB + 0.6 - P.z) / L.z); if (cloud((floor(qc * S) + .5) / S) > 0.) { sh *= 0.3; }
  }
  let ndl = dot(nr, L); let lit = floor((max(ndl, 0.) + max(-ndl, 0.) * 0.35) * sh * 4. + 0.5) / 4.;
  let pal = array<u32, 4>(0x4f7d24u, 0x6fa233u, 0x86b83au, 0xa6d24eu);
  let alb = lin(c3(pal[min(u32(r.z * 4.), 3u)]));
  var col = alb * (U[19].xyz * lit + U[7].yzw * (0.9 + 0.25 * nr.z));
  if (U[9].z > 0.) { col += alb * torchL(P, nr, false) * 1.2; }
  col = mix(col, hqSky(v / dist), U[1].w * smoothstep(U[2].w * U[21].x, U[2].w, dist));
  SPW[g.x] = vec2u(pack2x16float(col.rg), pack2x16float(vec2f(col.b, 1.)));
}
@group(0) @binding(6) var<storage, read> SPC: array<vec2u>;
@vertex fn svs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SV {
  var o: SV; o.p = vec4f(0., 0., 2., 1.);
  let lc = SPC[ii]; if (lc.y == 0u) { return o; }
  let s = splat(ii); let r = s.r;
  let O = U[1].xyz; let F = U[2].xyz; let Rr = U[3].xyz; let Up = U[4].xyz; let v = s.P - O; let z = dot(v, F);
  // leaf ellipse: ~0.16 x 0.08 blocks, at least ~1 art pixel wide, random roll
  let pw = z * 2. * U[0].w / U[0].y * max(U[9].w, 1.);
  let sx = max(0.13 + r.x * 0.08, pw * 1.1); let sy = max(sx * 0.55, pw * 0.8); let a = r.y * 6.2832;
  let qv = vec2f(f32((0x1au >> vi) & 1u), f32((0x34u >> vi) & 1u)) * 4. - 2.;   // 2 triangles, +-2 sigma
  let lq = vec2f(qv.x * sx, qv.y * sy); let rq = vec2f(cos(a) * lq.x - sin(a) * lq.y, sin(a) * lq.x + cos(a) * lq.y);
  let w = v + Rr * rq.x + Up * rq.y; let zz = dot(w, F);
  o.p = vec4f(dot(w, Rr) / (U[3].w * U[0].w), dot(w, Up) / U[0].w, zz - 0.05, zz); o.q = qv;
  o.c = vec4f(unpack2x16float(lc.x), unpack2x16float(lc.y).x, select(1., 247. / 255., U[9].w < 0.));
  return o;
}
// gaussian falloff, stochastic (art-pixel Bayer) alpha: order-independent, crisp pixel-art edges
@fragment fn sfs(i: SV) -> @location(0) vec4f {
  if (exp(-0.5 * dot(i.q, i.q)) < bayer4(vec2i(floor(i.p.xy / max(U[9].w, 1.)))) * 0.3 + 0.3) { discard; }   // mostly solid, thin dithered rim
  return i.c;
}
