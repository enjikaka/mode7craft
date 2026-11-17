import { readFileSync } from 'node:fs';
const b = readFileSync(new URL('../core/target/wasm32-unknown-unknown/release/core.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(b, { env: { msin: Math.sin, mcos: Math.cos, msqrt: Math.sqrt } });
const e: any = instance.exports;
const N = 256, n = Number(process.argv[3] ?? N);   // world size, island size (128 = pre-v11 island)
e.gen(Number(process.argv[2] ?? 1337), n);
const mem = new Uint8Array(e.memory.buffer);
const H = mem.subarray(e.height_ptr(), e.height_ptr() + N * N);
const W = mem.subarray(e.world_ptr(), e.world_ptr() + N * N * 16);
const S = new Float32Array(e.memory.buffer, e.state_ptr(), 16);
let out = '';
for (let y = 0; y < n; y += 2) { let l = ''; for (let x = 0; x < n; x += n / 128) { const h = H[y * N + x]; const t = W[(h * N + y) * N + x]; l += t === 5 || t===6 ? 'T' : h < 3 ? (h === 2 ? '~' : ' ') : String(h); } out += l + '\n'; }
console.log(out, 'spawn', S[0], S[1], S[2], 'trees', S[9]);
