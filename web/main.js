// Mode7craft front-end: WebGPU renderer + input. World + game logic live in g.wasm.
const $ = (s) => document.querySelector(s);
const cv = $('#c'), hint = $('#h');
const fail = (m) => { $('#e').textContent = m; $('#e').style.display = 'flex'; };
const wasmP = WebAssembly.instantiateStreaming(fetch('g.wasm'), { env: { msin: Math.sin, mcos: Math.cos, msqrt: Math.sqrt } });
(async () => {
  if (!navigator.gpu) return fail('WebGPU is not available in this browser. Try Chrome/Edge 113+, Safari 26+ (iOS 26), or enable WebGPU in your browser flags.');
  const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!ad) return fail('WebGPU is supported but no GPU adapter was found.');
  const dev = await ad.requestDevice();
  dev.addEventListener('uncapturederror', (e) => console.error(e.error.message));
  dev.lost.then((i) => fail('GPU device lost: ' + i.message));
  const { instance } = await wasmP; const X = instance.exports;
  X.gen(1337);
  const mem = () => X.memory.buffer;
  const N = 128, NZ = 16;
  const qs = new URLSearchParams(location.search);
  // ---------- saved edits (localStorage diff: base36 index + block id) ----------
  const KEY = 'm7c-edits-1', edits = new Map();
  if (qs.has('reset')) localStorage.removeItem(KEY);
  for (const e of (localStorage.getItem(KEY) || '').split(',')) {
    if (!e) continue; const i = parseInt(e.slice(0, -1), 36), id = +e.slice(-1);
    edits.set(i, id); X.set_block(i % N, (i / N | 0) % N, i / (N * N) | 0, id);
  }
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, [...edits].map(([i, id]) => i.toString(36) + id).join(',')); } catch {} }, 400); };

  const ctx = cv.getContext('webgpu'), fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque' });
  const T = GPUTextureUsage;
  const vox = dev.createTexture({ size: [N, N, NZ], dimension: '3d', format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const hm = dev.createTexture({ size: [N, N], format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  dev.queue.writeTexture({ texture: vox }, new Uint8Array(mem(), X.world_ptr(), N * N * NZ), { bytesPerRow: N, rowsPerImage: N }, [N, N, NZ]);
  dev.queue.writeTexture({ texture: hm }, new Uint8Array(mem(), X.height_ptr(), N * N), { bytesPerRow: N }, [N, N]);
  // partial upload: only the touched voxel + its heightmap texel
  const touch1 = (x, y, z, id) => {
    dev.queue.writeTexture({ texture: vox, origin: [x, y, z] }, new Uint8Array([id]), {}, [1, 1, 1]);
    dev.queue.writeTexture({ texture: hm, origin: [x, y] }, new Uint8Array(mem(), X.height_ptr() + y * N + x, 1), {}, [1, 1]);
    edits.set((z * N + y) * N + x, id); save(); lightsT = 0;
  };
  // ---------- world files: 'M7C' + version 1 + flags (1 = deflate-raw) + 3 bytes per edit:
  // (index delta << 4 | id), indices sorted. Same bytes go base64url into share links (#w=...).
  const MAXI = N * N * NZ;
  const zip = async (b, un) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new (un ? DecompressionStream : CompressionStream)('deflate-raw'))).arrayBuffer());
  const pack = async () => {
    const e = [...edits].sort((a, b) => a[0] - b[0]); let r = new Uint8Array(e.length * 3), prev = 0;
    e.forEach(([i, id], k) => { const v = (i - prev) << 4 | id; prev = i; r.set([v >> 16, v >> 8 & 255, v & 255], k * 3); });
    const z = typeof CompressionStream == 'function'; if (z) r = await zip(r);
    const o = new Uint8Array(r.length + 5); o.set([77, 55, 67, 1, +z]); o.set(r, 5); return o;
  };
  const unpack = async (b) => {
    if (b.length < 5 || b[0] != 77 || b[1] != 55 || b[2] != 67 || b[3] != 1 || b[4] > 1) throw 0;
    let r = b.subarray(5); if (b[4]) r = await zip(r, 1);
    if (r.length % 3) throw 0;
    const m = new Map(); let i = 0;
    for (let k = 0; k < r.length; k += 3) { const v = r[k] << 16 | r[k + 1] << 8 | r[k + 2], id = v & 15; i += v >> 4; if (i >= MAXI || id > 8) throw 0; m.set(i, id); }
    return m;
  };
  const b64 = (b) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  // replace the world: fresh island + imported edits, full re-upload
  const loadWorld = (m) => {
    X.gen(1337); edits.clear(); parts.length = 0;
    for (const [i, id] of m) { edits.set(i, id); X.set_block(i % N, (i / N | 0) % N, i / (N * N) | 0, id); }
    dev.queue.writeTexture({ texture: vox }, new Uint8Array(mem(), X.world_ptr(), N * N * NZ), { bytesPerRow: N, rowsPerImage: N }, [N, N, NZ]);
    dev.queue.writeTexture({ texture: hm }, new Uint8Array(mem(), X.height_ptr(), N * N), { bytesPerRow: N }, [N, N]);
    save(); lightsT = 0; cz = st[2];
  };
  const ask = (m) => !edits.size || confirm(`Ers\u00e4tt din v\u00e4rld med den importerade (${m.size} \u00e4ndringar)?`);
  const toast = (m) => { hint.textContent = m; clearTimeout(toast.t); toast.t = setTimeout(setHint, 3500); };
  const importBytes = async (b) => { let m; try { m = await unpack(b); } catch { toast('Ogiltig v\u00e4rldsfil'); return 0; } if (!ask(m)) return 0; loadWorld(m); toast(`V\u00e4rld laddad: ${m.size} \u00e4ndringar`); return m.size; };
  const exportWorld = async () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([await pack()], { type: 'application/octet-stream' }));
    a.download = 'mode7craft.m7c'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const shareLink = async () => {
    const url = location.origin + location.pathname + '#w=' + b64(await pack());
    if (url.length > 30000) { toast('V\u00e4rlden \u00e4r f\u00f6r stor f\u00f6r en l\u00e4nk \u2013 anv\u00e4nd Exportera'); return url; }
    try { if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Mode7craft', url }); else { await navigator.clipboard.writeText(url); toast('L\u00e4nk kopierad'); } }
    catch { prompt('Kopiera l\u00e4nken:', url); }
    return url;
  };
  const fileIn = $('#f');
  fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) importBytes(new Uint8Array(await f.arrayBuffer())); });
  // torches: nearest 32 to the player go to the uniform as point lights
  let lights = [], lightsT = 0;
  const ub = dev.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const tb = dev.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bb = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const mk = (code, f, e = 'fs', c) => { const m = dev.createShaderModule({ code }); m.getCompilationInfo?.().then((i) => i.messages.forEach((x) => console.warn(x.type, x.lineNum, x.message))); return dev.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: e, constants: c, targets: [{ format: f }] } }); };
  const scene = mk(SCENE_WGSL, 'rgba8unorm'), blit = mk(BLIT_WGSL, fmt);
  // HQ setting: same scene shader with the HQ override on (HDR target) + bloom + tonemap passes.
  // Built and allocated only when HQ is switched on; standard mode never touches any of it.
  const fxq = qs.get('fx'); let hq = fxq != null ? fxq === '1' : localStorage.getItem('m7c-fx') === '1';
  const tq = qs.get('tod'); let tod = tq != null ? (isNaN(+tq) ? tq : +tq) : localStorage.getItem('m7c-tod') || 'day', Q = null, bt, lt, bgB, bgO;
  const hqP = () => Q ||= { scene: mk(SCENE_WGSL, 'rgba16float', 'fs', { HQ: 1 }), bloom: mk(HQ_WGSL, 'rgba16float', 'fb'), out: mk(HQ_WGSL, 'rgba8unorm', 'fo'), sm: dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }) };
  const bgr = (p, r) => dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: r.map((resource, binding) => ({ binding, resource })) });
  let rt, sg, bg, W = 0, H = 0, px = 1, iw = 0, ih = 0, AREA = +qs.get("area") || (hq ? 70000 : 115000), cross = 0;
  const resize = () => {
    const d = Math.min(devicePixelRatio || 1, 3);
    W = Math.max(1, Math.round(innerWidth * d)); H = Math.max(1, Math.round(innerHeight * d));
    cv.width = W; cv.height = H;
    px = Math.max(1, Math.round(Math.sqrt(W * H / AREA)));
    iw = Math.ceil(W / px); ih = Math.ceil(H / px);
    rt?.destroy(); bt?.destroy(); lt?.destroy(); bt = lt = null;
    const u = T.RENDER_ATTACHMENT | T.TEXTURE_BINDING;
    rt = dev.createTexture({ size: [iw, ih], format: hq ? 'rgba16float' : 'rgba8unorm', usage: u });
    sg = bgr(hq ? hqP().scene : scene, [{ buffer: ub }, vox.createView(), hm.createView(), { buffer: tb }]);
    if (hq) {
      bt = dev.createTexture({ size: [Math.ceil(iw / 4), Math.ceil(ih / 4)], format: 'rgba16float', usage: u });
      lt = dev.createTexture({ size: [iw, ih], format: 'rgba8unorm', usage: u });
      bgB = bgr(Q.bloom, [rt.createView()]); bgO = bgr(Q.out, [rt.createView(), bt.createView(), Q.sm]);
    }
    bg = bgr(blit, [(lt || rt).createView(), { buffer: bb }]);
    dev.queue.writeBuffer(bb, 0, new Float32Array([px, cross, 0, 0]));
  };
  addEventListener('resize', resize); resize();

  // ---------- camera + views ----------
  // views cycle: chase -> first person -> top-down
  const VIEWS = [
    { name: 'chase', pitch: 0.62, tan: 0.27, dist: 30, fog: 1, lo: 0.3, hi: 1.45 },
    { name: 'first person', pitch: 0.08, tan: 0.62, dist: 0, fog: 1, lo: -1.45, hi: 1.45, fps: 1 },
    { name: 'top-down', pitch: 1.2, tan: 0.13, dist: 105, fog: 0, lo: 0.3, hi: 1.45 }];
  let view = (+qs.get('v') || 0) % 3, yaw = Math.PI / 2 + (+qs.get('r') || 0), pitch = VIEWS[view].pitch, zoom = +qs.get('z') || 1, cz = 0, mode = 'kb', run = false;
  const cam = { o: [0, 0, 0], F: [1, 0, 0], R: [0, 1, 0], Up: [0, 0, 1], tan: 0.3 };
  const keys = new Set();

  // ---------- hotbar + block editing ----------
  const BLOCKS = [[1, 'grass', '#6ab234'], [2, 'dirt', '#8a5a34'], [4, 'stone', '#959e9e'], [3, 'sand', '#d6c983'], [5, 'birch', '#ebe7dc'], [6, 'leaves', '#86b83a'], [7, 'planks', '#b8915a'], [8, 'torch', '#f0a030']];
  let slot = 0, placeMode = false;
  const hb = $('#hb');
  hb.innerHTML = BLOCKS.map(([, n, c], i) => `<i data-s="${i}" title="${n}" style="background:${c}">${i + 1}</i>`).join('');
  const setSlot = (i) => { slot = (i + BLOCKS.length) % BLOCKS.length; [...hb.children].forEach((e, j) => e.classList.toggle('on', j === slot)); };
  setSlot(0);
  hb.addEventListener('pointerdown', (e) => { const s = e.target.dataset.s; if (s != null) { setSlot(+s); e.preventDefault(); e.stopPropagation(); } });
  const REACH = 6, P = new Int32Array(mem(), X.pick_ptr(), 6), st = new Float32Array(mem(), X.state_ptr(), 16);
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  // ray from the camera through a screen point (client px); null = crosshair/centre
  const screenRay = (cx, cy) => {
    const ax = iw / ih, ux = cx == null ? 0 : (cx / innerWidth) * 2 - 1, uy = cy == null ? 0 : (cy / innerHeight) * 2 - 1;
    const nx = ux * ax * cam.tan, ny = -uy * cam.tan;
    return norm([0, 1, 2].map((k) => cam.F[k] + cam.R[k] * nx + cam.Up[k] * ny));
  };
  // targeting: returns {b:[x,y,z], n:[nx,ny,nz]} within reach of the player, or null
  const target = (how, cx, cy) => {
    let o, d, md;
    if (how === 'front') { o = [st[0], st[1], st[2] + 1.4]; d = norm([st[4], st[5], -0.75]); md = 4.5; }
    else { o = cam.o; d = screenRay(cx, cy); md = VIEWS[view].fps ? REACH : 400; }
    if (!X.pick(o[0], o[1], o[2], d[0], d[1], d[2], md)) return null;
    const b = [P[0], P[1], P[2]], n = [P[3], P[4], P[5]];
    if (Math.hypot(b[0] + 0.5 - st[0], b[1] + 0.5 - st[1], b[2] + 0.5 - st[2] - 1.4) > REACH) return null;
    return { b, n };
  };
  // break particles (simulated here, drawn as tiny analytic cubes in the shader)
  const parts = []; let partId = 1;
  const act = (t, place) => {
    if (!t) return;
    const [x, y, z] = t.b;
    if (place) {
      const id = BLOCKS[slot][0], q = [x + t.n[0], y + t.n[1], z + t.n[2]];
      if (X.place_block(q[0], q[1], q[2], id)) touch1(q[0], q[1], q[2], id);
    } else {
      const old = X.break_block(x, y, z);
      if (!old) return;
      touch1(x, y, z, 0); partId = old; parts.length = 0;
      for (let i = 0; i < 8; i++) parts.push({ p: [x + 0.5, y + 0.5, z + 0.5], v: [(Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, Math.random() * 5 + 2], life: 0.55 + Math.random() * 0.25 });
    }
  };
  let aim = 'pointer', ptr = null, hl = null;

  // ---------- hints ----------
  const HINTS = {
    kb: (f) => f ? 'WASD move \u00b7 click: lock mouse \u00b7 LMB break \u00b7 RMB place \u00b7 1-8/wheel block \u00b7 space jump \u00b7 V view \u00b7 G settings'
      : 'WASD move \u00b7 drag: look \u00b7 click break \u00b7 right-click place \u00b7 X/C break/place ahead \u00b7 1-8 block \u00b7 wheel zoom \u00b7 V view \u00b7 G settings',
    pad: (f) => `L-stick move \u00b7 R-stick look \u00b7 RT break \u00b7 LT place \u00b7 D-pad \u2190\u2192 block${f ? '' : ' \u00b7 LB/RB zoom'} \u00b7 A jump \u00b7 Y view \u00b7 \u2630 settings`,
    touch: (f) => f ? 'stick move \u00b7 drag look \u00b7 tap / \u25cf: ' + (placeMode ? 'place' : 'break') + ' \u00b7 hold: place \u00b7 VIEW' : 'stick move \u00b7 drag look \u00b7 tap block: ' + (placeMode ? 'place' : 'break') + ' \u00b7 hold: place \u00b7 pinch zoom',
  };
  const setHint = () => {
    hint.textContent = `[${VIEWS[view].name}] ` + HINTS[mode](VIEWS[view].fps);
    $('#a').style.display = VIEWS[view].fps ? 'flex' : 'none'; $('#m').textContent = placeMode ? 'PLACE' : 'BREAK';
  };
  const setMode = (m) => { if (m === mode) return; mode = m; setHint(); $('#t').style.display = m === 'touch' ? 'block' : 'none'; };
  setHint();
  const toggleView = () => {
    view = (view + 1) % 3; pitch = VIEWS[view].pitch; setHint();
    if (!VIEWS[view].fps && document.pointerLockElement) document.exitPointerLock();
  };

  // ---------- settings panel: Grafik Standard/HQ, Tid (HQ sun) ----------
  const panel = $('#s'); let row = 0, aSel = 0;
  const opened = () => panel.classList.contains('on');
  const syncPanel = () => {
    panel.querySelectorAll('i').forEach((e) => e.classList.toggle('on', e.dataset.v === String(e.dataset.k === 'fx' ? +hq : tod)));
    panel.querySelectorAll('p').forEach((e, i) => e.classList.toggle('f', i === row));
    panel.querySelectorAll('[data-a]').forEach((e, i) => e.classList.toggle('on', row === 2 && i === aSel));
  };
  const ACT = { exp: exportWorld, imp: () => fileIn.click(), shr: shareLink };
  const runAct = () => ACT[panel.querySelectorAll('[data-a]')[aSel].dataset.a]();
  const setOpt = (k, v) => {
    if (k === 'fx') { if (hq !== (v === '1')) { hq = v === '1'; localStorage.setItem('m7c-fx', +hq); AREA = hq ? 70000 : 115000; slow = 0; resize(); } }
    else { tod = v; localStorage.setItem('m7c-tod', v); }
    syncPanel();
  };
  const togglePanel = () => { if (panel.classList.toggle('on') && document.pointerLockElement) document.exitPointerLock(); syncPanel(); };
  const stepOpt = (dir) => {
    if (row === 2) { aSel = (aSel + dir + 3) % 3; return syncPanel(); }
    const o = [...panel.querySelectorAll('p')[row].querySelectorAll('i')], i = o.findIndex((e) => e.classList.contains('on')), e = o[(i + dir + o.length) % o.length]; setOpt(e.dataset.k, e.dataset.v);
  };
  const moveRow = (dir) => { row = (row + dir + 3) % 3; syncPanel(); };
  const enter = () => (row === 2 ? runAct() : stepOpt(1));
  panel.addEventListener('click', (e) => { const d = e.target.dataset; if (d.k) { row = d.k === 'fx' ? 0 : 1; setOpt(d.k, d.v); } if (d.a) { row = 2; aSel = Object.keys(ACT).indexOf(d.a); syncPanel(); ACT[d.a](); } });
  $('#g').addEventListener('click', togglePanel);
  for (const el of [panel, $('#g')]) el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  syncPanel();

  // ---------- keyboard + mouse ----------
  let jumpQ = false;
  addEventListener('keydown', (e) => {
    setMode('kb');
    if (e.code === 'KeyG' && !e.repeat) return togglePanel();
    if (opened()) {
      const m = { ArrowUp: () => moveRow(-1), ArrowDown: () => moveRow(1), ArrowLeft: () => stepOpt(-1), ArrowRight: () => stepOpt(1), Enter: enter, Escape: togglePanel }[e.code];
      if (m) { m(); e.preventDefault(); return; }
    }
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'KeyV') toggleView();
    if (e.code === 'Space') { jumpQ = true; e.preventDefault(); }
    if (e.code >= 'Digit1' && e.code <= 'Digit8') setSlot(+e.code.slice(5) - 1);
    if (e.code === 'KeyX' || e.code === 'KeyC') act(VIEWS[view].fps ? target('center') : target('front'), e.code === 'KeyC');
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  const look = (dx, dy) => { yaw -= dx; pitch = Math.min(VIEWS[view].hi, Math.max(VIEWS[view].lo, pitch + dy)); };
  const locked = () => document.pointerLockElement === cv;
  let down = null;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    setMode('kb');
    if (VIEWS[view].fps) {
      if (!locked()) cv.requestPointerLock?.();
      else act(target('center'), e.button === 2);
    } else down = { x: e.clientX, y: e.clientY, b: e.button, drag: false };
  });
  addEventListener('mouseup', (e) => {
    if (down && !down.drag && !locked()) act(target('pointer', e.clientX, e.clientY), down.b === 2);
    down = null;
  });
  addEventListener('mousemove', (e) => {
    if (locked()) { look(e.movementX * 0.004, e.movementY * 0.003); aim = 'center'; return; }
    ptr = [e.clientX, e.clientY]; aim = 'pointer';
    if (down && (down.drag || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5)) { down.drag = true; look(e.movementX * 0.004, e.movementY * 0.003); }
  });
  addEventListener('wheel', (e) => {
    if (VIEWS[view].fps) setSlot(slot + Math.sign(e.deltaY));
    else zoom = Math.min(2.6, Math.max(0.45, zoom * Math.exp(e.deltaY * 0.001)));
    e.preventDefault();
  }, { passive: false });

  // ---------- touch ----------
  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, looks = new Map(); let pinch = 0;
  const knob = $('#k'), base = $('#b');
  const tapAct = (x, y, place) => act(VIEWS[view].fps ? target('center') : target('pointer', x, y), place);
  const tstart = (e) => {
    setMode('touch');
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45 && stick.id === null) {
        Object.assign(stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
        base.style.cssText = `display:block;left:${t.clientX}px;top:${t.clientY}px`; knob.style.transform = '';
      } else {
        const L = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t: performance.now(), moved: false, done: false };
        // long-press = place
        L.timer = setTimeout(() => { if (!L.moved && looks.size === 1) { L.done = true; tapAct(L.sx, L.sy, true); } }, 450);
        looks.set(t.identifier, L);
      }
    }
    e.preventDefault();
  };
  const tmove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        let dx = t.clientX - stick.ox, dy = t.clientY - stick.oy; const l = Math.hypot(dx, dy), R = 50;
        if (l > R) { dx *= R / l; dy *= R / l; }
        stick.x = dx / R; stick.y = -dy / R; knob.style.transform = `translate(${dx}px,${dy}px)`;
      } else if (looks.has(t.identifier)) {
        const p = looks.get(t.identifier);
        if (Math.hypot(t.clientX - p.sx, t.clientY - p.sy) > 10) p.moved = true;
        if (looks.size === 1 && p.moved) look((t.clientX - p.x) * 0.008, (t.clientY - p.y) * 0.006);
        p.x = t.clientX; p.y = t.clientY;
      }
    }
    if (looks.size === 2) {
      const [a, b] = [...looks.values()]; a.moved = b.moved = true; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && !VIEWS[view].fps) zoom = Math.min(2.6, Math.max(0.45, zoom * pinch / d)); pinch = d;
    } else pinch = 0;
    e.preventDefault();
  };
  const tend = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) { stick.id = null; stick.x = stick.y = 0; base.style.display = 'none'; }
      const L = looks.get(t.identifier);
      if (L) { clearTimeout(L.timer); if (!L.moved && !L.done && performance.now() - L.t < 450) tapAct(L.sx, L.sy, placeMode); }
      looks.delete(t.identifier);
    }
    pinch = 0;
  };
  cv.addEventListener('touchstart', tstart, { passive: false });
  addEventListener('touchmove', tmove, { passive: false });
  addEventListener('touchend', tend); addEventListener('touchcancel', tend);
  const btn = (id, f) => $(id).addEventListener('touchstart', (e) => { f(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
  btn('#j', () => (jumpQ = true)); btn('#v', toggleView);
  btn('#m', () => { placeMode = !placeMode; setHint(); });
  btn('#a', () => act(target('center'), placeMode));
  if (matchMedia('(pointer: coarse)').matches) setMode('touch');
  const prevBtn = []; let trig = [0, 0];
  const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);

  // ---------- frame ----------
  const U = new Float32Array(80), TLB = new Float32Array(128);
  let last = performance.now(), acc = 0, frames = 0, slow = 0;
  // debug: ?p=x,y teleport, ?t=seconds time offset, ?pt=pitch
  if (qs.get('p')) { const [x, y] = qs.get('p').split(',').map(Number); const hm8 = new Uint8Array(mem(), X.height_ptr(), N * N); st[0] = x + 0.5; st[1] = y + 0.5; st[2] = hm8[y * N + x] + 2; }
  if (qs.get('pt')) pitch = +qs.get('pt');
  const t0 = +qs.get('t') || 0;
  // HQ sun: 'day' = the classic fixed sun; 'eve' = golden hour; 'cyc' = 4 min day/night; ?tod=hours
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const sun = (time) => {
    const h = tod === 'day' ? 14 : tod === 'eve' ? 17.4 : tod === 'cyc' ? (14 + time / 10) % 24 : tod;
    const a = (h - 6) / 12 * Math.PI, el = Math.asin(0.866 * Math.sin(a)), az = 2.44 + (h - 14) * 0.26;
    let d = tod === 'day' ? [-0.5, 0.42, 0.757] : [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
    const z = d[2], k = sm(-0.02, 0.45, z), n = z < -0.06;
    const mx = (p, q, t) => p.map((x, i) => x + (q[i] - x) * t);
    if (n) d = d.map((x) => -x);   // night: the moon, opposite the sun
    const c = n ? [0.12, 0.16, 0.3] : mx([1.0, 0.36, 0.1], [1.5, 1.44, 1.32], k).map((x) => x * sm(-0.06, 0.06, z));
    const sky = n ? [0.015, 0.025, 0.06] : mx([0.1, 0.1, 0.16], [0.17, 0.23, 0.33], k).map((x) => x * (0.25 + 0.75 * sm(-0.1, 0.2, z)));
    return [d, c, sky, n ? 0.06 : 0.12 + 0.88 * sm(-0.05, 0.3, z)];
  };
  cz = st[2];
  const pass = (enc, v, pl, g) => { const p = enc.beginRenderPass({ colorAttachments: [{ view: v.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }); p.setPipeline(pl); p.setBindGroup(0, g); p.draw(3); p.end(); };
  const draw = () => {
    const enc = dev.createCommandEncoder();
    pass(enc, rt, hq ? Q.scene : scene, sg);
    if (hq) { pass(enc, bt, Q.bloom, bgB); pass(enc, lt, Q.out, bgO); }
    pass(enc, ctx.getCurrentTexture(), blit, bg);
    dev.queue.submit([enc.finish()]);
  };
  // test hook: mean GPU frame time (ms) over n frames, each awaited to completion
  const bench = async (n) => { await dev.queue.onSubmittedWorkDone(); const t = Date.now(); for (let i = 0; i < n; i++) { draw(); await dev.queue.onSubmittedWorkDone(); } return { ms: (Date.now() - t) / n, iw, ih, hq }; };
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    let mx = 0, my = 0, jump = jumpQ; jumpQ = false;
    run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    mx += (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    my += (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    if (keys.has('KeyQ')) yaw += 2.2 * dt; if (keys.has('KeyE')) yaw -= 2.2 * dt;
    if (keys.has('KeyR')) look(0, -1.2 * dt); if (keys.has('KeyF')) look(0, 1.2 * dt);
    if (keys.has('Equal') || keys.has('NumpadAdd')) zoom = Math.max(0.45, zoom * (1 - dt)); if (keys.has('Minus') || keys.has('NumpadSubtract')) zoom = Math.min(2.6, zoom * (1 + dt));
    for (const g of navigator.getGamepads?.() || []) {
      if (!g || !g.connected) continue;
      const a = g.axes, b = (i) => g.buttons[i]?.pressed, v = (i) => g.buttons[i]?.value || 0;
      const lx = dz(a[0] || 0), ly = dz(a[1] || 0), rx = dz(a[2] || 0), ry = dz(a[3] || 0);
      if (lx || ly || rx || ry || g.buttons.some((x) => x.pressed)) { setMode('pad'); aim = VIEWS[view].fps ? 'center' : 'front'; }
      mx += lx; my -= ly; look(rx * 2.6 * dt, ry * 1.6 * dt);
      if (b(0) && !prevBtn[0]) { if (opened()) enter(); else jump = true; }
      if (b(3) && !prevBtn[3]) toggleView();
      if ((b(1) && !opened()) || b(10)) run = true;
      // LB/RB zoom, D-pad left/right hotbar, RT break / LT place (auto-repeat while held)
      zoom = Math.min(2.6, Math.max(0.45, zoom * (1 + ((b(4) ? 1 : 0) - (b(5) ? 1 : 0)) * dt * 1.5)));
      const pr = (i) => b(i) && !prevBtn[i];
      if (pr(9)) togglePanel();   // Start/Menu: settings; while open the D-pad edits it, B closes
      if (opened()) { if (pr(12)) moveRow(-1); if (pr(13)) moveRow(1); if (pr(14)) stepOpt(-1); if (pr(15)) stepOpt(1); if (pr(1)) togglePanel(); }
      else { if (pr(14)) setSlot(slot - 1); if (pr(15)) setSlot(slot + 1); }
      for (const [k, bi, pl] of [[0, 7, false], [1, 6, true]]) {
        if (v(bi) > 0.5) { if ((trig[k] -= dt) <= 0) { act(target(VIEWS[view].fps ? 'center' : 'front'), pl); trig[k] = 0.25; } } else trig[k] = 0;
      }
      for (let i = 0; i < 16; i++) prevBtn[i] = b(i);
      break;
    }
    mx += stick.x; my += stick.y;
    if (Math.hypot(stick.x, stick.y) > 0.95) run = true;
    if (mx || my) { if (mode === 'kb' && !ptr) aim = 'front'; }
    X.step(dt, mx, my, yaw, (jump ? 1 : 0) | (run ? 2 : 0));
    cz += (st[2] - cz) * Math.min(1, dt * 10);
    // camera orbiting the player (Mode 7 style); first person = eye height, dist 0
    const V = VIEWS[view], dist = V.dist * zoom;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), fx = Math.cos(yaw), fy = Math.sin(yaw);
    const F = [fx * cp, fy * cp, -sp], R = [fy, -fx, 0], Up = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
    const tx = st[0], ty = st[1], tz = cz + (V.fps ? 1.55 : 0.9);
    const tanV = V.tan * Math.max(1, (ih / iw) * (V.fps ? 0.6 : 0.8));
    const far = V.fps ? 64 : V.fog ? dist * 3.2 : dist * 6;
    Object.assign(cam, { o: [tx - F[0] * dist, ty - F[1] * dist, tz - F[2] * dist], F, R, Up, tan: tanV });
    // highlight target: crosshair in FPS, pointer (mouse) or block in front (pad/keys/touch) elsewhere
    hl = V.fps ? target('center') : aim === 'pointer' && ptr && mode === 'kb' ? target('pointer', ptr[0], ptr[1]) : mode === 'touch' ? null : target('front');
    // particles
    for (const q of parts) { q.life -= dt; q.v[2] -= 18 * dt; for (let k = 0; k < 3; k++) q.p[k] += q.v[k] * dt; }
    while (parts.length && parts[parts.length - 1].life <= 0) parts.pop();
    U.fill(0);
    U.set([iw, ih, now / 1000 + t0, tanV, ...cam.o, V.fog, ...F, far, ...R, iw / ih, ...Up, 0, st[0], st[1], st[2], 0, st[4], st[5], st[6], st[7], V.fps ? 1 : 0, 0, 0, 0]);
    if (hl) U.set([...hl.b, 1], 32);
    if (hq) { const [d, c, sky, w] = sun(now / 1000 + t0); U.set(sky, 29); U.set([...d, 0, ...c, w], 72); }
    // torch lights: re-pick the nearest 32 every ~0.3 s (or after an edit), flicker per frame
    if ((lightsT -= dt) <= 0 || !dt) {
      lightsT = 0.3; lights = [];
      for (const [i, id] of edits) if (id === 8) lights.push([i % N + 0.5, (i / N | 0) % N + 0.5, (i / (N * N) | 0) + 0.72]);
      lights.sort((a, b) => Math.hypot(a[0] - st[0], a[1] - st[1]) - Math.hypot(b[0] - st[0], b[1] - st[1])).length = Math.min(lights.length, 32);
    }
    const tf = now / 1000 + t0;
    U[38] = lights.length; lights.forEach((l, i) => TLB.set([...l, 0.85 + 0.15 * Math.sin(tf * 13 + i * 1.7) * Math.sin(tf * 7.3 + i)], i * 4));
    if (lights.length) dev.queue.writeBuffer(tb, 0, TLB, 0, lights.length * 4);
    if (parts.length) { U.set([partId, 1], 36); parts.forEach((q, i) => U.set([...q.p, q.life > 0 ? 0.07 + 0.08 * Math.min(1, q.life * 2) : 0], 40 + i * 4)); }
    if ((V.fps | 0) !== cross) { cross = V.fps | 0; dev.queue.writeBuffer(bb, 0, new Float32Array([px, cross, 0, 0])); }
    dev.queue.writeBuffer(ub, 0, U);
    draw();
    // adaptive resolution: drop internal pixels if we can't hold ~45fps
    acc += dt; frames++;
    if (acc > 1) { if (acc / frames > 0.022 && AREA > (hq ? 25000 : 45000)) { if (++slow >= 2) { AREA *= 0.75; resize(); slow = 0; } } else slow = 0; acc = 0; frames = 0; }
    requestAnimationFrame(frame);
  };
  window.m7 = { act, target, setSlot, X, edits, save, pack, unpack, b64, importBytes, shareLink, exportWorld, loadWorld, bench, setOpt, togglePanel, get view() { return view; } }; // handy for tests
  // shared world link (#w=...): load it, then drop the hash so later local edits stay local
  const hw = location.hash.match(/^#w=([\w-]+)/);
  if (hw) { history.replaceState(null, '', location.pathname + location.search); try { await importBytes(unb64(hw[1])); } catch { toast('Ogiltig l\u00e4nk'); } }
  $('#l').remove();
  requestAnimationFrame(frame);
})().catch((e) => fail('Failed to start: ' + e.message));
