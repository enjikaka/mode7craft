// Mode7craft front-end: WebGPU renderer + input. World + game logic live in g.wasm.
const $ = (s) => document.querySelector(s);
const cv = $('#c'), hint = $('#h');
const fail = (m) => { if ($('#e').style.display === 'flex') return; $('#e').textContent = m; $('#e').style.display = 'flex'; };
// visible (non-fatal) GPU/JS error strip, so a problem never hides behind a silent black canvas
const warn = (m) => {
  let b = $('#w'); if (!b) { b = document.createElement('div'); b.id = 'w'; b.style.cssText = 'position:fixed;left:8px;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:8;background:rgba(110,16,16,.88);color:#fff;font:700 11px/1.4 ui-monospace,Menlo,monospace;padding:6px 10px;white-space:pre-wrap;word-break:break-word;pointer-events:none'; document.body.append(b); }
  m = String(m).split('\n')[0].slice(0, 200); const L = b.textContent ? b.textContent.split('\n') : [];
  if (!L.includes(m)) b.textContent = [...L, m].slice(-4).join('\n');
  clearTimeout(warn.t); warn.t = setTimeout(() => b.remove(), 20000);
};
addEventListener('error', (e) => warn('JS: ' + e.message));
addEventListener('unhandledrejection', (e) => warn('JS: ' + (e.reason?.message ?? e.reason)));
const wasmP = WebAssembly.instantiateStreaming(fetch('g.wasm'), { env: { msin: Math.sin, mcos: Math.cos, msqrt: Math.sqrt } });
(async () => {
  if (!navigator.gpu) return fail('WebGPU is not available in this browser. Try Chrome/Edge 113+, Safari 26+ (iOS 26), or enable WebGPU in your browser flags.');
  const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!ad) return fail('WebGPU is supported but no GPU adapter was found.');
  const dev = await ad.requestDevice();
  dev.addEventListener('uncapturederror', (e) => { console.error(e.error.message); warn('GPU: ' + e.error.message); });
  dev.lost.then((i) => fail('GPU device lost (' + i.reason + '): ' + i.message + ' \u2013 ladda om sidan.'));
  // adapters that cannot use storage buffers in the fragment stage (WebGPU compat-style limits): HQ needs them
  // there (sun-shadow cache). Undefined (e.g. Safari) = core = fine.
  const noFS = dev.limits.maxStorageBuffersInFragmentStage === 0;
  const { instance } = await wasmP; const X = instance.exports;
  const mem = () => X.memory.buffer; let migrated = 0;
  const N = 256, NZ = 16, ON = 128;   // v11: 256x256 island (ON = pre-v11 size)
  const qs = new URLSearchParams(location.search);
  // ?legacy: the pre-v11 128 island in the world corner (same coordinates as v10, for diffing)
  const genW = () => X.gen(1337, qs.has('legacy') ? ON : N);
  genW();
  // ---------- saved edits (localStorage diff: base36 index + block id) ----------
  const KEY = 'm7c-edits-2', KEY1 = 'm7c-edits-1', edits = new Map();
  if (qs.has('reset')) { localStorage.removeItem(KEY); localStorage.removeItem(KEY1); }
  const parseEd = (str) => { const m = new Map(); for (const e of (str || '').split(',')) if (e) m.set(parseInt(e.slice(0, -1), 36), +e.slice(-1)); return m; };
  // old 128x128 saves: rebuild the old island + edits, cut out the edited area (+4 blocks of terrain
  // around it) and paste it into the centre of the new island; returns the edits for the new world
  const migrate = (old) => {
    const out = new Map(); if (!old.size) return out;
    X.gen(1337, ON); let x0 = ON, y0 = ON, x1 = -1, y1 = -1;
    for (const [i, id] of old) { const x = i % ON, y = (i / ON | 0) % ON; X.set_block(x, y, i / (ON * ON) | 0, id); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    x0 = Math.max(0, x0 - 4); y0 = Math.max(0, y0 - 4); x1 = Math.min(ON - 1, x1 + 4); y1 = Math.min(ON - 1, y1 + 4);
    const w = new Uint8Array(mem(), X.world_ptr(), N * N * NZ), patch = [];
    for (let z = 0; z < NZ; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) patch.push([x + (N - ON) / 2, y + (N - ON) / 2, z, w[(z * N + y) * N + x]]);
    X.gen(1337, N); const w2 = new Uint8Array(mem(), X.world_ptr(), N * N * NZ);
    for (const [x, y, z, id] of patch) { const i = (z * N + y) * N + x; if (w2[i] !== id) out.set(i, id); }
    return out;
  };
  let saved = parseEd(localStorage.getItem(KEY));
  if (!qs.has('legacy') && !localStorage.getItem(KEY) && localStorage.getItem(KEY1)) { saved = migrate(parseEd(localStorage.getItem(KEY1))); genW(); migrated = saved.size; }
  if (qs.has('legacy')) saved.clear();
  for (const [i, id] of saved) { edits.set(i, id); X.set_block(i % N, (i / N | 0) % N, i / (N * N) | 0, id); }
  let saveT = 0;
  // noSave: while visiting someone else's world (multiplayer guest) nothing is written over your own save
  let noSave = false, netEd = () => {};
  const saveNow = () => { clearTimeout(saveT); if (!noSave) try { localStorage.setItem(KEY, [...edits].map(([i, id]) => i.toString(36) + id).join(',')); } catch {} };
  const save = () => { clearTimeout(saveT); saveT = setTimeout(saveNow, 400); };
  if (migrated) save();   // the migrated edits go to the new key right away (the old key stays as a backup)

  // exact GPU memory bookkeeping (m7.gpuMem()): every texture/buffer we create, minus destroyed ones
  const gmem = new Map(), BPP = { r8uint: 1, r16uint: 2, rgba8unorm: 4, bgra8unorm: 4, rgba16float: 8, depth32float: 4 };
  for (const [f, sz] of [['createTexture', (d) => d.size[0] * (d.size[1] || 1) * (d.size[2] || 1) * BPP[d.format]], ['createBuffer', (d) => d.size]]) {
    const o = dev[f].bind(dev); dev[f] = (d) => { const r = o(d), od = r.destroy.bind(r); gmem.set(r, [d.label || d.format || 'buffer', sz(d)]); r.destroy = () => { gmem.delete(r); od(); }; return r; };
  }
  const ctx = cv.getContext('webgpu'), fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque' });
  const T = GPUTextureUsage;
  // GPU world data (v11, packed): vox = 4 bits per voxel (2 per r8 texel along x), hm = r16 per column
  // (terrain height | top-of-anything height << 5 | top block id << 10, for water and the far heightmap
  // march), occ = 1 byte per 4x4x4 brick (any visible block) for empty-space skipping in the DDA
  const vox = dev.createTexture({ label: 'vox', size: [N / 2, N, NZ], dimension: '3d', format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const hm = dev.createTexture({ label: 'hm', size: [N, N], format: 'r16uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const occT = dev.createTexture({ label: 'occ', size: [N / 4, N / 4, NZ / 4], dimension: '3d', format: 'r8uint', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const W8 = () => new Uint8Array(mem(), X.world_ptr(), N * N * NZ), H8 = () => new Uint8Array(mem(), X.height_ptr(), N * N);
  const hmCol = (w, h, x, y) => { let z = NZ - 1; for (; z >= 0; z--) { const b = w[(z * N + y) * N + x]; if (b && b !== 8) break; } return h[y * N + x] | (z + 1) << 5 | (z >= 0 ? w[(z * N + y) * N + x] : 0) << 10; };
  const NOOCC = qs.get('occ') === '0';   // debug: ?occ=0 marks every brick occupied (no empty-space skipping)
  const brick = (w, bx, by, bz) => { if (NOOCC) return 1; for (let z = bz * 4; z < bz * 4 + 4; z++) for (let y = by * 4; y < by * 4 + 4; y++) for (let x = bx * 4; x < bx * 4 + 4; x++) { const b = w[(z * N + y) * N + x]; if (b && b !== 8) return 1; } return 0; };
  const uploadWorld = () => {
    const w = W8(), h = H8(), v = new Uint8Array(N * N * NZ / 2), m = new Uint16Array(N * N), o = new Uint8Array(N * N * NZ / 64);
    for (let i = 0; i < v.length; i++) v[i] = w[2 * i] | w[2 * i + 1] << 4;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m[y * N + x] = hmCol(w, h, x, y);
    for (let z = 0; z < NZ / 4; z++) for (let y = 0; y < N / 4; y++) for (let x = 0; x < N / 4; x++) o[(z * N / 4 + y) * N / 4 + x] = brick(w, x, y, z);
    dev.queue.writeTexture({ texture: vox }, v, { bytesPerRow: N / 2, rowsPerImage: N }, [N / 2, N, NZ]);
    dev.queue.writeTexture({ texture: hm }, m, { bytesPerRow: N * 2 }, [N, N]);
    dev.queue.writeTexture({ texture: occT }, o, { bytesPerRow: N / 4, rowsPerImage: N / 4 }, [N / 4, N / 4, NZ / 4]);
  };
  uploadWorld();
  // partial upload: only the touched voxel pair, its column and its brick
  const touch1 = (x, y, z, id, remote) => {
    if (!remote) netEd(x, y, z, id);   // multiplayer: own edits go to the host (or, as host, to every guest)
    const w = W8(), i = (z * N + y) * N + (x & ~1);
    dev.queue.writeTexture({ texture: vox, origin: [x >> 1, y, z] }, new Uint8Array([w[i] | w[i + 1] << 4]), {}, [1, 1, 1]);
    dev.queue.writeTexture({ texture: hm, origin: [x, y] }, new Uint16Array([hmCol(w, H8(), x, y)]), {}, [1, 1]);
    dev.queue.writeTexture({ texture: occT, origin: [x >> 2, y >> 2, z >> 2] }, new Uint8Array([brick(w, x >> 2, y >> 2, z >> 2)]), {}, [1, 1, 1]);
    edits.set((z * N + y) * N + x, id); save(); lightsT = 0; bakeDirty = true;
  };
  // ---------- world files: 'M7C' + version 1 + flags (1 = deflate-raw) + 3 bytes per edit:
  // (index delta << 4 | id), indices sorted. Same bytes go base64url into share links (#w=...).
  const MAXI = N * N * NZ;
  const zip = async (b, un) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new (un ? DecompressionStream : CompressionStream)('deflate-raw'))).arrayBuffer());
  const pack = async () => {
    const e = [...edits].sort((a, b) => a[0] - b[0]); let r = new Uint8Array(e.length * 3), prev = 0;
    e.forEach(([i, id], k) => { const v = (i - prev) << 4 | id; prev = i; r.set([v >> 16, v >> 8 & 255, v & 255], k * 3); });
    const z = typeof CompressionStream == 'function'; if (z) r = await zip(r);
    const o = new Uint8Array(r.length + 5); o.set([77, 55, 67, 2, +z]); o.set(r, 5); return o;
  };
  const unpack = async (b) => {
    if (b.length < 5 || b[0] != 77 || b[1] != 55 || b[2] != 67 || b[3] < 1 || b[3] > 2 || b[4] > 1) throw 0;
    const v1 = b[3] === 1, mx = v1 ? ON * ON * NZ : MAXI;   // v1 = 128x128 world: migrated into the new island
    let r = b.subarray(5); if (b[4]) r = await zip(r, 1);
    if (r.length % 3) throw 0;
    const m = new Map(); let i = 0;
    for (let k = 0; k < r.length; k += 3) { const v = r[k] << 16 | r[k + 1] << 8 | r[k + 2], id = v & 15; i += v >> 4; if (i >= mx || id > 8) throw 0; m.set(i, id); }
    if (v1) { const r2 = migrate(m); genW(); for (const [i, id] of edits) X.set_block(i % N, (i / N | 0) % N, i / (N * N) | 0, id); return r2; }
    return m;
  };
  const b64 = (b) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  // replace the world: fresh island + imported edits, full re-upload
  const loadWorld = (m) => {
    genW(); edits.clear(); parts.length = 0;
    for (const [i, id] of m) { edits.set(i, id); X.set_block(i % N, (i / N | 0) % N, i / (N * N) | 0, id); }
    uploadWorld();
    save(); lightsT = 0; cz = st[2]; bakeDirty = true;
  };
  const ask = (m) => !edits.size || confirm(`Ers\u00e4tt din v\u00e4rld med den importerade (${m.size} \u00e4ndringar)?`);
  const toast = (m) => { hint.textContent = m; clearTimeout(toast.t); toast.t = setTimeout(setHint, 3500); };
  if (migrated) setTimeout(() => toast('Gammal v\u00e4rld flyttad till mitten av nya \u00f6n'), 600);
  const importBytes = async (b) => { if (net.mp === 'guest') { toast('Du \u00e4r g\u00e4st i n\u00e5gon annans v\u00e4rld'); return 0; } let m; try { m = await unpack(b); } catch { toast('Ogiltig v\u00e4rldsfil'); return 0; } if (!ask(m)) return 0; loadWorld(m); for (const p of net.peers.values()) sendWorld(p); toast(`V\u00e4rld laddad: ${m.size} \u00e4ndringar`); return m.size; };
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
  const ub = dev.createBuffer({ label: 'uniforms', size: 480, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const tb = dev.createBuffer({ label: 'uniforms', size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bb = dev.createBuffer({ label: 'uniforms', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // render distance 'Sikt': far-plane scale, and the HQ sun-shadow cache window (WS x WS columns around the view)
  const FOGS = +qs.get('fogs') || 0.55;
  const SIKT = [{ m: 0.6, ws: 128 }, { m: 1, ws: N }, { m: 2.5, ws: N }];
  const vq = (qs.get('view') || '').toLowerCase();
  let sikt = +({ kort: 0, short: 0, normal: 1, lang: 2, 'l\u00e5ng': 2, long: 2 }[vq] ?? (vq || localStorage.getItem('m7c-view') || 1)) % 3 || 0;
  // HQ sun-shadow cache (2 bits per cell of the window: shadow / lit / unknown -> per-pixel rays); HQ only, Standard binds a stub
  const sc0 = dev.createBuffer({ label: 'shadowcache', size: 16, usage: GPUBufferUsage.STORAGE });
  let scb = null, WS = 0, wx = 0, wy = 0, bakedW = '';
  const scAlloc = () => {
    const ws = hq ? SIKT[sikt].ws : 0; if (ws === WS) return; scb?.destroy(); scb = null; WS = ws; bakedW = ''; if (Q) Q.bg = null;
    if (ws) { scb = dev.createBuffer({ label: 'shadowcache', size: ws * ws * NZ / 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); dev.queue.writeBuffer(scb, 0, new Uint8Array(ws * ws * NZ / 4).fill(0xaa)); }
  };
  let sunD = [0, 0, 1], bakedL = null, bakeDirty = true, bakes = 0;
  // v10.1: no pipeline-overridable `constants` at all. Safari/WebKit before mid-2026 silently drops every draw of a
  // render pipeline that gets a constant one of its entry points does not use (v10 passed them to the vertex stage
  // too, and 'vs' uses none -> black screen on iOS 26). Instead each variant bakes its values into the WGSL source:
  // `override X = d;` becomes `const X = v;` (same value, same code), one shader module per variant.
  const spec = (code, c = {}) => code.replace(/override\s+(\w+)\s*=\s*([^;]+);/g, (_, k, d) => `const ${k}=${k in c ? (/^(true|false)$/.test(d.trim()) ? String(!!c[k]) : c[k]) : d};`);
  const mods = new Map();
  const mod = (code) => {
    if (!mods.has(code)) { const m = dev.createShaderModule({ code }); mods.set(code, m); m.getCompilationInfo?.().then((i) => i.messages.forEach((x) => { console.warn(x.type, x.lineNum, x.message); if (x.type === 'error') warn(`WGSL ${x.lineNum}:${x.linePos} ${x.message}`); })); }
    return mods.get(code);
  };
  // pipeline errors are caught per pipeline (validation + internal scopes); tag says what to switch off if it fails
  let hqOff = noFS, leafOff = false;
  const guard = (tag, mkp) => {
    dev.pushErrorScope('internal'); dev.pushErrorScope('validation');
    const p = mkp(); const chk = (er) => er && fallback(tag, er.message);
    dev.popErrorScope().then(chk); dev.popErrorScope().then(chk); return p;
  };
  const mk = (code, f, e = 'fs', c, ds, v = 'vs', tag = 'base') => guard(tag, () => { const m = mod(spec(code, c)); return dev.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: v }, fragment: { module: m, entryPoint: e, targets: [{ format: f }] }, depthStencil: ds ? { format: 'depth32float', depthWriteEnabled: true, depthCompare: ds } : undefined }); });
  const blit = mk(BLIT_WGSL, fmt), scP = {};
  // scene pipelines per (HQ, porous leaves): LEAF is a baked constant, so 'Block' compiles the exact old code
  const sceneP = (h, l) => scP[+h + 2 * l] ||= h ? mk(SCENE_WGSL, 'rgba16float', 'fs', { HQ: 1, LEAF: l }, 0, 'vs', 'hq') : mk(SCENE_WGSL, 'rgba8unorm', 'fs', { LEAF: l }, 0, 'vs', l ? 'leaf' : 'base');
  let SP;
  // HQ setting: same scene shader with the HQ override on (HDR target) + bloom + tonemap passes.
  // Built and allocated only when HQ is switched on; standard mode never touches any of it.
  const fxq = qs.get('fx'); let hq = !hqOff && (fxq ?? localStorage.getItem('m7c-fx') ?? '1') === '1';
  const tq = qs.get('tod'); let tod = tq != null ? (isNaN(+tq) ? tq : +tq) : localStorage.getItem('m7c-tod') || 'cyc', Q = null, bt, lt, bgB, bgO;
  const hqP = () => Q ||= { bake: guard('hq', () => dev.createComputePipeline({ layout: 'auto', compute: { module: mod(spec(SCENE_WGSL)), entryPoint: 'bake' } })), bloom: mk(HQ_WGSL, 'rgba16float', 'fb', 0, 0, 'vs', 'hq'), out: mk(HQ_WGSL, 'rgba8unorm', 'fo', 0, 0, 'vs', 'hq'), sm: dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }) };
  const bgE = (p, r) => dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: r.map(([binding, resource]) => ({ binding, resource })) });
  const bgr = (p, r) => dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: r.map((resource, binding) => ({ binding, resource })) });
  // edges: 0 Pixel (classic), 1 Mjuka (edge-smoothing upscale), 2 Skarpa (near-native rays, art-size texels),
  // 3 SS+palett (v13: rays at 2x2 per classic pixel, box-filtered and snapped to the palette)
  const eq = qs.get('edge'); let edge = +(eq ?? localStorage.getItem('m7c-edge') ?? 2) % 4 || 0, art = 0;
  // SNES-läge (v13): fixed 256x224 internal, integer-scaled with letterbox, 15-bit colour, 256-colour palette, HDMA fog
  const snq = qs.get('snes'); let snes = (snq ?? localStorage.getItem('m7c-snes') ?? '0') === '1', palOff = false, PQ = null, bgQ, VR = [0, 0, 1, 1];
  const QB = new Float32Array(16), useQ = () => !palOff && (snes || edge === 3);
  // screen rect of the picture in CSS px (letterboxed in SNES-läge)
  const vrect = () => snes ? VR : [0, 0, innerWidth, innerHeight];
  // internal-pixel budget: Skarpa starts at 40% of its cap and dynamic resolution climbs while frames are fast
  const amax = () => edge === 2 ? (hq ? 500000 : 1000000) : (hq ? 70000 : 115000) * (edge === 3 ? 4 : 1);
  const area0 = () => edge === 2 ? amax() * 0.4 : amax();
  let rt, sg, bg, W = 0, H = 0, px = 1, iw = 0, ih = 0, AREA = +qs.get("area") || area0(), cross = 0;
  // ordered 4x4 Bayer dithering to a limited palette in the upscale: 'auto' = HQ only, '1' on, '0' off
  const dq = qs.get('dither'); let dith = dq ?? localStorage.getItem('m7c-dither') ?? '0';
  // leaves: 0 Block (old solid), 1 Löv (porous cutout leaves, the default). v12: the HQ leaf splats are gone;
  // old saved values ('auto', '2' = Löv+splats) mean Löv
  const lq = qs.get('leaf'); let leaf = lq ?? localStorage.getItem('m7c-leaf') ?? '1';
  const leafM = () => leafOff || leaf === '0' ? 0 : 1;
  const bset = () => dev.queue.writeBuffer(bb, 0, new Float32Array([px, cross, art, (edge === 1 ? 1 : 0) + (dith === '1' || (dith === 'auto' && hq) ? 2 : 0)]));
  // v13 palette: 23 block/sky/sunset/skin colours x 11 shades (darker shades shift blue like the game's shadows) + black, grey, white,
  // all cut to 15 bits; the GPU turns it into the 15-bit -> nearest-colour table once, the first time it is needed
  const palette = () => {
    const o = new Float32Array(1024); let i = 0; const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 31) / 31;
    for (const h of [0x8fd24a, 0x66b232, 0x448c27, 0x86b83a, 0xa6d24e, 0x8a5a34, 0xd6c983, 0x959e9e, 0xebe7dc, 0xb8915a, 0x7a5230, 0xff9a2e, 0xffd65c, 0x3fa9c9, 0x2b3a8c, 0x8cb8eb, 0xc2dbf0, 0xe0a878, 0xc8443a, 0x9a52c8, 0xf0a088, 0x2a3a60, 0x9aa8cc])
      for (const b of [0.14, 0.23, 0.33, 0.43, 0.53, 0.63, 0.73, 0.83, 0.93, 1.03, 1.15]) {
        const t = Math.max(0, (0.8 - b) / 0.64);
        [h >> 16, (h >> 8) & 255, h & 255].forEach((c, j) => { o[i * 4 + j] = q(c / 255 * b * (1 - t * [0.24, 0.16, 0][j])); }); i++;
      }
    for (const v of [0, 0.5, 1]) { o.fill(v, i * 4, i * 4 + 3); i++; }
    return o;
  };
  const palP = () => PQ ||= guard('pal', () => {
    const fp = mk(BLIT_WGSL, 'rgba8unorm', 'fp', 0, 0, 'vs', 'pal'), p = mk(BLIT_WGSL, fmt, 'fq', 0, 0, 'vs', 'pal');
    const lut = dev.createTexture({ label: 'palette lut', size: [1024, 32], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
    const pb = dev.createBuffer({ label: 'palette', size: 4096, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); dev.queue.writeBuffer(pb, 0, palette());
    const enc = dev.createCommandEncoder(), r = enc.beginRenderPass({ colorAttachments: [{ view: lut.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    r.setPipeline(fp); r.setBindGroup(0, bgE(fp, [[4, { buffer: pb }]])); r.draw(3); r.end(); dev.queue.submit([enc.finish()]); pb.destroy();
    return { p, lut, qb: dev.createBuffer({ label: 'blit2', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) };
  });
  const resize = () => {
    const d = Math.min(devicePixelRatio || 1, 3);
    W = Math.max(1, Math.round(innerWidth * d)); H = Math.max(1, Math.round(innerHeight * d));
    cv.width = W; cv.height = H;
    px = Math.max(1, Math.round(Math.sqrt(W * H / AREA)));
    // Skarpa: fractional scale (up to native, capped by the pixel budget); art = the classic pixel size in internal pixels
    if (edge === 2) { px = Math.max(1, Math.sqrt(W * H / AREA)); art = Math.max(1, Math.round(Math.sqrt(W * H / (hq ? 70000 : 115000)))) / px; } else art = 0;
    // SS+palett: output pixels from a quarter of the budget, rays at half that size (art = 2 internal px)
    if (edge === 3) { px = Math.max(1, Math.round(Math.sqrt(W * H * 4 / AREA))) / 2; art = 2; }
    iw = Math.ceil(W / px); ih = Math.ceil(H / px);
    if (snes) {
      // SNES-läge: always 256x224, the largest integer scale that fits (fractional only below 1x), centred
      const k = Math.min(W / 256, H / 224); px = k >= 1 ? Math.floor(k) : k; art = 0; iw = 256; ih = 224;
      const ox = Math.floor((W - 256 * px) / 2), oy = Math.floor((H - 224 * px) / 2), cs = innerWidth / W;
      VR = [ox * cs, oy * cs, 256 * px * cs, 224 * px * cs]; QB.set([ox, oy], 0);
    }
    rt?.destroy(); bt?.destroy(); lt?.destroy(); bt = lt = null;
    const u = T.RENDER_ATTACHMENT | T.TEXTURE_BINDING;
    rt = dev.createTexture({ label: 'scene', size: [iw, ih], format: hq ? 'rgba16float' : 'rgba8unorm', usage: u | T.COPY_SRC });   // COPY_SRC: black-frame probe
    if (hq) hqP(); scAlloc(); SP = sceneP(hq, +(leafM() > 0));
    sg = bgE(SP, [[0, { buffer: ub }], [1, vox.createView()], [2, hm.createView()], [3, { buffer: tb }], [4, { buffer: scb || sc0 }], [8, occT.createView()]]);
    if (hq) Q.bg ||= bgE(Q.bake, [[0, { buffer: ub }], [1, vox.createView()], [7, { buffer: scb }]]);
    if (hq) {
      bt = dev.createTexture({ label: 'bloom', size: [Math.ceil(iw / 4), Math.ceil(ih / 4)], format: 'rgba16float', usage: u });
      lt = dev.createTexture({ label: 'tonemap', size: [iw, ih], format: 'rgba8unorm', usage: u });
      bgB = bgr(Q.bloom, [rt.createView()]); bgO = bgr(Q.out, [rt.createView(), bt.createView(), Q.sm]);
    }
    bg = bgr(blit, [(lt || rt).createView(), { buffer: bb }]);
    if (useQ() && palP() && !palOff) bgQ = bgE(PQ.p, [[0, (lt || rt).createView()], [1, { buffer: bb }], [2, PQ.lut.createView()], [3, { buffer: PQ.qb }]]);
    bset();
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
    const v = vrect(), ax = iw / ih, ux = cx == null ? 0 : ((cx - v[0]) / v[2]) * 2 - 1, uy = cy == null ? 0 : ((cy - v[1]) / v[3]) * 2 - 1;
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

  // ---------- settings panel: Grafik Standard/HQ, Tid (HQ sun), Kanter, Värld (actions) ----------
  const panel = $('#s'); let row = 0, aSel = 0;
  const opened = () => panel.classList.contains('on');
  const syncPanel = () => {
    panel.querySelectorAll('i').forEach((e) => e.classList.toggle('on', e.dataset.v === String({ fx: +hq, snes: +snes, tod, edge, dith, sikt, leaf: leafM() }[e.dataset.k])));
    panel.querySelectorAll('p').forEach((e, i) => e.classList.toggle('f', i === row));
    panel.querySelectorAll('[data-a]').forEach((e) => e.classList.toggle('on', acts(row)[aSel] === e));
  };
  const ACT = { exp: exportWorld, imp: () => fileIn.click(), shr: shareLink, inv: () => { togglePanel(); net.invite(); }, nam: () => { togglePanel(); askName('Byt namn'); }, lv: () => net.mp ? net.leave() : toast('Du spelar ensam') };
  const rows = () => [...panel.querySelectorAll('p')], acts = (r) => [...(rows()[r]?.querySelectorAll('[data-a]') || [])];
  const runAct = () => ACT[acts(row)[aSel].dataset.a]();
  const setOpt = (k, v) => {
    if (k === 'fx') { if (hq !== (v === '1' && !hqOff)) { hq = v === '1' && !hqOff; localStorage.setItem('m7c-fx', +hq); AREA = area0(); slow = fast = 0; ceil = 1e9; resize(); } }
    else if (k === 'leaf') { leaf = v; localStorage.setItem('m7c-leaf', v); resize(); }
    else if (k === 'dith') { dith = v; localStorage.setItem('m7c-dither', v); bset(); }
    else if (k === 'edge') { if (edge !== +v) { edge = +v; localStorage.setItem('m7c-edge', v); AREA = area0(); slow = fast = 0; ceil = 1e9; resize(); } }
    else if (k === 'sikt') { sikt = +v; localStorage.setItem('m7c-view', v); resize(); }
    else if (k === 'snes') { if (snes !== (v === '1' && !palOff)) { snes = v === '1' && !palOff; localStorage.setItem('m7c-snes', +snes); slow = fast = 0; ceil = 1e9; resize(); } }
    else { tod = v; localStorage.setItem('m7c-tod', v); }
    syncPanel();
  };
  // automatic fallback (this session only, nothing saved): a failed pipeline switches off just that feature;
  // a scene that renders pure black steps down HQ -> Standard -> Block leaves -> Pixel edges
  const fallback = (tag, why) => setTimeout(() => {
    console.warn('fallback', tag, why);
    if (tag === 'black') tag = hq ? 'hq' : leafM() ? 'leaf' : edge ? 'edge' : 'base';
    if (tag === 'hq' && !hqOff) { hqOff = true; hq = false; AREA = area0(); slow = fast = 0; ceil = 1e9; }
    else if (tag === 'leaf' && !leafOff) leafOff = true;
    else if (tag === 'edge' && edge) { edge = 0; AREA = area0(); slow = fast = 0; ceil = 1e9; }
    else if (tag === 'pal' && !palOff) { palOff = true; snes = false; if (edge === 3) { edge = 2; AREA = area0(); } slow = fast = 0; ceil = 1e9; }
    else if (tag === 'base') return fail('Grafiken kunde inte startas (WebGPU): ' + why);
    else return;
    warn(`Grafik: ${{ hq: 'HQ', leaf: 'l\u00f6vm\u00f6nster', edge: 'skarpa kanter', pal: 'SNES-l\u00e4ge/SS+palett' }[tag]} fungerar inte h\u00e4r och st\u00e4ngdes av (${String(why).slice(0, 160)})`);
    resize(); syncPanel();
  });
  // black-frame probe, once per (HQ, leaves, edges) combination: reads 3 short rows of the scene target.
  // A pipeline that WebKit silently refuses to draw leaves the clear colour (0,0,0) everywhere.
  const probed = new Set(); let probing = false, pf = 0, drawn = null;
  const probe = async () => {
    // skip if the target was re-created after the last draw (dynamic resolution / settings), it is still empty
    const key = [hq, leafM(), edge].join(); if (probing || probed.has(key) || rt !== drawn) return; probing = true; probed.add(key);
    try {
    const h = hq, b = h ? 8 : 4, w = Math.min(iw, 64), x = (iw - w) >> 1, buf = dev.createBuffer({ size: 1536, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    for (let j = 0; j < 3; j++) enc.copyTextureToBuffer({ texture: rt, origin: [x, Math.min(ih - 1, ih * (j + 1) >> 2)] }, { buffer: buf, offset: j * 512, bytesPerRow: 512 }, [w, 1]);
    dev.queue.submit([enc.finish()]);
    try {
      await buf.mapAsync(GPUMapMode.READ); const a = h ? new Uint16Array(buf.getMappedRange()) : new Uint8Array(buf.getMappedRange()); let lit = 0;
      for (let j = 0; j < 3; j++) for (let i = 0; i < w; i++) { let v = 0; for (let c = 0; c < 3; c++) v |= a[(j * 512 + i * b) / (h ? 2 : 1) + c] & (h ? 0x7fff : 255); lit += !!v; }
      // a real frame (sky, ground, even night) has colour almost everywhere
      buf.unmap(); if (lit < w * 3 / 4 && key === [hq, leafM(), edge].join()) fallback('black', 'svart bild');
    } catch (e) { console.warn('probe', e); }
    buf.destroy();
    } finally { probing = false; }
  };
  const togglePanel = () => { if (panel.classList.toggle('on') && document.pointerLockElement) document.exitPointerLock(); syncPanel(); };
  const stepOpt = (dir) => {
    const a = acts(row).length; if (a) { aSel = (aSel + dir + a) % a; return syncPanel(); }
    const o = [...panel.querySelectorAll('p')[row].querySelectorAll('i')], i = o.findIndex((e) => e.classList.contains('on')), e = o[(i + dir + o.length) % o.length]; setOpt(e.dataset.k, e.dataset.v);
  };
  const moveRow = (dir) => { const n = rows().length; row = (row + dir + n) % n; aSel = 0; syncPanel(); };
  const enter = () => (acts(row).length ? runAct() : stepOpt(1));
  panel.addEventListener('click', (e) => { const d = e.target.dataset; if (d.k) { row = rows().indexOf(e.target.closest('p')); setOpt(d.k, d.v); } if (d.a) { row = rows().indexOf(e.target.closest('p')); aSel = acts(row).indexOf(e.target); syncPanel(); ACT[d.a](); } });
  $('#g').addEventListener('click', togglePanel);
  for (const el of [panel, $('#g')]) el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  syncPanel();

  // ---------- v12 multiplayer: WebRTC data channels, no server ----------
  // Signalling is manual: the host's offer and the guest's answer travel as long links (#join= / #svar=) or
  // QR codes (SDP, deflate-raw, base64url). STUN only. Host-authoritative world: guests send their edits to the
  // host, who applies and rebroadcasts them; max 4 players (host + 3 guests, one RTCPeerConnection each).
  // Channel 'r' (reliable, JSON): hi / w(orld chunks) / e(dits) / j(oin) / l(eave). Channel 'u' (unordered,
  // no retransmits): player state at 15 Hz as 9 floats [id, x, y, z, fx, fy, walk phase, swing, seq].
  const NAMEK = 'm7c-name', MAXG = 3, RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }, RD = 120;
  const net = { mp: null, id: 0, seq: 0, peers: new Map(), pend: new Map(), rp: new Map(), name: localStorage.getItem(NAMEK) || '', wr: 0, wb: null, wc: null };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const clean = (n) => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Spelare';
  const gen = (n) => /[sxz]$/i.test(n) ? n : n + 's';
  const encC = async (o) => b64(await zip(new TextEncoder().encode(JSON.stringify(o))));
  const decC = async (s) => JSON.parse(new TextDecoder().decode(await zip(unb64(s), 1)));
  // smaller links: drop TCP candidates and two attributes a data-channel-only session does not need
  const slim = (sdp) => sdp.split('\r\n').filter((l) => !/^a=(extmap-allow-mixed|msid-semantic)|^a=candidate:.* tcp /i.test(l)).join('\r\n');
  const gather = (pc) => new Promise((ok) => { if (pc.iceGatheringState === 'complete') return ok(); const t = setTimeout(ok, 5000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); } }); });
  const mkPeer = () => {
    const pc = new RTCPeerConnection(RTC), r = pc.createDataChannel('r', { negotiated: true, id: 0 }), u = pc.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    u.binaryType = 'arraybuffer'; return { pc, r, u, id: -1, n: '?' };
  };
  const sendJ = (p, o) => { if (p?.r.readyState === 'open') p.r.send(JSON.stringify(o)); };
  const bcast = (o, not) => { for (const p of net.peers.values()) if (p !== not) sendJ(p, o); };
  const link = (k, c) => location.origin + location.pathname + '#' + k + '=' + c;
  const clock = () => performance.now() / 1000 + t0;
  // ---- QR code (byte mode, ECC L, versions 1-40, best of 8 masks) -> rows of booleans; no dependencies ----
  const qr = (txt) => {
    const data = [...new TextEncoder().encode(txt)];
    const EC = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
    const NB = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
    const raw = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const a = (v / 7 | 0) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; } return r; };
    let v = 1; while (v <= 40 && (raw(v) >> 3) - EC[v - 1] * NB[v - 1] < data.length + (v < 10 ? 2 : 3)) v++;
    if (v > 40) return null;
    const cap = (raw(v) >> 3) - EC[v - 1] * NB[v - 1], bits = [], put = (x, k) => { for (let i = k - 1; i >= 0; i--) bits.push(x >>> i & 1); };
    put(4, 4); put(data.length, v < 10 ? 8 : 16); for (const b of data) put(b, 8);
    put(0, Math.min(4, cap * 8 - bits.length)); put(0, (8 - bits.length % 8) % 8);
    const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let p = 0xec; cw.length < cap; p ^= 0xec ^ 0x11) cw.push(p);
    const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
    const ne = EC[v - 1], nb = NB[v - 1], dv = new Array(ne).fill(0); dv[ne - 1] = 1;
    for (let i = 0, rt = 1; i < ne; i++, rt = mul(rt, 2)) for (let j = 0; j < ne; j++) { dv[j] = mul(dv[j], rt); if (j + 1 < ne) dv[j] ^= dv[j + 1]; }
    const rs = (d) => { const r = new Array(ne).fill(0); for (const b of d) { const f = b ^ r.shift(); r.push(0); for (let i = 0; i < ne; i++) r[i] ^= mul(dv[i], f); } return r; };
    const rc = raw(v) >> 3, ns = nb - rc % nb, sl = rc / nb | 0, bl = [];
    for (let i = 0, k = 0; i < nb; i++) { const d = cw.slice(k, k += sl - ne + (i < ns ? 0 : 1)), e = rs(d); if (i < ns) d.push(0); bl.push(d.concat(e)); }
    const all = []; for (let i = 0; i < bl[0].length; i++) for (let j = 0; j < nb; j++) if (i !== sl - ne || j >= ns) all.push(bl[j][i]);
    const n = v * 4 + 17, M = [], F = [];
    for (let i = 0; i < n; i++) { M.push(new Array(n).fill(false)); F.push(new Array(n).fill(false)); }
    const set = (x, y, d) => { M[y][x] = !!d; F[y][x] = true; };
    for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4); }
    if (v > 1) {
      const na = (v / 7 | 0) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2, ap = [6]; for (let p = n - 7; ap.length < na; p -= step) ap.splice(1, 0, p);
      for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) if (!(i === 0 && j === 0 || i === 0 && j === na - 1 || i === na - 1 && j === 0)) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const fmt = (m) => {
      const d = 1 << 3 | m; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = (d << 10 | r) ^ 0x5412, g = (i) => b >>> i & 1;
      for (let i = 0; i <= 5; i++) set(8, i, g(i)); set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
      for (let i = 0; i < 8; i++) set(n - 1 - i, 8, g(i)); for (let i = 8; i < 15; i++) set(8, n - 15 + i, g(i)); set(8, n - 8, 1);
    };
    fmt(0);
    if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = v << 12 | r; for (let i = 0; i < 18; i++) { const t = b >>> i & 1, a = n - 11 + i % 3, c = i / 3 | 0; set(a, c, t); set(c, a, t); } }
    for (let i = 0, r = n - 1; r >= 1; r -= 2) { if (r === 6) r = 5; for (let vt = 0; vt < n; vt++) for (let j = 0; j < 2; j++) { const x = r - j, y = (r + 1 & 2) === 0 ? n - 1 - vt : vt; if (!F[y][x] && i < all.length * 8) { M[y][x] = (all[i >>> 3] >>> 7 - (i & 7) & 1) === 1; i++; } } }
    const MK = [(x, y) => (x + y) % 2, (x, y) => y % 2, (x) => x % 3, (x, y) => (x + y) % 3, (x, y) => ((x / 3 | 0) + (y / 2 | 0)) % 2, (x, y) => x * y % 2 + x * y % 3, (x, y) => (x * y % 2 + x * y % 3) % 2, (x, y) => ((x + y) % 2 + x * y % 3) % 2];
    const msk = (m) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!F[y][x] && !MK[m](x, y)) M[y][x] = !M[y][x]; };
    const pen = () => {
      let p = 0, dk = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { dk += M[y][x]; if (x < n - 1 && y < n - 1 && M[y][x] === M[y][x + 1] && M[y][x] === M[y + 1][x] && M[y][x] === M[y + 1][x + 1]) p += 3; }
      for (let a = 0; a < n; a++) { let rx = 1, ry = 1; for (let b = 1; b < n; b++) { if (M[a][b] === M[a][b - 1]) { if (++rx === 5) p += 3; else if (rx > 5) p++; } else rx = 1; if (M[b][a] === M[b - 1][a]) { if (++ry === 5) p += 3; else if (ry > 5) p++; } else ry = 1; } }
      return p + (Math.ceil(Math.abs(dk * 20 - n * n * 10) / (n * n)) - 1) * 10;
    };
    let best = 0, bp = 1e9; for (let m = 0; m < 8; m++) { msk(m); fmt(m); const p = pen(); if (p < bp) { bp = p; best = m; } msk(m); }
    msk(best); fmt(best); return M;
  };
  const drawQR = (c, txt) => {
    const M = qr(txt); if (!M) return c.remove(); const n = M.length, s = Math.max(2, Math.floor(Math.min(340, innerWidth * 0.82, innerHeight * 0.5) / (n + 8)));
    c.width = c.height = (n + 8) * s; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.width); g.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) g.fillRect((x + 4) * s, (y + 4) * s, s, s);
  };
  // ---- sheet: the small dialog for names, links and QR codes ----
  const shEl = $('#n'); let shFn = {};
  const sheet = (html, fn = {}) => { shEl.innerHTML = html; shFn = fn; shEl.classList.add('on'); if (document.pointerLockElement) document.exitPointerLock(); };
  const closeSheet = () => { shEl.classList.remove('on'); shFn = {}; };
  shEl.addEventListener('click', (e) => { const k = e.target.dataset?.n; if (k && shFn[k]) shFn[k](); else if (k === 'x') closeSheet(); });
  shEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && shFn.ok) shFn.ok(); if (e.key === 'Escape') closeSheet(); e.stopPropagation(); });
  for (const ev of ['touchstart', 'touchmove', 'pointerdown', 'wheel', 'keyup']) shEl.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  const setName = (n) => { net.name = clean(n); localStorage.setItem(NAMEK, net.name); };
  const nameIn = () => `<input id="nn" maxlength="16" autocomplete="nickname" placeholder="Anv\u00e4ndarnamn" value="${esc(net.name)}">`;
  const askName = (title) => new Promise((ok) => {
    sheet(`<b>${title}</b><p>Ditt namn syns ovanf\u00f6r din gubbe.</p>${nameIn()}<div><i data-n="ok">OK</i><i data-n="no">Avbryt</i></div>`,
      { ok: () => { setName($('#nn').value); closeSheet(); ok(true); }, no: () => { closeSheet(); ok(false); } });
    setTimeout(() => $('#nn')?.focus(), 50);
  });
  const copy = async (url) => { try { await navigator.clipboard.writeText(url); toast('L\u00e4nk kopierad'); } catch { $('#nl')?.select(); } };
  const shareL = async (url) => { try { await navigator.share({ title: 'Mode7craft', url }); } catch { copy(url); } };
  const showLink = (title, text, url, host) => {
    sheet(`<b>${esc(title)}</b><p>${esc(text)}</p><canvas id="nq"></canvas><textarea id="nl" readonly rows="3">${esc(url)}</textarea><div><i data-n="cp">Kopiera</i>${navigator.share ? '<i data-n="sh">Dela</i>' : ''}<i data-n="x">St\u00e4ng</i></div>` +
      (host ? `<p>Klistra in v\u00e4nnens svarsl\u00e4nk:</p><input id="na" placeholder="https://\u2026#svar=\u2026"><div><i data-n="ok">Anslut</i></div>` : '<p class="w">V\u00e4ntar p\u00e5 anslutning\u2026</p>'),
      { cp: () => copy(url), sh: () => shareL(url), ok: host ? () => answer($('#na').value) : undefined });
    drawQR($('#nq'), url);
  };
  // ---- connection lifecycle ----
  const wire = (p, key) => {
    p.r.onopen = () => onOpen(p, key);
    p.r.onmessage = (e) => { try { onMsg(p, JSON.parse(e.data)); } catch (er) { console.warn('net', er); } };
    p.u.onmessage = (e) => onState(p, new Float32Array(e.data));
    p.r.onclose = () => drop(p);
    p.pc.onconnectionstatechange = () => { if (/failed|closed/.test(p.pc.connectionState)) drop(p); };
  };
  // host: 'Bjud in' -> a fresh peer connection + offer link; one per guest
  const invite = async () => {
    if (net.mp === 'guest') return toast('Bara v\u00e4rden kan bjuda in'), '';
    if (net.peers.size >= MAXG) return toast('Fullt: max 4 spelare'), '';
    if (!net.name && !await askName('Bjud in en v\u00e4n')) return '';
    const p = mkPeer(), i = Math.random().toString(36).slice(2, 8);
    for (const [k, q] of net.pend) if (net.pend.size >= 4) { q.pc.close(); net.pend.delete(k); }   // forget stale invites
    net.pend.set(i, p); wire(p, i);
    sheet('<b>Bjud in</b><p>Skapar inbjudan\u2026</p>');
    await p.pc.setLocalDescription(await p.pc.createOffer()); await gather(p.pc);
    const url = link('join', await encC({ i, n: net.name, s: slim(p.pc.localDescription.sdp) }));
    showLink('Bjud in en v\u00e4n', 'Skicka l\u00e4nken till din v\u00e4n (eller l\u00e5t hen skanna QR-koden). V\u00e4nnen f\u00e5r d\u00e5 en svarsl\u00e4nk att skicka tillbaka \u2013 \u00f6ppna den i den h\u00e4r webbl\u00e4saren eller klistra in den nedan.', url, true);
    return url;
  };
  const answer = async (s) => {
    const m = String(s).match(/svar=([\w-]+)/); let a;
    try { a = await decC(m ? m[1] : String(s).trim()); } catch { toast('Ogiltigt svar'); return 0; }
    const p = net.pend.get(a.i); if (!p || p.pc.signalingState !== 'have-local-offer') { toast('Svaret h\u00f6r inte till n\u00e5gon \u00f6ppen inbjudan'); return 0; }
    p.n = clean(a.n); await p.pc.setRemoteDescription({ type: 'answer', sdp: a.s });
    sheet(`<b>Ansluter</b><p>Ansluter till ${esc(p.n)}\u2026</p><div><i data-n="x">St\u00e4ng</i></div>`); return 1;
  };
  // guest: opened a #join link -> name -> answer link back to the host
  const accept = async (o, name) => {
    if (name != null) setName(name);
    if (net.mp) leave();
    const p = mkPeer(); p.id = 0; p.n = clean(o.n); net.id = -1; net.pend.set('host', p); wire(p, 'host');
    sheet('<b>G\u00e5 med</b><p>Skapar svar\u2026</p>');
    await p.pc.setRemoteDescription({ type: 'offer', sdp: o.s }); await p.pc.setLocalDescription(await p.pc.createAnswer()); await gather(p.pc);
    const url = link('svar', await encC({ i: o.i, n: net.name, s: slim(p.pc.localDescription.sdp) }));
    if (p.r.readyState !== 'open') showLink(`G\u00e5 med i ${gen(p.n)} v\u00e4rld`, `Skicka den h\u00e4r svarsl\u00e4nken (eller QR-koden) tillbaka till ${p.n}. N\u00e4r ${p.n} \u00f6ppnar den kopplas ni ihop.`, url);
    return url;
  };
  const askJoin = async (code) => {
    let o; try { o = await decC(code); } catch { return toast('Ogiltig inbjudan'); }
    sheet(`<b>G\u00e5 med i ${esc(gen(clean(o.n)))} v\u00e4rld</b><p>V\u00e4lj ett anv\u00e4ndarnamn:</p>${nameIn()}<div><i data-n="ok">G\u00e5 med</i><i data-n="x">Spela ensam</i></div>`, { ok: () => accept(o, $('#nn').value) });
    setTimeout(() => $('#nn')?.focus(), 50);
  };
  const onOpen = (p, key) => {
    net.pend.delete(key);
    if (key === 'host') { closeSheet(); net.mp = 'guest'; net.peers.set(0, p); addRP(0, p.n); toast(`Ansluten till ${p.n}`); return; }
    if (net.peers.size >= MAXG) { sendJ(p, { t: 'full' }); setTimeout(() => p.pc.close(), 500); return; }
    let id = 1; while (net.peers.has(id)) id++; p.id = id; net.mp = 'host'; closeSheet();
    sendJ(p, { t: 'hi', id, p: [[0, net.name || 'V\u00e4rd'], ...[...net.peers.values()].map((q) => [q.id, q.n])], tm: clock(), x: [st[0], st[1], st[2]] });
    bcast({ t: 'j', id, n: p.n }); net.peers.set(id, p); addRP(id, p.n);
    sendWorld(p); toast(`${p.n} gick med`);
  };
  const sendWorld = async (p) => { const s = b64(await pack()), C = 16000, n = Math.ceil(s.length / C); for (let k = 0; k < n; k++) sendJ(p, { t: 'w', k, n, d: s.slice(k * C, k * C + C) }); };
  const applyE = (b) => { for (const [x, y, z, id] of b) if (X.set_block(x, y, z, id)) touch1(x, y, z, id, 1); };
  const okE = (b) => Array.isArray(b) ? b.filter((e) => Array.isArray(e) && e.length === 4 && e.every(Number.isInteger) && e[3] >= 0 && e[3] <= 8 && (e[3] || e[2] > 0)).slice(0, 64) : [];
  const onMsg = async (p, m) => {
    if (net.mp === 'host') { if (m.t === 'e') { const b = okE(m.b); if (b.length) { applyE(b); bcast({ t: 'e', b }); } } return; }
    if (m.t === 'hi') { net.id = m.id; for (const [id, n] of m.p) if (id !== m.id) addRP(id, n); t0 = m.tm - performance.now() / 1000; net.hx = m.x; }
    else if (m.t === 'w') {
      (net.wc ||= [])[m.k] = m.d; if (net.wc.filter((x) => x != null).length < m.n) return;
      const s = net.wc.join(''); net.wc = null; const w = await unpack(unb64(s));
      saveNow(); noSave = true; loadWorld(w); net.wr = 1; applyE(net.wb || []); net.wb = null;
      if (net.hx) { const [x, y, z] = net.hx, nx = Math.min(N - 2, Math.max(1, x + 1.5)) | 0, ny = Math.min(N - 2, Math.max(1, y)) | 0; st[0] = nx + 0.5; st[1] = ny + 0.5; st[2] = Math.max(H8()[ny * N + nx], z); cz = st[2]; }
    }
    else if (m.t === 'e') { const b = okE(m.b); if (net.wr) applyE(b); else (net.wb ||= []).push(...b); }
    else if (m.t === 'j') { addRP(m.id, m.n); toast(`${clean(m.n)} gick med`); }
    else if (m.t === 'l') { const r = net.rp.get(m.id); if (r) toast(`${r.n} l\u00e4mnade`); delRP(m.id); }
    else if (m.t === 'full') toast('V\u00e4rlden \u00e4r full (max 4 spelare)');
  };
  const onState = (p, f) => {
    if (f.length !== 9) return;
    if (net.mp === 'host') { f[0] = p.id; for (const q of net.peers.values()) if (q !== p && q.u.readyState === 'open') q.u.send(f); }
    const r = net.rp.get(f[0]); if (!r || f[0] === net.id || f[8] <= r.seq) return;
    r.seq = f[8]; r.q.push([performance.now(), f.slice(1, 8)]); if (r.q.length > 10) r.q.shift();
  };
  const drop = (p) => {
    if (p.gone) return; p.gone = 1; try { p.pc.close(); } catch {}
    for (const [k, q] of net.pend) if (q === p) { net.pend.delete(k); if (shEl.textContent.includes('Ansluter') || k === 'host') { closeSheet(); toast(`Kunde inte ansluta till ${p.n}`); } }
    if (net.mp === 'host' && net.peers.get(p.id) === p) { net.peers.delete(p.id); delRP(p.id); bcast({ t: 'l', id: p.id }); toast(`${p.n} l\u00e4mnade`); if (!net.peers.size) net.mp = null; }
    else if (net.mp === 'guest' && p.id === 0) leave(`Anslutningen till ${p.n} br\u00f6ts \u2013 din egen v\u00e4rld \u00e4r tillbaka`);
  };
  const leave = (msg) => {
    const g = net.mp === 'guest';
    for (const p of [...net.peers.values(), ...net.pend.values()]) { p.gone = 1; try { p.pc.close(); } catch {} }
    net.peers.clear(); net.pend.clear(); for (const id of [...net.rp.keys()]) delRP(id);
    net.mp = null; net.id = 0; net.wr = 0; net.wb = net.wc = null;
    if (g || noSave) { noSave = false; loadWorld(parseEd(localStorage.getItem(KEY))); }
    if (msg !== 0) toast(msg || 'Du l\u00e4mnade spelet');
  };
  netEd = (x, y, z, id) => { const m = { t: 'e', b: [[x, y, z, id]] }; if (net.mp === 'host') bcast(m); else if (net.mp === 'guest' && net.wr) sendJ(net.peers.get(0), m); };
  // the answer link opened in another tab of the same browser reaches the host tab here
  const bc = typeof BroadcastChannel == 'function' ? new BroadcastChannel('m7c-net') : null;
  if (bc) bc.onmessage = async (e) => { if (!e.data?.svar) return; let a; try { a = await decC(e.data.svar); } catch { return; } if (net.pend.has(a.i)) { bc.postMessage({ ack: a.i }); answer(e.data.svar); } };
  const onHash = async () => {
    const h = location.hash.match(/^#(join|svar)=([\w-]+)/); if (!h) return 0;
    history.replaceState(null, '', location.pathname + location.search);
    if (h[1] === 'join') return askJoin(h[2]), 1;
    try { const a = await decC(h[2]); if (net.pend.has(a.i)) return answer(h[2]), 1; } catch { return toast('Ogiltig l\u00e4nk'), 1; }
    // not this tab's invite: hand it to the tab that made it
    sheet('<b>Svarsl\u00e4nk</b><p>Skickar svaret till fliken d\u00e4r du bj\u00f6d in\u2026</p>');
    const done = (ok) => { clearTimeout(to); bc?.removeEventListener('message', w); sheet(ok ? '<b>Klart!</b><p>Svaret skickades till fliken d\u00e4r du bj\u00f6d in. Du kan st\u00e4nga den h\u00e4r fliken.</p><div><i data-n="x">OK</i></div>' : '<b>Svarsl\u00e4nk</b><p>Hittade ingen \u00f6ppen inbjudan i den h\u00e4r webbl\u00e4saren. \u00d6ppna l\u00e4nken i webbl\u00e4saren d\u00e4r du klickade Bjud in, eller klistra in den d\u00e4r.</p><div><i data-n="x">OK</i></div>'); };
    const w = (e) => { if (e.data?.ack) done(1); }, to = setTimeout(() => done(0), 5000); bc?.addEventListener('message', w); bc?.postMessage({ svar: h[2] });
    return 1;
  };
  addEventListener('hashchange', onHash);
  // ---- remote players: interpolated ~RD ms behind, drawn by the shader (U[21].y, U[22..29]); DOM nametags ----
  const mkTag = (n) => {
    const c = document.createElement('canvas'), g = c.getContext('2d'), F = '10px ui-monospace,Menlo,monospace'; c.className = 'nt';
    g.font = F; const w = Math.ceil(g.measureText(n).width) + 4; c.width = w; c.height = 13; g.font = F; g.textBaseline = 'top'; g.fillStyle = '#fff'; g.fillText(n, 2, 2);
    // hard-edged pixel text: threshold the antialiased glyphs, plate = translucent black (early-Minecraft nametag)
    const d = g.getImageData(0, 0, w, 13), a = d.data; for (let i = 0; i < a.length; i += 4) { const on = a[i + 3] > 96; a[i] = a[i + 1] = a[i + 2] = on ? 255 : 0; a[i + 3] = on ? 255 : 110; }
    g.putImageData(d, 0, 0); return c;
  };
  const addRP = (id, n) => { if (net.rp.has(id)) return; const tag = mkTag(clean(n)); document.body.append(tag); net.rp.set(id, { n: clean(n), q: [], tag, seq: 0 }); };
  const delRP = (id) => { const r = net.rp.get(id); if (r) { r.tag.remove(); net.rp.delete(id); } };
  // own state at 15 Hz on a timer (keeps going even when the frame rate drops)
  setInterval(() => { if (!net.mp) return; const f = new Float32Array([net.id, st[0], st[1], st[2], st[4], st[5], st[6], st[7], ++net.seq]); for (const q of net.peers.values()) if (q.u.readyState === 'open') try { q.u.send(f); } catch {} }, 1000 / 15);
  const netFrame = (far) => {
    if (!net.mp) return;
    const tn = performance.now() - RD; let k = 0;
    for (const [id, r] of net.rp) {
      const q = r.q; if (!q.length || k >= 4) { r.tag.style.display = 'none'; continue; }
      let i = 0; while (i < q.length - 1 && q[i + 1][0] <= tn) i++;
      const a = q[i][1], b = (q[i + 1] || q[i])[1], t = q[i + 1] ? Math.min(1, Math.max(0, (tn - q[i][0]) / (q[i + 1][0] - q[i][0]))) : 0, L = (j) => a[j] + (b[j] - a[j]) * t;
      const fx = L(3), fy = L(4), fl = Math.hypot(fx, fy) || 1, dp = Math.atan2(Math.sin(b[5] - a[5]), Math.cos(b[5] - a[5])), p = [L(0), L(1), L(2)];
      U.set([...p, id % 4, fx / fl, fy / fl, a[5] + dp * t, L(6)], 88 + k * 8); k++;
      // nametag: project the point above the head to the screen (same camera model as screenRay)
      const d = [p[0] - cam.o[0], p[1] - cam.o[1], p[2] + 2.25 - cam.o[2]], z = d[0] * cam.F[0] + d[1] * cam.F[1] + d[2] * cam.F[2];
      if (z < 0.5 || z > far) { r.tag.style.display = 'none'; continue; }
      const ax = iw / ih, ux = (d[0] * cam.R[0] + d[1] * cam.R[1] + d[2] * cam.R[2]) / z / (ax * cam.tan), uy = -(d[0] * cam.Up[0] + d[1] * cam.Up[1] + d[2] * cam.Up[2]) / z / cam.tan;
      const v = vrect(), s = Math.min(4, Math.max(1, Math.round(v[3] / (cam.tan * z) * 0.5 / 13 * 2) / 2)), w = r.tag.width * s;
      r.tag.style.cssText = `display:block;width:${w}px;height:${13 * s}px;transform:translate(${Math.round(v[0] + (ux + 1) / 2 * v[2] - w / 2)}px,${Math.round(v[1] + (uy + 1) / 2 * v[3] - 13 * s)}px)`;
    }
    U[85] = k;
  };
  net.invite = invite; net.answer = answer; net.accept = async (code, name) => accept(await decC(String(code).replace(/^.*join=/, '')), name); net.leave = leave;

  // ---------- keyboard + mouse ----------
  let jumpQ = false;
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('#n')) return;   // typing in the multiplayer dialog
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
  const U = new Float32Array(120), TLB = new Float32Array(128);
  let last = performance.now(), acc = 0, frames = 0, slow = 0, fast = 0, ceil = 1e9, warm = 0; const fixedArea = qs.has('area');
  // debug: ?p=x,y teleport, ?t=seconds time offset, ?pt=pitch
  if (qs.get('p')) { const [x, y] = qs.get('p').split(',').map(Number); const hm8 = H8(); st[0] = x + 0.5; st[1] = y + 0.5; st[2] = hm8[y * N + x] + 2; }
  if (qs.get('pt')) pitch = +qs.get('pt');
  let t0 = +qs.get('t') || 0;
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
  const draw = (fb) => {
    const enc = dev.createCommandEncoder();
    // re-bake the sun-shadow cache only when the sun has moved > ~0.4 deg or the world changed
    U.set([wx, wy, WS], 81); dev.queue.writeBuffer(ub, 81 * 4, U, 81, 3);   // the window the bake below covers (also before the first frame)
    if (hq && (fb || bakeDirty || bakedW !== wx + ',' + wy || !bakedL || (sunD[0] * bakedL[0] + sunD[1] * bakedL[1] + sunD[2] * bakedL[2]) / Math.hypot(...sunD) / Math.hypot(...bakedL) < 0.999976)) {
      const c = enc.beginComputePass(); c.setPipeline(Q.bake); c.setBindGroup(0, Q.bg); c.dispatchWorkgroups(WS * WS * NZ / 1024); c.end();
      bakedL = sunD; bakedW = wx + ',' + wy; bakeDirty = false; bakes++;
    }
    pass(enc, rt, SP, sg);
    if (hq) { pass(enc, bt, Q.bloom, bgB); pass(enc, lt, Q.out, bgO); }
    if (useQ()) pass(enc, ctx.getCurrentTexture(), PQ.p, bgQ); else pass(enc, ctx.getCurrentTexture(), blit, bg);
    dev.queue.submit([enc.finish()]); drawn = rt;
  };
  // test hook: mean GPU frame time (ms) over n frames, each awaited to completion
  const bench = async (n, fb) => { await dev.queue.onSubmittedWorkDone(); const t = Date.now(); for (let i = 0; i < n; i++) { draw(fb); await dev.queue.onSubmittedWorkDone(); } return { ms: (Date.now() - t) / n, iw, ih, hq }; };
  let ferr = 0;
  const frame = (now) => {
    try { tick(now); if (++pf > 3) probe(); ferr = 0; }
    catch (e) { console.error(e); warn('Fel i ritningen: ' + e.message); if (++ferr > 60) return fail('Spelet stannade: ' + e.message); }
    requestAnimationFrame(frame);
  };
  const tick = (now) => {
    const rdt = (now - last) / 1000, dt = Math.min(0.05, rdt); last = now;
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
    const far = (V.fps ? 64 : V.fog ? dist * 3.2 : dist * 6) * SIKT[sikt].m;
    // far field: past tH a block is ~1 art pixel -> 2.5D heightmap march (?hmk scales it; 0 = voxels only)
    const hmk = qs.has('hmk') ? +qs.get('hmk') : 1, tH = hmk ? ih / Math.max(art, 1) / (2 * tanV) / hmk : 1e9;
    // shadow-cache window: centred ahead of the camera, snapped to 16 blocks (re-bakes only when it moves)
    if (WS && WS < N) { const fl = Math.hypot(F[0], F[1]) || 1, k = Math.min(far, 60) * 0.4; wx = Math.max(0, Math.min(N - WS, Math.round((tx + F[0] / fl * k - WS / 2) / 16) * 16)); wy = Math.max(0, Math.min(N - WS, Math.round((ty + F[1] / fl * k - WS / 2) / 16) * 16)); } else wx = wy = 0;
    Object.assign(cam, { o: [tx - F[0] * dist, ty - F[1] * dist, tz - F[2] * dist], F, R, Up, tan: tanV });
    // highlight target: crosshair in FPS, pointer (mouse) or block in front (pad/keys/touch) elsewhere
    hl = V.fps ? target('center') : aim === 'pointer' && ptr && mode === 'kb' ? target('pointer', ptr[0], ptr[1]) : mode === 'touch' ? null : target('front');
    // particles
    for (const q of parts) { q.life -= dt; q.v[2] -= 18 * dt; for (let k = 0; k < 3; k++) q.p[k] += q.v[k] * dt; }
    while (parts.length && parts[parts.length - 1].life <= 0) parts.pop();
    U.fill(0);
    U.set([iw, ih, now / 1000 + t0, tanV, ...cam.o, V.fog, ...F, far, ...R, iw / ih, ...Up, leafM(), st[0], st[1], st[2], 0, st[4], st[5], st[6], st[7], V.fps ? 1 : 0, 0, 0, 0]);
    U.set([tH, wx, wy, WS, FOGS], 80);   // edge fog over the last 45% of the view distance (?fogs = start fraction, 0.35 = v10)
    if (hl) U.set([...hl.b, 1], 32);
    netFrame(far);
    U[39] = edge === 1 && !snes ? -1 : art;
    if (useQ()) {
      // SNES fog colour: the horizon sky (HQ: scaled by daylight, warmed by the sun near the horizon)
      const fc = hq ? (() => { const s = sun(now / 1000 + t0), w = Math.sqrt(s[3]); return [0.761, 0.859, 0.941].map((x, i) => Math.min(1, x * w + s[1][i] * 0.08 * (1 - s[3]))); })() : [0.761, 0.859, 0.941];
      QB.set([snes ? 2 : 1, dith === '1' || (dith === 'auto' && hq) ? 1 : 0, sp, cp, tanV, Math.max(0.5, cam.o[2] - st[2]), far, 0.3, V.fog ? 0.5 : 0, 0, ...fc], 2);
      dev.queue.writeBuffer(PQ.qb, 0, QB);
    }
    if (hq) { const [d, c, sky, w] = sun(now / 1000 + t0); U.set(sky, 29); U.set([...d, 0, ...c, w], 72); sunD = d; }
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
    if ((V.fps | 0) !== cross) { cross = V.fps | 0; bset(); }
    dev.queue.writeBuffer(ub, 0, U);
    draw();
    acc += Math.min(rdt, 0.5); frames++;   // real frame time (dt is clamped for physics)
    // adaptive resolution, checked every second: below ~45 fps for 2 s (or below ~20 fps at once) steps down;
    // ~55+ fps for 3 s steps up towards the mode's cap, never back above a level that was too slow
    if (acc > 1 && warm++ < 2) { acc = 0; frames = 0; }   // skip the first 2 s (pipeline compile, world upload)
    if (acc > 1) {
      const ft = acc / frames, lo = (hq ? 25000 : 45000) * (edge === 3 ? 4 : 1);
      if (snes) { /* SNES-läge: fixed 256x224 */ }
      else if (ft > 0.022 && AREA > lo) { fast = 0; if (ft > 0.05 || ++slow >= 2) { if (slow) ceil = AREA * 0.95; AREA = Math.max(lo, AREA * (ft > 0.05 ? 0.6 : 0.75)); resize(); slow = 0; } }
      else if (ft < 0.0185 && !fixedArea && AREA < Math.min(amax(), ceil) * 0.99) { slow = 0; if (++fast >= 3) { AREA = Math.min(AREA * 1.25, amax(), ceil); resize(); fast = 0; } }
      else slow = fast = 0;
      acc = 0; frames = 0;
    }
  };
  window.m7 = { net, act, target, setSlot, X, edits, save, pack, unpack, b64, importBytes, shareLink, exportWorld, loadWorld, bench, setOpt, togglePanel, get bakes() { return bakes; }, get view() { return view; }, get area() { return AREA; }, get sikt() { return sikt; }, get migrated() { return migrated; }, gpuMem: () => { const o = {}; let t = 0; for (const [k, b] of gmem.values()) { o[k] = (o[k] || 0) + b; t += b; } const sw = W * H * 4 * 3; return { total: t, swapchain3: sw, all: t + sw, ...o }; } }; // handy for tests
  // shared world link (#w=...): load it, then drop the hash so later local edits stay local
  const hw = location.hash.match(/^#w=([\w-]+)/);
  if (hw) { history.replaceState(null, '', location.pathname + location.search); try { await importBytes(unb64(hw[1])); } catch { toast('Ogiltig l\u00e4nk'); } }
  await onHash();   // #join= (a friend's invite) / #svar= (an answer to one of your invites)
  $('#l').remove();
  requestAnimationFrame(frame);
})().catch((e) => fail('Failed to start: ' + e.message));
