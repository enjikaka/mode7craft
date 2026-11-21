
const STACK_WGSL = `struct V{@builtin(position)p:vec4f,@location(0)wp:vec3f,@location(1)kind:f32};@vertex fn vs(@builtin(vertex_index)vi:u32,@location(0)inst:vec4f)->V{var c=array<vec2f,6>(vec2f(0.,0.),vec2f(1.,0.),vec2f(0.,1.),vec2f(1.,0.),vec2f(1.,1.),vec2f(0.,1.));let u=c[vi];var o:V;o.kind=inst.w;let k=u32(inst.w+0.5);if(k>=2u){let s=k-2u;let idx=select(0u,s-1u,s>0u);let P=select(U[5],U[22u+2u*idx],s>0u);let z0=floor(P.z*S+0.01);o.wp=vec3f(P.xy-0.8+u*1.6,(z0+inst.z+1.)/S);}else if(k==1u){o.wp=vec3f(inst.xy+u*16.,inst.z);}else{o.wp=vec3f(inst.xy+u*16.,inst.z+1.);}let d=o.wp-U[1].xyz;let z=dot(d,U[2].xyz);let tanV=U[0].w;if(z<0.05){o.p=vec4f(2.,2.,2.,1.);}else{o.p=vec4f(dot(d,U[3].xyz)/(U[3].w*tanV),dot(d,U[4].xyz)/tanV,z*(z/max(U[2].w,1.)),z);}return o;}@group(0)@binding(0)var<uniform>U:array<vec4f,30>;@group(0)@binding(1)var vox:texture_3d<u32>;@group(0)@binding(2)var hm:texture_2d<u32>;const N=256;const NZ=16;const S=8.;const ZW=2.75;const TR=0.34;const SUN=vec3f(-0.5,0.42,0.757);const FOG=vec3f(0.761,0.859,0.941);fn hh(a:u32)->u32{var n=a;n^=n >> 16u;n*=0x7feb352du;n^=n >> 15u;n*=0x846ca68bu;n^=n >> 16u;return n;}fn h2(p:vec2i)->f32{return f32(hh((u32(p.x)*1597334677u)^hh(u32(p.y)+0x9e3779b9u)) >> 8u)/16777216.;}fn h3(p:vec3i)->f32{return h2(vec2i(p.x+p.z*7919,p.y^(p.z*104729)));}fn c3(h:u32)->vec3f{return vec3f(f32((h >> 16u)&255u),f32((h >> 8u)&255u),f32(h&255u))/255.;}fn block(b:vec3i)->u32{if(b.x<0||b.y<0||b.z<0||b.x>=N||b.y>=N||b.z>=NZ){return 0u;}return(textureLoad(vox,vec3i(b.x >> 1u,b.y,b.z),0).r >> (u32(b.x&1)*4u))&15u;}fn height(b:vec2i)->i32{if(b.x<0||b.y<0||b.x>=N||b.y>=N){return 0;}return i32(textureLoad(hm,b,0).r&31u);}fn lbit(q:vec2i,f:u32)->bool{var a=select(q,q.yx,(f&1u)!=0u);a^=vec2i(select(0,7,(f&2u)!=0u),select(0,7,(f&4u)!=0u));return((select(0x66dff56cu,0x9ebbef66u,a.y<4) >> u32((a.y&3)*8+a.x))&1u)!=0u;}fn leafHit(pe:vec3f)->bool{let q=vec2i(clamp(vec2i(floor(fract(pe.xy)*S)),vec2i(0),vec2i(7)));let k=vec3i(floor(pe-vec3f(0.,0.,0.5)));let f=u32((k.x*5+k.y*3+k.z*7+(k.x^k.y)*2)&7);let t=vec3i(floor(pe*S));let rim=(any(q==vec2i(0))||any(q==vec2i(7)))&&((u32(t.x*73+t.y*151+t.z*211)*0x9e3779b9u) >> 31u)==0u;return lbit(q,f)&&!rim;}fn grassCol(hb:f32)->vec3f{switch i32(hb){case 4:{return c3(0x8fd24au);}case 5:{return c3(0x78c438u);}case 6:{return c3(0x66b232u);}case 7:{return c3(0x549f2cu);}default:{return c3(0x448c27u);}}}fn matCol(id:u32,t:vec3i)->vec3f{let r=h3(t);let l=t&vec3i(7);let b=t >> vec3u(3u);var c:vec3f;switch id{case 1u:{let g=grassCol(f32(b.z+1));c=g*(0.94+0.1*h2(b.xy));if(r<0.09){c*=0.78;}else if(r>0.96){c*=1.12;}if((l.x==0&&block(b+vec3i(-1,0,1))!=0u)||(l.x==7&&block(b+vec3i(1,0,1))!=0u)||(l.y==0&&block(b+vec3i(0,-1,1))!=0u)||(l.y==7&&block(b+vec3i(0,1,1))!=0u)){c*=0.72;}}case 2u:{c=c3(0x8a5a34u)*select(1.,0.8,r<.25);}case 3u:{c=c3(0xd6c983u)*select(1.,0.92,r<.2);}case 4u:{c=c3(0x959e9eu)*select(1.,0.86,r<.3);if(r>.95){c*=1.1;}}case 5u:{c=select(c3(0xebe7dcu),c3(0x3b3b3bu),r<.2);}case 6u:{c=select(select(c3(0x86b83au),c3(0xa6d24eu),r>.88),c3(0x5f9029u),r<.22);}case 7u:{let vv=l.x;let uu=l.y;let row=(vv >> 2u)+b.z*2;c=c3(0xb8915au)*(0.93+0.1*h2(vec2i(row,b.x*7+b.y)));if((vv&3)==3||uu==((row*5+b.x+b.y)&7)){c*=0.72;}else if(r<.12){c*=0.9;}}case 8u:{c=select(c3(0x7a5230u),c3(0x5c3c22u),((l.x+l.z)&1)==1);if(l.z>=5){let f=h3(vec3i(l.x,l.y,l.z+i32(U[0].z*12.)));c=select(select(c3(0xff9a2eu),c3(0xffd65cu),f>0.45),c3(0xfff3c0u),l.z==6&&f>0.75);}}case 10u:{c=c3(0x2b3a8cu);}case 11u:{c=c3(0x3fa9c9u);}case 12u:{c=c3(0xe0a878u);}case 13u:{c=c3(0x4a3020u);}case 14u:{c=c3(0x1a1a2au);}case 16u:{c=c3(0xc8443au);}case 17u:{c=c3(0x4fae4au);}case 18u:{c=c3(0xe0b83au);}case 19u:{c=c3(0x9a52c8u);}default:{c=c3(0x2a2a2au);}}return c;}fn player(t:vec3i,P:vec4f,F4:vec4f,sh:u32)->u32{let dz=t.z-i32(floor(P.z*S+0.01));if(dz<0||dz>14){return 0u;}let d=vec2f(t.xy)+0.5-P.xy*S;if(dot(d,d)>20.){return 0u;}let f=F4.xy;let v=dot(d,f);let u=dot(d,vec2f(f.y,-f.x));let iu=i32(floor(u+0.5));let iv=i32(floor(v+0.5));let sw=i32(round(sin(F4.z)*1.6*F4.w));if(dz<=4){let m=select(10u,15u,dz==0);if((iu==-1||iu==-2)&&(iv-sw==-1||iv-sw==0)){return m;}if((iu==0||iu==1)&&(iv+sw==-1||iv+sw==0)){return m;}return 0u;}if(dz<=9){if(iu>=-2&&iu<=1&&(iv==-1||iv==0)){return sh;}if(dz>=5&&((iu==-3&&(iv+sw==-1||iv+sw==0))||(iu==2&&(iv-sw==-1||iv-sw==0)))){return select(sh,12u,dz==5);}return 0u;}if(iu>=-2&&iu<=1&&iv>=-2&&iv<=1){if(dz>=13||iv==-2||(dz==12&&(iu==-2||iu==1)&&iv<1)){return 13u;}if(iv==1&&dz==11&&(iu==-2||iu==1)){return 14u;}return 12u;}return 0u;}fn hshadow(b:vec3i)->bool{for(var i=1;i<=10;i++){let t=f32(i);let x=i32(floor(f32(b.x)+0.5+SUN.x/SUN.z*t));let y=i32(floor(f32(b.y)+0.5+SUN.y/SUN.z*t));if(height(vec2i(x,y))>b.z+i){return true;}}return false;}fn fog(col:vec3f,wp:vec3f)->vec3f{let z=dot(wp-U[1].xyz,U[2].xyz);let far=U[2].w;return mix(col,FOG,U[1].w*smoothstep(far*U[21].x,far,z));}fn outline(col:vec3f,cell:vec3i,p:vec3f,id:u32)->vec3f{if(U[8].w<0.5||id>=10u||any(cell!=vec3i(U[8].xyz))){return col;}let f=p-vec3f(cell);let e=min(min(f.x,1.-f.x),min(f.y,1.-f.y));if(e<0.07){return vec3f(0.07,0.07,0.1);}return mix(col,vec3f(1.),0.18);}@fragment fn fs(v:V)->@location(0)vec4f{let k=u32(v.kind+0.5);if(k==1u){let c=vec2i(floor(v.wp.xy));if(f32(height(c))>=ZW){discard;}let d=clamp((ZW-f32(height(c)))/4.,0.,1.);var col=mix(vec3f(0.28,0.62,0.66),vec3f(0.08,0.22,0.38),d);if(h2(c)>0.92){col=mix(col,vec3f(0.85,0.95,1.),0.35);}return vec4f(fog(col,v.wp),0.62);}if(k>=2u){let s=k-2u;let idx=select(0u,s-1u,s>0u);let P=select(U[5],U[22u+2u*idx],s>0u);let F4=select(U[6],U[23u+2u*idx],s>0u);let sh=select(11u,16u+u32(P.w),s>0u);let t=vec3i(floor(v.wp*S));let id=player(t,P,F4,sh);if(id==0u){discard;}return vec4f(fog(matCol(id,t),v.wp),1.);}let cell=vec3i(i32(floor(v.wp.x)),i32(floor(v.wp.y)),i32(round(v.wp.z))-1);var id=block(cell);if(id==0u){discard;}if(id==5u){let e=v.wp.xy-vec2f(cell.xy)-0.5;if(dot(e,e)>TR*TR){discard;}}if(id==6u&&U[4].w>0.5&&!leafHit(v.wp)){discard;}let ht=vec3i(floor(v.wp*S));var col=matCol(id,ht);if(id==6u&&U[4].w>0.5){col=select(c3(0x86b83au),c3(0x6fa233u),h3(ht)<0.3);}var lit=1.;let l=ht&vec3i(7);if((l.x==7&&block(cell+vec3i(1,0,0))==0u)||(l.y==0&&block(cell+vec3i(0,-1,0))==0u)){lit=0.86;}if((l.x==0&&block(cell-vec3i(1,0,0))==0u)||(l.y==7&&block(cell+vec3i(0,1,0))==0u)){lit=1.12;}col*=lit;if(hshadow(cell)){col*=vec3f(0.58,0.64,0.8);}if(id==8u&&(ht.z&7)>=5){col=matCol(id,ht);}col=outline(col,cell,v.wp,id);return vec4f(fog(col,v.wp),1.);}`;
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
