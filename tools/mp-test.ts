// Two-player WebRTC test in one headless Chrome (SwiftShader WebGPU): host tab A invites, guest tab B joins via
// the #join link, tab C opens B's #svar answer link (handed to A over BroadcastChannel), then world sync,
// edits both ways, positions + nametags. Usage: node tools/mp-test.ts [base-url] [out-prefix]
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
const MOCK = process.env.MOCK === '1' ? readFileSync(new URL('./mock-rtc.js', import.meta.url), 'utf8') : '';
const base = process.argv[2] ?? 'http://localhost:8787/', baseB = process.env.BASEB ?? base.replace('localhost', '127.0.0.1');   // guest on another origin = its own localStorage
const out = process.argv[3] ?? '/tmp/mp';
const W = +(process.env.W ?? 640), H = +(process.env.H ?? 360);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
rmSync('/tmp/chmp', { recursive: true, force: true });
const extra = (process.env.CHFLAGS ?? '').split(' ').filter(Boolean);
const ch = spawn('google-chrome', [...extra, '--headless=new', '--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan,WebGPUService', '--use-vulkan=swiftshader', '--ignore-gpu-blocklist',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=9334', `--window-size=${W},${H}`, '--user-data-dir=/tmp/chmp', 'about:blank'], { stdio: 'ignore' });
let ver: any; for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9334/json/version')).json(); } catch { await sleep(200); } }
// one CDP connection to the browser, sessions per tab (flatten)
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data as string);
  if (d.id && pend.has(d.id)) { pend.get(d.id)!(d.result ?? d.error); pend.delete(d.id); }
  else if (d.method === 'Runtime.bindingCalled' && d.params.name === '__mockSend') { for (const sid of tabName.keys()) cmd('Runtime.evaluate', { expression: `window.__mockRecv?.(${JSON.stringify(d.params.payload)})` }, sid); }
  else if (d.method === 'Runtime.consoleAPICalled') console.log(`[${tabName.get(d.sessionId)}]`, d.params.args.map((a: any) => a.value ?? a.description).join(' ').slice(0, 300));
  else if (d.method === 'Runtime.exceptionThrown') console.log(`[${tabName.get(d.sessionId)}] EXC`, JSON.stringify(d.params.exceptionDetails).slice(0, 400));
};
const cmd = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const tabName = new Map<string, string>();
const tab = async (name: string) => {
  const { targetId } = await cmd('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await cmd('Target.attachToTarget', { targetId, flatten: true }); tabName.set(sessionId, name);
  const c = (m: string, p: any = {}) => cmd(m, p, sessionId);
  await c('Runtime.enable'); await c('Page.enable'); if (MOCK) { await c('Runtime.addBinding', { name: '__mockSend' }); await c('Page.addScriptToEvaluateOnNewDocument', { source: MOCK }); } await c('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const ev = async (expr: string) => { const e = await c('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (e.exceptionDetails) throw new Error(name + ': ' + JSON.stringify(e.exceptionDetails).slice(0, 400)); return e.result?.value; };
  const until = async (expr: string, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(expr); if (v) return v; } catch {} await sleep(250); } throw new Error(`${name}: timeout waiting for ${expr}`); };
  const go = async (url: string) => { await c('Page.navigate', { url }); };
  const shot = async (f: string) => { const s = await c('Page.captureScreenshot', { format: 'png' }); writeFileSync(f, Buffer.from(s.data, 'base64')); };
  const key = async (code: string, ms: number) => { await c('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Key', '').toLowerCase() }); await sleep(ms); await c('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase() }); };
  return { ev, until, go, shot, key, c, targetId };
};
console.log(MOCK ? 'transport: MOCK (CDP-relayed stand-in for RTCPeerConnection)' : 'transport: real WebRTC');
const ok = (c: any, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const q = base.includes('?') ? '&' : '?';
const A = await tab('A'), B = await tab('B');
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
try {
  // host: fresh world + one edit (a plank pillar next to the spawn), name
  await A.go(base + q + 'reset&fx=' + (process.env.FX ?? '0') + '&area=' + (process.env.AREA ?? '12000') + (process.env.EXTRA ?? '') + '&p=128,128'); await A.until('window.m7 && !document.querySelector("#l")');
  await A.ev(`localStorage.setItem('m7c-name','Jeremy'); m7.net.name='Jeremy'`);
  const hed = await A.ev(`(() => { const X = m7.X, N = 256, H = new Uint8Array(X.memory.buffer, X.height_ptr(), N * N), x = 131, y = 128, h = H[y * N + x]; for (let z = h; z < h + 3; z++) { X.set_block(x, y, z, 7); } m7.loadWorld(new Map([...m7.edits, ...[0,1,2].map((k) => [((h + k) * N + y) * N + x, 7])])); return [x, y, h, m7.edits.size]; })()`);
  console.log(T(), 'host edits', hed);
  // guest: own world first (with one own edit that must survive), then the invite link
  await B.go(baseB + q + 'reset&fx=' + (process.env.FX ?? '0') + '&area=' + (process.env.AREA ?? '12000') + (process.env.EXTRA ?? '') + '&p=60,60'); await B.until('window.m7 && !document.querySelector("#l")');
  await B.ev(`(() => { const X = m7.X, N = 256, H = new Uint8Array(X.memory.buffer, X.height_ptr(), N * N), h = H[60 * N + 62]; m7.loadWorld(new Map([[(h * N + 60) * N + 62, 4]])); m7.save(); })()`);
  await sleep(600); const ownB = await B.ev(`localStorage.getItem('m7c-edits-2')`); const lsB = async (w: string) => console.log(T(), 'B save @' + w, await B.ev(`localStorage.getItem('m7c-edits-2')`), await B.ev('m7.net.mp + " noSave? " + m7.edits.size')); console.log(T(), 'guest own save', ownB);
  const inv = await A.ev(`m7.net.invite()`); console.log(T(), 'invite link', inv.length, 'chars');
  ok(inv.includes('#join=') && await A.ev(`!!document.querySelector('#nq') && document.querySelector('#nq').width > 0`), 'invite sheet shows link + QR');
  if (process.env.TODB) await B.ev(`localStorage.setItem('m7c-tod', '${process.env.TODB}')`);
  await B.go(inv.replace(base, baseB)); await B.until('window.m7', 60000); await lsB('after join nav'); await B.until('window.m7 && !document.querySelector("#l") && !!document.querySelector("#nn")');
  ok(await B.ev(`document.querySelector('#n').textContent.includes('Jeremys')`), 'guest sees "Gå med i Jeremys värld"');
  await B.ev(`document.querySelector('#nn').value = 'Kompis'; document.querySelector('#n [data-n=ok]').click()`);
  const ans = (await B.until(`document.querySelector('#nl')?.value`, 20000)).replace(baseB, base); console.log(T(), 'answer link', ans.length, 'chars');
  // the host opens the answer link in a new tab (as from a chat app); it reaches tab A over BroadcastChannel
  const C = await tab('C'); await C.go(ans); await C.until(`document.querySelector('#n')?.textContent.includes('Klart')`, 30000);
  ok(true, 'answer tab handed over to the host tab (BroadcastChannel)'); await cmd('Target.closeTarget', { targetId: C.targetId });
  await A.until(`m7.net.peers.size === 1`, 20000); await B.until(`m7.net.mp === 'guest' && m7.net.wr === 1`, 20000);
  ok(true, `connected at ${T()}`); await lsB('connected');
  console.log('host pos', await A.ev(`[...new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 3)]`), 'guest pos', await B.ev(`[...new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 3)]`));
  ok(await B.ev(`m7.edits.size`) === hed[3] && await B.ev(`m7.X.get_block(${hed[0]}, ${hed[1]}, ${hed[2] + 2})`) === 7, 'guest got the host world');
  ok(await A.ev(`[...m7.net.rp.values()].map((r) => r.n).join()`) === 'Kompis' && await B.ev(`[...m7.net.rp.values()].map((r) => r.n).join()`) === 'Jeremy', 'rosters');
  { const pa = await A.ev(`[...new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 3)]`), pb = await B.ev(`[...new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 3)]`); ok(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 4, 'guest spawned next to the host'); }
  const fps = `new Promise((ok) => { let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => ok(n / 2), 2000); })`;
  console.log(T(), 'fps A', await A.ev(fps), 'B', await B.ev(fps));
  // guest edit -> host (saved there), echoed back; guest's own save untouched
  const ge = await B.ev(`(() => { const X = m7.X, N = 256, H = new Uint8Array(X.memory.buffer, X.height_ptr(), N * N), x = 127, y = 131, h = H[y * N + x]; m7.setSlot(2); m7.act({ b: [x, y, h - 1], n: [0, 0, 1] }, true); return [x, y, h, X.get_block(x, y, h)]; })()`);
  console.log(T(), 'guest placed', ge);
  await A.until(`m7.X.get_block(${ge[0]}, ${ge[1]}, ${ge[2]}) === 4`, 5000); ok(true, 'guest edit reached the host');
  await sleep(700); ok((await A.ev(`localStorage.getItem('m7c-edits-2')`) || '').length > 0 && await A.ev(`m7.edits.get(((${ge[2]}) * 256 + ${ge[1]}) * 256 + ${ge[0]})`) === 4, 'host saved it');
  await lsB('after guest edit'); ok(await B.ev(`localStorage.getItem('m7c-edits-2')`) === ownB, 'guest own save untouched');
  // host edit -> guest
  await A.ev(`m7.act({ b: [${hed[0]}, ${hed[1]}, ${hed[2] + 2}], n: [0, 0, 1] }, false)`);
  await B.until(`m7.X.get_block(${hed[0]}, ${hed[1]}, ${hed[2] + 2}) === 0`, 5000); ok(true, 'host break reached the guest');
  // movement: guest walks, host sees it interpolated; nametags visible
  const p0 = await A.ev(`(() => { const r = m7.net.rp.get(1); return r.q.length ? r.q[r.q.length - 1][1].slice(0, 3) : null; })()`);
  await B.ev(`new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 3)[0] += 3`); await sleep(800);   // (SwiftShader runs ~1-2 fps here, so move by teleport)
  const p1 = await A.ev(`(() => { const r = m7.net.rp.get(1); return r.q[r.q.length - 1][1].slice(0, 3); })()`);
  console.log(T(), 'guest pos seen by host', p0, '->', p1); ok(p0 && Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 1, 'host sees the guest move');
  ok(await A.ev(`m7.net.rp.get(1).tag.style.display === 'block'`) && await B.ev(`m7.net.rp.get(0).tag.style.display === 'block'`), 'nametags shown');
  const rate = await A.ev(`new Promise((ok) => { const r = m7.net.rp.get(1), s = r.seq; setTimeout(() => ok((r.seq - s) / 2), 2000); })`); console.log(T(), 'state packets/s', rate); ok(rate > 10 && rate < 20, '~15 Hz');
  // pose for the screenshots: guest 2.5 blocks to the host's right, a bit ahead, both facing the camera side
  await B.ev(`(() => { const s = new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 8), h = ${JSON.stringify(await A.ev(`[...new Float32Array(m7.X.memory.buffer, m7.X.state_ptr(), 3)]`))}; s[0] = h[0] + 2.5; s[1] = h[1] + 1.5; })()`);
  await sleep(+(process.env.SHOTWAIT ?? 2500)); await A.shot(out + '-host.png'); await B.shot(out + '-guest.png');
  // guest leaves -> own world back; host roster empty
  await B.ev(`m7.net.leave()`); await A.until(`m7.net.peers.size === 0 && m7.net.rp.size === 0`, 10000); ok(true, 'host noticed the guest leaving');
  ok(await B.ev(`m7.edits.size`) === 1 && await B.ev(`m7.X.get_block(${hed[0]}, ${hed[1]}, ${hed[2]})`) === 0, 'guest has its own world back');
} catch (e) { console.log('FAIL', (e as Error).message); process.exitCode = 1;
  for (const [n, X] of [['A', A], ['B', B]] as const) console.log(n, await X.ev(`JSON.stringify({ mp: m7.net.mp, pend: [...m7.net.pend].map(([k, p]) => [k, p.pc.signalingState, p.pc.iceGatheringState, p.pc.iceConnectionState, p.pc.connectionState, p.r.readyState]), peers: m7.net.peers.size, sdp: [...m7.net.pend.values()].map((p) => [p.pc.localDescription?.sdp, p.pc.remoteDescription?.sdp]) })`).catch((e) => e.message));
}
console.log('done', T());
cmd('Browser.close'); await Promise.race([new Promise((r) => ch.once('exit', r)), sleep(3000)]); ch.kill('SIGKILL'); process.exit();
