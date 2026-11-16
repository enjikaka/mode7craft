// Build: compile wasm core, optimize, inline JS+WGSL into one HTML, precompress.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const root = new URL('..', import.meta.url).pathname;
const sh = (c: string) => {
  try {
    execSync(c, { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
  } catch (err) {
    const status = typeof err === 'object' && err && 'status' in err && typeof err.status === 'number' ? err.status : 1;
    console.error(err instanceof Error ? err.message : err);
    console.error(`command failed (${status || 1}): ${c}`);
    process.exit(status || 1);
  }
};
function wasmOptFromPath(): string | undefined {
  try {
    const found = execSync('command -v wasm-opt', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return found && existsSync(found) ? found : undefined;
  } catch {
    return undefined;
  }
}
sh('cd core && cargo build --release --target wasm32-unknown-unknown');
mkdirSync(root + 'dist', { recursive: true });
const raw = root + 'core/target/wasm32-unknown-unknown/release/core.wasm';
if (!existsSync(raw)) {
  console.error(`cargo did not produce ${raw}`);
  process.exit(1);
}
const wasmOpt = ['/tmp/bn/node_modules/.bin/wasm-opt', root + 'node_modules/.bin/wasm-opt'].find(existsSync) ?? wasmOptFromPath();
const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
if (wasmOpt) {
  console.log(`wasm-opt: ${wasmOpt}`);
  sh(`${q(wasmOpt)} -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --strip-debug --strip-producers ${q(raw)} -o dist/g.wasm`);
} else {
  console.log('wasm-opt not found; copying unoptimized wasm');
  copyFileSync(raw, root + 'dist/g.wasm');
}
const wgsl = (f: string) => readFileSync(root + 'web/' + f, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}();,:=<>+\-*\/&|^!?\[\]]) ?/g, '$1').replace(/>>/g, ' >> ').trim();
const js = readFileSync(root + 'web/main.js', 'utf8').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\n\s+/g, '\n');
const html = readFileSync(root + 'web/index.html', 'utf8').replace('/*SCENE*/', () => wgsl('scene.wgsl')).replace('/*BLIT*/', () => wgsl('blit.wgsl')).replace('/*MAIN*/', () => js).replace(/>\n</g, '><');
writeFileSync(root + 'dist/index.html', html);
let gz = 0, br = 0;
for (const f of ['index.html', 'g.wasm']) {
  const b = readFileSync(root + 'dist/' + f);
  const g = gzipSync(b, { level: 9 }), r = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(root + 'dist/' + f + '.gz', g); writeFileSync(root + 'dist/' + f + '.br', r);
  gz += g.length; br += r.length;
  console.log(`${f}: ${b.length} B raw, ${g.length} B gzip, ${r.length} B brotli`);
}
console.log(`TOTAL: ${gz} B gzip, ${br} B brotli`);
