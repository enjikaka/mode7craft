// Node test of the wasm block editing API: pick, break, place, heightmap, player overlap.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const b = readFileSync(new URL('../core/target/wasm32-unknown-unknown/release/core.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(b, { env: { msin: Math.sin, mcos: Math.cos, msqrt: Math.sqrt } });
const e: any = instance.exports; e.gen(1337);
const N = 128;
const S = new Float32Array(e.memory.buffer, e.state_ptr(), 16);
const H = () => new Uint8Array(e.memory.buffer, e.height_ptr(), N * N);
const P = new Int32Array(e.memory.buffer, e.pick_ptr(), 6);
const [px, py, pz] = [Math.floor(S[0]), Math.floor(S[1]), S[2]];
// pick straight down from above the player: hits the block he stands on
assert.equal(e.pick(S[0], S[1], pz + 1.5, 0, 0, -1, 6), 1);
assert.deepEqual([...P], [px, py, pz - 1, 0, 0, 1]);
// can't place inside the player
assert.equal(e.place_block(px, py, pz, 4), 0);
// break a block next to the player, heightmap follows
const nx = px + 2, h0 = H()[py * N + nx];
assert.ok(e.get_block(nx, py, h0 - 1) !== 0);
assert.ok(e.break_block(nx, py, h0 - 1) > 0);
assert.equal(e.get_block(nx, py, h0 - 1), 0);
assert.equal(H()[py * N + nx], h0 - 1);
// bedrock z=0 can't be broken; placing on occupied fails
assert.equal(e.break_block(nx, py, 0), 0);
assert.equal(e.place_block(nx, py, 0, 4), 0);
// build a 3-tower and check heightmap; logs/leaves don't count as terrain height
for (let z = h0 - 1; z < h0 + 2; z++) assert.equal(e.place_block(nx, py, z, 4), 1);
assert.equal(H()[py * N + nx], h0 + 2);
assert.equal(e.place_block(nx, py, h0 + 2, 5), 1);
assert.equal(H()[py * N + nx], h0 + 2);
// side pick hits the tower face facing the player
assert.equal(e.pick(S[0], S[1], pz + 1.5, 1, 0, 0, 6), 1);
assert.deepEqual([...P].slice(0, 4), [nx, py, Math.floor(pz + 1.5), -1]);
// player physics still fine: walk into the tower -> blocked
for (let i = 0; i < 60; i++) e.step(1 / 60, 0, 1, 0, 0);
assert.ok(S[0] < nx - 0.2, 'tower blocks player, x=' + S[0]);
console.log('edit tests OK');
