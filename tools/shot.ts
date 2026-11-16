// Headless Chrome (SwiftShader WebGPU) smoke test via CDP: console logs + screenshot.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const url = process.argv[2] ?? 'http://localhost:8787/';
const out = process.argv[3] ?? new URL('../screenshot.png', import.meta.url).pathname;
const w = Number(process.argv[4] ?? 1280), h = Number(process.argv[5] ?? 720);
const keysArg = process.argv[6] ?? '';
const evalArg = process.argv[7] ?? '';
const extra = (process.env.CHFLAGS ?? '').split(' ').filter(Boolean);
import { rmSync } from 'node:fs'; rmSync('/tmp/chprof/Default/Sessions', { recursive: true, force: true }); rmSync('/tmp/chprof/Default/Current Session', { force: true }); rmSync('/tmp/chprof/Default/Sessions_Encrypted', { recursive: true, force: true });
const ch = spawn('google-chrome', [...extra, '--headless=new', '--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan,WebGPUService', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist', '--remote-debugging-port=9333', `--window-size=${w},${h}`, '--user-data-dir=/tmp/chprof', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tabs: any[] = [];
for (let i = 0; i < 50; i++) { try { tabs = await (await fetch('http://127.0.0.1:9333/json')).json(); if (tabs.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map<number, (v: any) => void>();
ws.onmessage = (m) => { const d = JSON.parse(m.data as string); if (d.id && pend.has(d.id)) { pend.get(d.id)!(d.result ?? d.error); pend.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled') console.log('console:', d.params.args.map((a: any) => a.value ?? a.description).join(' ')); else if (d.method === 'Runtime.exceptionThrown') console.log('EXC:', JSON.stringify(d.params.exceptionDetails).slice(0, 500)); };
const cmd = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd('Runtime.enable'); await cmd('Network.enable'); await cmd('Network.setCacheDisabled', { cacheDisabled: true });
await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
// FREEZE=1: fixed clock (rAF timestamps + performance.now) for deterministic, diffable frames
if (process.env.DL) await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: process.env.DL });
if (process.env.FREEZE) await cmd('Page.enable'), await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `{const T=1000;performance.now=()=>T;const r=requestAnimationFrame.bind(window);window.requestAnimationFrame=(cb)=>r(()=>cb(T));}` });
await cmd('Page.navigate', { url });
await sleep(4000);
for (const k of keysArg.split(',').filter(Boolean)) {
  const [code, ms] = k.split(':');
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Key', '').toLowerCase() });
  await sleep(Number(ms ?? 500));
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase() });
}
if (evalArg) { const e = await cmd('Runtime.evaluate', { expression: evalArg, returnByValue: true, awaitPromise: true }); console.log('eval:', JSON.stringify(e.result?.value ?? e.exceptionDetails ?? e)); }
await sleep(1500);
const r = await cmd('Runtime.evaluate', { expression: `JSON.stringify({gpu:!!navigator.gpu, err:document.querySelector('#e').textContent, hint:document.querySelector('#h').textContent, ls:(localStorage.getItem('m7c-edits-1')||'').slice(0,80)})`, returnByValue: true });
console.log('state:', r.result?.value);
// NOUI=1: hide DOM overlays so only the canvas is compared
if (process.env.NOUI) { await cmd('Runtime.evaluate', { expression: `document.querySelectorAll('body>*:not(canvas)').forEach((e)=>e.style.visibility='hidden')` }); await sleep(300); }
const s = await cmd('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(s.data, 'base64')); console.log('saved', out);
cmd('Browser.close'); await Promise.race([new Promise((r) => ch.once('exit', r)), sleep(3000)]); ws.close(); ch.kill('SIGKILL');
process.exit(0);
