// Build: compile wasm core, optimize, inline JS+WGSL into one HTML, precompress.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const root = new URL('..', import.meta.url).pathname;
const sh = (c: string) => execSync(c, { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
mkdirSync(root + 'dist', { recursive: true });
// KEEPWASM=1: reuse dist/g.wasm (the Rust core rarely changes) when no Rust toolchain is installed
if (!(process.env.KEEPWASM && existsSync(root + 'dist/g.wasm'))) {
sh('cd core && cargo build --release --target wasm32-unknown-unknown');
const raw = root + 'core/target/wasm32-unknown-unknown/release/core.wasm';
const onPath = (process.env.PATH ?? '').split(':').map((d) => d + '/wasm-opt');
const wasmOpt = [...onPath, root + 'node_modules/.bin/wasm-opt', '/tmp/bn/node_modules/.bin/wasm-opt'].find(existsSync);
if (!wasmOpt) console.warn('wasm-opt not found (PATH or node_modules); shipping unoptimized wasm');
if (wasmOpt) sh(`${wasmOpt} -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --strip-debug --strip-producers ${raw} -o dist/g.wasm`);
else copyFileSync(raw, root + 'dist/g.wasm');
}
const wgsl = (f: string) => readFileSync(root + 'web/' + f, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}();,:=<>+\-*\/&|^!?\[\]]) ?/g, '$1').replace(/>>/g, ' >> ').trim();
const js = readFileSync(root + 'web/main.js', 'utf8').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\n\s+/g, '\n');
const html = readFileSync(root + 'web/index.html', 'utf8').replace('/*SCENE*/', () => wgsl('scene.wgsl')).replace('/*BLIT*/', () => wgsl('blit.wgsl')).replace('/*HQ*/', () => wgsl('hq.wgsl')).replace('/*MAIN*/', () => js).replace(/>\n</g, '><');
writeFileSync(root + 'dist/index.html', html);
const stack = readFileSync(root + 'web/stack.js', 'utf8').replace('/*STACK*/', () => wgsl('stack.wgsl')).replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\n\s+/g, '\n');
writeFileSync(root + 'dist/stack.js', stack);
let gz = 0, br = 0;
for (const f of ['index.html', 'g.wasm', 'stack.js']) {
  const b = readFileSync(root + 'dist/' + f);
  const g = gzipSync(b, { level: 9 }), r = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(root + 'dist/' + f + '.gz', g); writeFileSync(root + 'dist/' + f + '.br', r);
  gz += g.length; br += r.length;
  console.log(`${f}: ${b.length} B raw, ${g.length} B gzip, ${r.length} B brotli`);
}
console.log(`TOTAL: ${gz} B gzip, ${br} B brotli`);
