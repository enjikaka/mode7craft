//! Mode7craft core: world generation + player simulation. no_std, no bindgen.
#![no_std]
#![allow(static_mut_refs)]
#[inline] fn floor(x: f32) -> f32 { let i = x as i32 as f32; if i > x { i - 1.0 } else { i } }
#[inline] fn sqrt(x: f32) -> f32 { unsafe { msqrt(x) } }

#[panic_handler]
fn ph(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[link(wasm_import_module = "env")]
extern "C" {
    #[link_name = "msin"] fn sin(x: f32) -> f32;
    #[link_name = "mcos"] fn cos(x: f32) -> f32;
    #[link_name = "msqrt"] fn msqrt(x: f32) -> f32;
}

pub const N: usize = 128;
pub const NZ: usize = 16;
const WL: i32 = 3; // water surface level (blocks below are sea)

// block ids
const GRASS: u8 = 1; const DIRT: u8 = 2; const SAND: u8 = 3; const STONE: u8 = 4;
const WOOD: u8 = 5; const LEAF: u8 = 6;

static mut W: [u8; N * N * NZ] = [0; N * N * NZ];
static mut H: [u8; N * N] = [0; N * N];
// gen-time sea mask (player can't walk into the original sea)
static mut SEA: [u8; N * N] = [0; N * N];
// pick result: bx,by,bz,nx,ny,nz
static mut PICK: [i32; 6] = [0; 6];
// state: 0 x,1 y,2 z,3 vz,4 fx,5 fy,6 walk phase,7 moving(0..1),8 onGround,9 trees
static mut S: [f32; 16] = [0.0; 16];
static mut SEED: u32 = 1;

#[inline] fn abs(x: f32) -> f32 { if x < 0.0 { -x } else { x } }
#[inline] fn clamp(x: f32, a: f32, b: f32) -> f32 { if x < a { a } else if x > b { b } else { x } }

fn hash(x: i32, y: i32) -> u32 {
    let mut n = (x as u32).wrapping_mul(0x9E3779B1) ^ (y as u32).wrapping_mul(0x85EBCA77) ^ unsafe { SEED }.wrapping_mul(0xC2B2AE3D);
    n ^= n >> 15; n = n.wrapping_mul(0x2C1B3C6D); n ^= n >> 12; n = n.wrapping_mul(0x297A2D39); n ^= n >> 15;
    n
}
fn hf(x: i32, y: i32) -> f32 { (hash(x, y) >> 8) as f32 / 16777216.0 }

fn vnoise(x: f32, y: f32) -> f32 {
    let ix = floor(x); let iy = floor(y);
    let fx = x - ix; let fy = y - iy;
    let ux = fx * fx * (3.0 - 2.0 * fx); let uy = fy * fy * (3.0 - 2.0 * fy);
    let (i, j) = (ix as i32, iy as i32);
    let a = hf(i, j); let b = hf(i + 1, j); let c = hf(i, j + 1); let d = hf(i + 1, j + 1);
    a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}
fn fbm(x: f32, y: f32) -> f32 {
    let (mut s, mut a, mut f, mut t) = (0.0, 0.5, 1.0, 0.0);
    let mut o = 0;
    while o < 4 { s += vnoise(x * f + o as f32 * 17.3, y * f) * a; t += a; a *= 0.5; f *= 2.03; o += 1; }
    s / t
}

#[inline] fn idx(x: usize, y: usize, z: usize) -> usize { (z * N + y) * N + x }
fn get(x: i32, y: i32, z: i32) -> u8 {
    if x < 0 || y < 0 || z < 0 || x >= N as i32 || y >= N as i32 || z >= NZ as i32 { return 0; }
    unsafe { W[idx(x as usize, y as usize, z as usize)] }
}
fn set(x: i32, y: i32, z: i32, v: u8) {
    if x < 0 || y < 0 || z < 0 || x >= N as i32 || y >= N as i32 || z >= NZ as i32 { return; }
    unsafe { W[idx(x as usize, y as usize, z as usize)] = v; }
}
fn hgt(x: i32, y: i32) -> i32 {
    if x < 0 || y < 0 || x >= N as i32 || y >= N as i32 { return 0; }
    unsafe { H[y as usize * N + x as usize] as i32 }
}

#[no_mangle] pub extern "C" fn world_ptr() -> *const u8 { unsafe { W.as_ptr() } }
#[no_mangle] pub extern "C" fn height_ptr() -> *const u8 { unsafe { H.as_ptr() } }
#[no_mangle] pub extern "C" fn state_ptr() -> *const f32 { unsafe { S.as_ptr() } }
#[no_mangle] pub extern "C" fn pick_ptr() -> *const i32 { unsafe { PICK.as_ptr() } }
#[no_mangle] pub extern "C" fn get_block(x: i32, y: i32, z: i32) -> u32 { get(x, y, z) as u32 }

// derived data: H = top of terrain-like blocks (not logs/leaves), used for water depth/foam
fn recompute_h(x: i32, y: i32) {
    if x < 0 || y < 0 || x >= N as i32 || y >= N as i32 { return; }
    let mut h = 0;
    let mut z = NZ as i32 - 1;
    while z >= 0 { let b = get(x, y, z); if b != 0 && b != WOOD && b != LEAF { h = z + 1; break; } z -= 1; }
    unsafe { H[y as usize * N + x as usize] = h as u8; }
}
/// raw edit (used for loading saved edits). returns 1 if changed.
#[no_mangle]
pub extern "C" fn set_block(x: i32, y: i32, z: i32, id: u32) -> i32 {
    if x < 0 || y < 0 || z < 0 || x >= N as i32 || y >= N as i32 || z >= NZ as i32 || id > 7 { return 0; }
    if get(x, y, z) as u32 == id { return 0; }
    set(x, y, z, id as u8); recompute_h(x, y); 1
}
/// break a block (z=0 is bedrock). returns the old id or 0.
#[no_mangle]
pub extern "C" fn break_block(x: i32, y: i32, z: i32) -> u32 {
    let b = get(x, y, z);
    if b == 0 || z <= 0 { return 0; }
    set_block(x, y, z, 0); b as u32
}
/// place a block; refuses occupied cells and cells overlapping the player. returns 1 on success.
#[no_mangle]
pub extern "C" fn place_block(x: i32, y: i32, z: i32, id: u32) -> i32 {
    if id == 0 || get(x, y, z) != 0 || x < 0 || y < 0 || z < 0 || x >= N as i32 || y >= N as i32 || z >= NZ as i32 { return 0; }
    let s = unsafe { &S };
    let (fx, fy, fz) = (x as f32, y as f32, z as f32);
    if s[0] + R > fx && s[0] - R < fx + 1.0 && s[1] + R > fy && s[1] - R < fy + 1.0 && s[2] + PH > fz && s[2] < fz + 1.0 { return 0; }
    set_block(x, y, z, id)
}
/// voxel DDA pick from (o) along (d) up to maxd. returns 1 and fills PICK on hit.
#[no_mangle]
pub extern "C" fn pick(ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, maxd: f32) -> i32 {
    let o = [ox, oy, oz]; let d = [dx, dy, dz];
    let mut c = [floor(ox) as i32, floor(oy) as i32, floor(oz) as i32];
    let mut st = [0i32; 3]; let mut tm = [0f32; 3]; let mut dl = [0f32; 3];
    for a in 0..3 {
        st[a] = if d[a] > 0.0 { 1 } else { -1 };
        dl[a] = if abs(d[a]) < 1e-9 { 1e30 } else { abs(1.0 / d[a]) };
        let edge = c[a] as f32 + if d[a] > 0.0 { 1.0 } else { 0.0 };
        tm[a] = if abs(d[a]) < 1e-9 { 1e30 } else { (edge - o[a]) / d[a] };
    }
    let mut n = [0i32; 3]; let mut t = 0.0;
    let mut i = 0;
    while t <= maxd && i < 256 {
        if c[2] >= 0 && c[2] < NZ as i32 && get(c[0], c[1], c[2]) != 0 {
            unsafe { PICK = [c[0], c[1], c[2], n[0], n[1], n[2]]; }
            return 1;
        }
        let a = if tm[0] < tm[1] && tm[0] < tm[2] { 0 } else if tm[1] < tm[2] { 1 } else { 2 };
        t = tm[a]; tm[a] += dl[a]; c[a] += st[a]; n = [0, 0, 0]; n[a] = -st[a];
        i += 1;
    }
    0
}

#[no_mangle]
pub extern "C" fn gen(seed: u32) {
    unsafe { SEED = seed | 1; W.fill(0); }
    let c = N as f32 * 0.5;
    for y in 0..N as i32 {
        for x in 0..N as i32 {
            let dx = (x as f32 - c) / c; let dy = (y as f32 - c) / c;
            // warp the radius a bit so the coast is wobbly
            let r = sqrt(dx * dx + dy * dy) + (vnoise(x as f32 * 0.05, y as f32 * 0.05) - 0.5) * 0.35;
            let e = fbm(x as f32 / 22.0, y as f32 / 22.0);
            let v = e * 1.3 + 0.12 - r * r * 1.2;
            let h = clamp(floor(v * 8.0), 0.0, 9.0) as i32;
            unsafe { H[y as usize * N + x as usize] = h as u8; }
            for z in 0..h {
                let top = z == h - 1;
                let id = if h <= WL { SAND } else if h >= 9 { STONE } else if top { GRASS } else if z < h - 3 { STONE } else { DIRT };
                set(x, y, z, id);
            }
        }
    }
    for i in 0..N * N { unsafe { SEA[i] = (H[i] < WL as u8) as u8; } }
    // a few birch trees
    let mut trees = 0;
    for y in 4..N as i32 - 4 {
        for x in 4..N as i32 - 4 {
            let h = hgt(x, y);
            if h < WL + 1 || h > 8 || get(x, y, h - 1) != GRASS { continue; }
            // trees prefer some patches, sparse elsewhere
            let p = if vnoise(x as f32 * 0.08 + 50.0, y as f32 * 0.08) > 0.58 { 0.1 } else { 0.01 };
            if hf(x + 911, y - 377) > p { continue; }
            let mut ok = true;
            for j in -2..=2 { for i in -2..=2 { if get(x + i, y + j, h) == WOOD || get(x + i, y + j, h + 1) == LEAF || hgt(x + i, y + j) != h { ok = false; } } }
            if !ok { continue; }
            // birch: taller slim trunk, narrow airy crown
            let th = 4 + (hash(x, y) % 2) as i32;
            for z in 0..th { set(x, y, h + z, WOOD); }
            let tz = h + th;
            for j in -2..=2i32 { for i in -2..=2i32 {
                let ring = j.abs() == 2 || i.abs() == 2; let corner = j.abs() == 2 && i.abs() == 2;
                for z in [tz - 2, tz - 1] {
                    if corner || (ring && hf(x + i * 3, y + j * 5 + z) < 0.45) { continue; }
                    if get(x + i, y + j, z) == 0 { set(x + i, y + j, z, LEAF); }
                }
            } }
            for j in -1..=1i32 { for i in -1..=1i32 {
                if get(x + i, y + j, tz - 3) == 0 && (i == 0 || j == 0) && hf(x + i, y + j * 7) < 0.7 { set(x + i, y + j, tz - 3, LEAF); }
                if !(i != 0 && j != 0 && hf(x - i, y + j) < 0.5) { set(x + i, y + j, tz, LEAF); }
                if i == 0 && j == 0 { set(x, y, tz + 1, LEAF); }
            } }
            trees += 1;
        }
    }
    // spawn: highest-ish clear grass spot near centre
    let mut best = (64, 64); let mut bd = 1e9;
    for y in 0..N as i32 { for x in 0..N as i32 {
        let h = hgt(x, y);
        if h < WL + 2 || get(x, y, h) != 0 || get(x, y, h + 1) != 0 { continue; }
        let d = (x as f32 - c) * (x as f32 - c) + (y as f32 - c - 10.0) * (y as f32 - c - 10.0);
        if d < bd { bd = d; best = (x, y); }
    } }
    unsafe {
        S[0] = best.0 as f32 + 0.5; S[1] = best.1 as f32 + 0.5; S[2] = hgt(best.0, best.1) as f32;
        S[3] = 0.0; S[4] = 0.0; S[5] = 1.0; S[6] = 0.0; S[7] = 0.0; S[8] = 1.0; S[9] = trees as f32;
    }
}

// solid for the player: blocks, world edge, and sea treated as a wall
fn solid(bx: i32, by: i32, bz: i32) -> bool {
    if bx < 0 || by < 0 || bx >= N as i32 || by >= N as i32 { return true; }
    if bz < 0 { return true; }
    if get(bx, by, bz) != 0 { return true; }
    (unsafe { SEA[by as usize * N + bx as usize] } != 0) && bz < WL + 4
}
const R: f32 = 0.28; const PH: f32 = 1.7;
fn blocked(x: f32, y: f32, z: f32) -> bool {
    let (x0, x1) = (floor(x - R) as i32, floor(x + R) as i32);
    let (y0, y1) = (floor(y - R) as i32, floor(y + R) as i32);
    let (z0, z1) = (floor(z + 0.001) as i32, floor(z + PH) as i32);
    for bz in z0..=z1 { for by in y0..=y1 { for bx in x0..=x1 { if solid(bx, by, bz) { return true; } } } }
    false
}

/// mx,my: stick (right, forward) in camera space; yaw: camera yaw; flags bit0 jump bit1 run
#[no_mangle]
pub extern "C" fn step(dt: f32, mx: f32, my: f32, yaw: f32, flags: u32) {
    let dt = clamp(dt, 0.0, 0.05);
    let s = unsafe { &mut S };
    let (fx, fy) = (unsafe { cos(yaw) }, unsafe { sin(yaw) });
    let (rx, ry) = (fy, -fx);
    let mut wx = rx * mx + fx * my; let mut wy = ry * mx + fy * my;
    let l = sqrt(wx * wx + wy * wy);
    if l > 1.0 { wx /= l; wy /= l; }
    let mag = if l > 1.0 { 1.0 } else { l };
    let speed = if flags & 2 != 0 { 7.0 } else { 4.2 };
    let ground = s[8] > 0.5;
    if mag > 0.05 {
        // turn facing towards movement
        let k = clamp(dt * 14.0, 0.0, 1.0);
        let nfx = s[4] + (wx / l.max(1e-4) - s[4]) * k; let nfy = s[5] + (wy / l.max(1e-4) - s[5]) * k;
        let nl = sqrt(nfx * nfx + nfy * nfy).max(1e-4);
        s[4] = nfx / nl; s[5] = nfy / nl;
    }
    let (dx, dy) = (wx * speed * dt, wy * speed * dt);
    let mut moved = 0.0;
    // x axis
    for axis in 0..2 {
        let (nx, ny) = if axis == 0 { (s[0] + dx, s[1]) } else { (s[0], s[1] + dy) };
        if abs(nx - s[0]) + abs(ny - s[1]) < 1e-6 { continue; }
        if !blocked(nx, ny, s[2]) {
            moved += abs(nx - s[0]) + abs(ny - s[1]); s[0] = nx; s[1] = ny;
        } else if ground {
            // auto step up one block (Minecraft-style auto jump)
            let up = floor(s[2] + 0.001) + 1.0;
            if !blocked(s[0], s[1], up) && !blocked(nx, ny, up) {
                s[2] = up; moved += abs(nx - s[0]) + abs(ny - s[1]); s[0] = nx; s[1] = ny;
            }
        }
    }
    // vertical
    if ground && flags & 1 != 0 { s[3] = 8.6; s[8] = 0.0; }
    s[3] -= 28.0 * dt;
    let nz = s[2] + s[3] * dt;
    if s[3] <= 0.0 && blocked(s[0], s[1], nz) {
        s[2] = floor(nz + 0.001) + 1.0; if s[2] > nz + 1.0 { s[2] = floor(nz) + 1.0; }
        s[3] = 0.0; s[8] = 1.0;
    } else if s[3] > 0.0 && blocked(s[0], s[1], nz) {
        s[3] = 0.0; s[8] = 0.0;
    } else { s[2] = nz; s[8] = 0.0; }
    if s[2] < -5.0 { s[2] = 20.0; }
    s[6] += moved * 3.2;
    let target = if moved > 1e-4 { 1.0 } else { 0.0 };
    s[7] += (target - s[7]) * clamp(dt * 10.0, 0.0, 1.0);
}
