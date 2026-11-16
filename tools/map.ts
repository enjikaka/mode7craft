import { readFileSync } from 'node:fs';
const b = readFileSync(new URL('../core/target/wasm32-unknown-unknown/release/core.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(b, { env: { msin: Math.sin, mcos: Math.cos, msqrt: Math.sqrt } });
const e: any = instance.exports;
e.gen(Number(process.argv[2] ?? 1337));
const mem = new Uint8Array(e.memory.buffer);
const H = mem.subarray(e.height_ptr(), e.height_ptr() + 128 * 128);
const W = mem.subarray(e.world_ptr(), e.world_ptr() + 128 * 128 * 16);
const S = new Float32Array(e.memory.buffer, e.state_ptr(), 16);
let out = '';
for (let y = 0; y < 128; y += 2) { let l = ''; for (let x = 0; x < 128; x++) { const h = H[y * 128 + x]; const t = W[(h * 128 + y) * 128 + x]; l += t === 5 || t===6 ? 'T' : h < 3 ? (h === 2 ? '~' : ' ') : String(h); } out += l + '\n'; }
console.log(out, 'spawn', S[0], S[1], S[2], 'trees', S[9]);
