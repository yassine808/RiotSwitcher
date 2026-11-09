/* ---------- config: change these in one place ---------- */
const CONFIG = {
  feed: "https://pub-6d3d6d22222242dab87967c474f39ada.r2.dev", // public R2 bucket: riotswitcher-updates
  paypal: "https://paypal.me/yassinemagri",
};

/* ---------- download links always point at the newest build ---------- */
(async function links() {
  document.querySelectorAll("[data-paypal]").forEach((a) => (a.href = CONFIG.paypal));
  const set = (d) => {
    document.querySelectorAll("[data-dl=setup]").forEach((a) => (a.href = d.setup));
    document.querySelectorAll("[data-dl=portable]").forEach((a) => (a.href = d.portable));
    document.querySelectorAll("[data-version]").forEach((el) => (el.textContent = "v" + d.version));
  };
  const parse = (yml) => {
    const version = (yml.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1];
    const path = (yml.match(/^path:\s*['"]?([^'"\n]+?)['"]?\s*$/m) || [])[1];
    if (!version) throw new Error("no version");
    return { version, setup: `${CONFIG.feed}/${path || `RiotSwitcher-Setup-${version}.exe`}`, portable: `${CONFIG.feed}/RiotSwitcher-${version}-portable.exe` };
  };
  try { // 1) the Pages Function, 2) the bucket directly. If both fail the /download/* redirect links still work.
    const r = await fetch("/api/latest"); if (!r.ok) throw 0; set(await r.json());
  } catch {
    try { const r = await fetch(CONFIG.feed + "/latest.yml"); set(parse(await r.text())); } catch { /* keep fallbacks */ }
  }
})();

/* ---------- ambient sound: soft generative night-drive music (synthesized, no audio files) ---------- */
const Amb = (() => {
  let ctx, master, bus, on = false, timer = null, step = 0;
  const KEY = "rs-sound";
  const btn = document.querySelector(".snd");
  const paint = () => { if (btn) { btn.setAttribute("aria-pressed", on); btn.querySelector("b").textContent = on ? "Sound on" : "Sound off"; } };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // slow four-chord loop (Am9 - Fmaj7 - Cmaj7 - Gsus), each chord lasts one bar
  const BAR = 6.4;
  const CHORDS = [
    { bass: 45, pad: [57, 60, 64, 67, 71], arp: [69, 72, 76, 79, 83] },
    { bass: 41, pad: [53, 57, 60, 64, 67], arp: [65, 69, 72, 76, 81] },
    { bass: 48, pad: [55, 59, 64, 67, 71], arp: [67, 71, 72, 76, 79] },
    { bass: 43, pad: [55, 57, 62, 67, 71], arp: [62, 67, 69, 71, 74] },
  ];
  function reverbIR(sec = 3.6) {
    const len = ctx.sampleRate * sec, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    return ir;
  }
  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3;
    master.connect(comp); comp.connect(ctx.destination);
    bus = ctx.createGain(); bus.gain.value = 1;
    const dry = ctx.createGain(); dry.gain.value = 0.75;
    const conv = ctx.createConvolver(); conv.buffer = reverbIR();
    const wet = ctx.createGain(); wet.gain.value = 0.55;
    const dly = ctx.createDelay(1); dly.delayTime.value = 0.46;
    const fb = ctx.createGain(); fb.gain.value = 0.34;
    const dlp = ctx.createBiquadFilter(); dlp.type = "lowpass"; dlp.frequency.value = 1800;
    bus.connect(dry); dry.connect(master);
    bus.connect(conv); conv.connect(wet); wet.connect(master);
    bus.connect(dly); dly.connect(dlp); dlp.connect(fb); fb.connect(dly); dlp.connect(wet);
    // faint vinyl-style hiss for warmth
    const len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() > 0.9985 ? 0.9 : 0.06);
    const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2500;
    const ng = ctx.createGain(); ng.gain.value = 0.05; n.connect(hp); hp.connect(ng); ng.connect(master); n.start();
  }
  function pad(t, notes) {
    notes.forEach((m, i) => {
      [-6, 6].forEach((det) => {
        const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = hz(m); o.detune.value = det + i;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1300, t + BAR * 0.5); lp.frequency.linearRampToValueAtTime(450, t + BAR);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.022, t + 1.6); g.gain.linearRampToValueAtTime(0.0001, t + BAR + 1.2);
        o.connect(lp); lp.connect(g); g.connect(bus); o.start(t); o.stop(t + BAR + 1.4);
      });
    });
  }
  function bass(t, m) {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = hz(m);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + BAR - 0.2);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + BAR);
  }
  function pluck(t, m, vel = 0.05) {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = hz(m);
    const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = hz(m) * 2; // soft bell overtone
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(bus); o.start(t); o2.start(t); o.stop(t + 2.3); o2.stop(t + 2.3);
  }
  function kick(t) {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.3);
  }
  function bar(t) {
    const c = CHORDS[step % CHORDS.length]; step++;
    pad(t, c.pad); bass(t, c.bass);
    const q = BAR / 8;
    for (let k = 0; k < 8; k++) {
      if (k % 4 === 0) kick(t + k * q);
      if (Math.random() < 0.72) pluck(t + k * q + (k % 2 ? 0.035 : 0), c.arp[Math.floor(Math.random() * c.arp.length)], 0.03 + Math.random() * 0.03);
    }
  }
  function schedule() {
    let next = ctx.currentTime + 0.1;
    const tick = () => { while (next < ctx.currentTime + BAR) { bar(next); next += BAR; } };
    tick(); timer = setInterval(tick, 1000);
  }
  async function set(v, save = true) {
    on = v; if (save) { try { localStorage.setItem(KEY, v ? "on" : "off"); } catch {} }
    if (on) {
      if (!ctx) { build(); schedule(); }
      await ctx.resume();
      master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 3);
    } else if (ctx) { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8); }
    paint();
  }
  const pref = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  paint();
  btn?.addEventListener("click", (e) => { e.stopPropagation(); set(!on); });
  // Browsers block autoplay, so the sound starts with the first click or key press unless the visitor muted it.
  if (pref !== "off") {
    const first = () => { removeEventListener("pointerdown", first); removeEventListener("keydown", first); removeEventListener("rs-interact", first); if (!on) set(true, false); };
    addEventListener("pointerdown", first); addEventListener("keydown", first); addEventListener("rs-interact", first);
  }
  return { blip(f = 660) { if (!on || !ctx) return; const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25); } };
})();
