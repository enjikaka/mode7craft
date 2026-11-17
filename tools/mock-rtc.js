// Test-only stand-in for RTCPeerConnection (injected by tools/mp-test.ts when MOCK=1): same API surface the game
// uses (offer/answer, negotiated data channels, gathering/connection states); transport = a CDP binding
// (__mockSend) that the test relays to every tab (__mockRecv), so tabs can sit on different origins/profiles. For sandboxes where WebRTC UDP is blocked by policy; ICE/DTLS/SCTP itself is not exercised.
(() => {
  const bc = { postMessage: (m) => window.__mockSend(JSON.stringify(m)) }, pcs = new Map();
  const later = (f, ms = 0) => setTimeout(f, ms);
  class DC {
    constructor(pc, label, o) { Object.assign(this, { pc, label, id: o.id, ordered: o.ordered !== false, readyState: 'connecting', binaryType: 'blob', onopen: null, onmessage: null, onclose: null }); }
    send(d) {
      if (this.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError');
      const bin = typeof d !== 'string', payload = bin ? Array.from(new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d)) : d;
      const m = { to: this.pc.remote, ch: this.id, bin, payload };
      if (this.ordered) bc.postMessage(m); else later(() => bc.postMessage(m), 15 + Math.random() * 30);   // jitter on the unordered channel
    }
    _open() { if (this.readyState !== 'connecting') return; this.readyState = 'open'; this.onopen?.({}); }
    _close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.({}); }
    close() { this._close(); }
  }
  class PC {
    constructor() { this.token = Math.random().toString(36).slice(2); this.dcs = []; this.signalingState = 'stable'; this.iceGatheringState = 'new'; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.localDescription = this.remoteDescription = null; this.onconnectionstatechange = null; this.l = {}; pcs.set(this.token, this); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    _ev(t) { for (const f of this.l[t] || []) f({}); }
    createDataChannel(label, o = {}) { const d = new DC(this, label, o); this.dcs.push(d); return d; }
    async createOffer() { return { type: 'offer', sdp: `v=0\r\na=mock:${this.token}\r\n` }; }
    async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=mock:${this.token}\r\n` }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; this.iceGatheringState = 'gathering'; later(() => { this.iceGatheringState = 'complete'; this._ev('icegatheringstatechange'); }, 50); this._go(); }
    async setRemoteDescription(d) { this.remoteDescription = d; this.remote = d.sdp.match(/a=mock:(\w+)/)[1]; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; this._go(); }
    _go() { if (this.localDescription && this.remoteDescription && this.signalingState === 'stable') bc.postMessage({ to: this.remote, hello: this.token }); }
    _up() { if (this.connectionState === 'connected') return; this.connectionState = 'connected'; this.onconnectionstatechange?.({}); for (const d of this.dcs) later(() => d._open(), 10); }
    close() { if (this.connectionState === 'closed') return; if (this.remote) bc.postMessage({ to: this.remote, bye: 1 }); this._down(); }
    _down() { this.connectionState = 'closed'; for (const d of this.dcs) d._close(); this.onconnectionstatechange?.({}); pcs.delete(this.token); }
  }
  window.__mockRecv = (s) => {
    const m = JSON.parse(s), pc = pcs.get(m.to); if (!pc) return;
    if (m.hello) { if (pc.remote === m.hello && pc.connectionState !== 'connected') { bc.postMessage({ to: pc.remote, hello: pc.token }); pc._up(); } return; }
    if (m.bye) return pc._down();
    const d = pc.dcs.find((x) => x.id === m.ch); if (!d || d.readyState !== 'open') return;
    d.onmessage?.({ data: m.bin ? new Uint8Array(m.payload).buffer : m.payload });
  };
  window.RTCPeerConnection = PC; window.__mockRTC = true;
})();
