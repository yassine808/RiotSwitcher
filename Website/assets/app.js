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

/* ---------- calm ambient sound (generated, no audio files) ---------- */
const Amb = (() => {
  let ctx, master, on = false;
  const KEY = "rs-sound";
  const btn = document.querySelector(".snd");
  const paint = () => { if (btn) { btn.setAttribute("aria-pressed", on); btn.querySelector("b").textContent = on ? "Sound on" : "Sound off"; } };
  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    // soft brown-noise bed, like distant rain on glass
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; } }
    const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 520;
    const ng = ctx.createGain(); ng.gain.value = 0.55;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 180; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
    n.connect(lp); lp.connect(ng); ng.connect(master); n.start();
    // slow pad: an open Amaj9 chord, each voice drifting in volume
    [110, 164.81, 220, 277.18, 329.63].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.detune.value = (i - 2) * 4;
      const g = ctx.createGain(); g.gain.value = 0.018;
      const l = ctx.createOscillator(), lgn = ctx.createGain(); l.frequency.value = 0.03 + i * 0.011; lgn.gain.value = 0.012; l.connect(lgn); lgn.connect(g.gain); l.start();
      o.connect(g); g.connect(master); o.start();
    });
  }
  async function set(v, save = true) {
    on = v; if (save) localStorage.setItem(KEY, v ? "on" : "off");
    if (on) { if (!ctx) build(); await ctx.resume(); master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 3); }
    else if (ctx) { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8); }
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
