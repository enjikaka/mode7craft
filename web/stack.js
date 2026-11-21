// v14 experimental sprite-stacking renderer. Lazy-loaded only when ?stack=1 / Stack (test) is on.
const STACK_WGSL = `/*STACK*/`;
const N = 256, NZ = 16, TILE = 16, NT = N / TILE, ZW = 2.75;
const MAXS = NT * NT * NZ + NT * NT;   // solids + one water quad per tile
const MAXA = 5 * 15;                   // local + 4 remotes, 15 layers

export function create({ dev, guard, vox, hm, ub, getW, getH }) {
  const ib = dev.createBuffer({ label: 'stack-inst', size: MAXS * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const ab = dev.createBuffer({ label: 'stack-actors', size: MAXA * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const inst = new Float32Array(MAXS * 4);
  let nS = 0, nW = 0, pl, plW, bg, depth, iw = 0, ih = 0, ready = false;

  const layout = {
    arrayStride: 16, stepMode: 'instance',
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }]
  };
  const ds = (write) => ({ format: 'depth32float', depthWriteEnabled: write, depthCompare: 'less' });
  const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };

  const rebuild = () => {
    const w = getW(), h = getH(); nS = 0; nW = 0;
    const water = [];
    for (let ty = 0; ty < NT; ty++) for (let tx = 0; tx < NT; tx++) {
      const x0 = tx * TILE, y0 = ty * TILE;
      let hasW = false;
      for (let z = 0; z < NZ; z++) {
        let any = 0;
        for (let y = 0; y < TILE && !any; y++) {
          const row = (z * N + y0 + y) * N + x0;
          for (let x = 0; x < TILE; x++) if (w[row + x]) { any = 1; break; }
        }
        if (any) { inst.set([x0, y0, z, 0], nS * 4); nS++; }
      }
      for (let y = 0; y < TILE && !hasW; y++) for (let x = 0; x < TILE; x++) if (h[(y0 + y) * N + x0 + x] < 3) hasW = true;
      if (hasW) water.push(x0, y0, ZW, 1);
    }
    nW = water.length >> 2;
    inst.set(water, nS * 4);
    dev.queue.writeBuffer(ib, 0, inst, 0, (nS + nW) * 4);
  };

  const init = (format) => {
    const m = dev.createShaderModule({ code: STACK_WGSL });
    const v = { module: m, entryPoint: 'vs', buffers: [layout] };
    const t = (bl) => [{ format, blend: bl }];
    // shared explicit layout so the opaque and water pipelines can use the same bind group
    const bgl = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 480 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint', viewDimension: '3d' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint', viewDimension: '2d' } }
    ] });
    const pll = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
    pl = guard('stack', () => dev.createRenderPipeline({ layout: pll, vertex: v, fragment: { module: m, entryPoint: 'fs', targets: t() }, depthStencil: ds(true), primitive: { topology: 'triangle-list' } }));
    plW = guard('stack', () => dev.createRenderPipeline({ layout: pll, vertex: v, fragment: { module: m, entryPoint: 'fs', targets: t(blend) }, depthStencil: ds(false), primitive: { topology: 'triangle-list' } }));
    if (!pl) return false;
    bg = dev.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: ub } },
      { binding: 1, resource: vox.createView() },
      { binding: 2, resource: hm.createView() }
    ] });
    ready = true; return true;
  };

  const resize = (w, h, format) => {
    if (!pl && !init(format)) return;
    if (depth && iw === w && ih === h) return;
    depth?.destroy();
    depth = dev.createTexture({ label: 'stack-depth', size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    iw = w; ih = h;
  };

  const actors = (n) => {
    // local player (slot 0) + n remotes: 15 Z-slices each
    const a = new Float32Array(MAXA * 4); let c = 0;
    const add = (slot) => { for (let z = 0; z < 15; z++, c++) a.set([0, 0, z, 2 + slot], c * 4); };
    add(0); for (let i = 0; i < n && i < 4; i++) add(i + 1);
    dev.queue.writeBuffer(ab, 0, a, 0, c * 4);
    return c;
  };

  const draw = (enc, rt, tw, nRemote, hideMe) => {
    if (!ready || !depth) return false;
    const nA = actors(nRemote);
    const first = hideMe ? 15 : 0;   // in first person we shouldn't be here, but skip the local stack if asked
    const p = enc.beginRenderPass({
      colorAttachments: [{ view: rt.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.761, 0.859, 0.941, 1] }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: tw
    });
    p.setPipeline(pl); p.setBindGroup(0, bg);
    p.setVertexBuffer(0, ib); p.draw(6, nS);
    if (nA > first) { p.setVertexBuffer(0, ab); p.draw(6, nA - first, 0, first); }
    if (nW && plW) { p.setPipeline(plW); p.setVertexBuffer(0, ib); p.draw(6, nW, 0, nS); }
    p.end();
    return true;
  };

  const destroy = () => { depth?.destroy(); depth = null; iw = ih = 0; };

  rebuild();
  return { rebuild, resize, draw, destroy, get counts() { return { solid: nS, water: nW }; } };
}
