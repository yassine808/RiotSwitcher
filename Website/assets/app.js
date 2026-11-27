/* ---------- config: change these in one place ---------- */
const CONFIG = {
  // Flat view of the newest GitHub release: latest.yml, Setup and portable.
  feed: "https://github.com/yassine808/RiotSwitcher/releases/latest/download",
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
    const url = (name) => (/^https?:\/\//.test(name) ? name : `${CONFIG.feed}/${name}`);
    return { version, setup: url(path || `RiotSwitcher-Setup-${version}.exe`), portable: url(`RiotSwitcher-${version}-portable.exe`) };
  };
  try { // 1) the Pages Function, 2) the release directly. If both fail the /download/* redirect links still work.
    const r = await fetch("/api/latest"); if (!r.ok) throw 0; set(await r.json());
  } catch {
    try { const r = await fetch(CONFIG.feed + "/latest.yml"); set(parse(await r.text())); } catch { /* keep fallbacks */ }
  }
})().catch(() => {});

/* ---------- background: a slow, tilted wall of agent cards ---------- */
(() => {
  const wall = document.getElementById("wall"); if (!wall) return;
  const names = "Jett Reyna Omen Sage Neon Fade Astra Breach Brimstone Chamber Clove Cypher Deadlock Gekko Harbor Hush Iso KAYO Killjoy Miks Phoenix Raze Skye Sova Tejo Veto Viper Vyse Waylay Yoru".split(" ");
  const COLS = 11, PER = 5;
  for (let c = 0; c < COLS; c++) {
    const col = document.createElement("div"); col.className = "col";
    const track = document.createElement("div"); track.className = "track";
    track.style.setProperty("--dur", 110 + ((c * 37) % 60) + "s");
    track.style.animationDelay = "-" + ((c * 29) % 90) + "s";
    const set = Array.from({ length: PER }, (_, i) => names[(c * 7 + i * 4) % names.length]);
    [...set, ...set].forEach((n) => { const im = new Image(); im.src = `bg/${n}.webp`; im.alt = ""; im.decoding = "async"; track.append(im); });
    col.append(track); wall.append(col);
  }
})();

/* ---------- word-by-word text: sweeps in from the left, fades out blurred and upward ---------- */
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function Swipe(host, texts, { hold = 2300, loop = true, onEnd } = {}) {
  let i = 0, cur, timer, stopped = false;
  const make = (text) => {
    const q = document.createElement("span"); q.className = "q in";
    const words = text.split(" ");
    words.forEach((w, k) => {
      const s = document.createElement("span"); s.className = "w"; s.textContent = w;
      s.style.setProperty("--i", k); // the leftmost word moves first, the sweep travels right
      q.append(s); if (k < words.length - 1) q.append(" ");
    });
    return q;
  };
  const show = () => { if (stopped) return; cur = make(texts[i]); host.replaceChildren(cur); timer = setTimeout(hide, reduceMotion ? 3500 : hold); };
  const hide = () => {
    if (stopped) return;
    const next = () => { i++; if (i >= texts.length) { if (!loop) { onEnd && onEnd(); return; } i = 0; } show(); };
    if (reduceMotion) return next();
    cur.className = "q out";
    timer = setTimeout(next, 600 + (cur.querySelectorAll(".w").length - 1) * 45 + 90);
  };
  return { start: show, stop() { stopped = true; clearTimeout(timer); } };
}

/* ---------- rotating quotes under the header ---------- */
const Quotes = (() => {
  const host = document.getElementById("quote"); if (!host) return { start() {} };
  return Swipe(host, [
    "Switch accounts. Skip the password.",
    "One click. Already signed in.",
    "Your logins stay on your PC.",
    "Less typing. More playing.",
    "Encrypted. Local. Yours.",
    "No more logging out.",
    "Only the Riot Client. Never the game.",
    "Every account, one click away.",
    "Free. Open source. Built for players.",
    "Queue faster. Switch smarter.",
  ]);
})();

/* ---------- intro: a few lines first, then the app is revealed ---------- */
(() => {
  const intro = document.getElementById("intro"), root = document.documentElement;
  if (!intro || !root.classList.contains("intro-on")) { Quotes.start(); return; }
  let done = false, seq;
  const finish = () => {
    if (done) return; done = true; seq.stop();
    try { sessionStorage.setItem("rs-intro", "1"); } catch {}
    intro.classList.add("leaving"); root.classList.remove("intro-on");
    setTimeout(() => { intro.remove(); Quotes.start(); }, 900);
  };
  seq = Swipe(document.getElementById("introline"), [
    "Tired of switching VALORANT accounts?",
    "Logging out. Typing passwords. Again and again.",
    "There is a faster way.",
  ], { hold: 2500, loop: false, onEnd: finish });
  seq.start();
  intro.addEventListener("click", () => { dispatchEvent(new Event("rs-interact")); finish(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") finish(); });
})();

/* ---------- support popup: shown right after Download (the download starts at once) or from "Support me" ---------- */
const Support = (() => {
  const AMOUNTS = [["3", "Coffee"], ["5", "Thank you"], ["10", "Legend"], ["", "Other"]];
  const el = document.createElement("div");
  el.className = "modal"; el.hidden = true;
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sup-title">
      <button class="mx" aria-label="Close">&times;</button>
      <div class="dlnote"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>Your download is starting.</span><a class="retry" href="#">Not starting? Click here</a></div>
      <div class="heartbig" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.3-9.4C1.5 8.3 3.4 5 6.6 5c2 0 3.6 1.1 5.4 3.2C13.8 6.1 15.4 5 17.4 5c3.2 0 5.100 3.300 3.900 6.600C19.500 16.400 12 21 12 21z"/></svg></div>
      <h2 id="sup-title">Enjoying RiotSwitcher?</h2>
      <p class="sub">It is free and made by one person. If it saves you time, a small tip keeps it updated and free for everyone.</p>
      <div class="tips" role="group" aria-label="Tip amount">${AMOUNTS.map(([v, l]) => `<button type="button" class="tip" data-amt="${v}" aria-pressed="false"><b>${v ? "$" + v : "Any"}</b><small>${l}</small></button>`).join("")}</div>
      <a class="pp" href="#" target="_blank" rel="noopener"><img class="ppl" src="assets/paypal.svg" alt="" onerror="this.remove()"><span>Tip with PayPal</span></a>
      <button type="button" class="nothanks">Maybe later</button>
    </div>`;
  document.body.append(el);
  const pp = el.querySelector(".pp"), retry = el.querySelector(".retry"), tips = [...el.querySelectorAll(".tip")];
  let amt = "5", lastFocus = null;
  const paint = () => { tips.forEach((t) => t.setAttribute("aria-pressed", t.dataset.amt === amt)); pp.href = CONFIG.paypal + (amt ? `/${amt}USD` : ""); };
  tips.forEach((t) => t.addEventListener("click", () => { amt = t.dataset.amt; paint(); }));
  const close = () => { el.classList.remove("open"); setTimeout(() => (el.hidden = true), 250); lastFocus?.focus?.(); };
  function open(mode, dlUrl) {
    lastFocus = document.activeElement; paint();
    el.classList.toggle("dl", mode === "download");
    if (dlUrl) retry.href = dlUrl;
    el.hidden = false; requestAnimationFrame(() => el.classList.add("open")); pp.focus({ preventScroll: true });
  }
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest(".mx,.nothanks")) close(); });
  retry.addEventListener("click", (e) => { e.preventDefault(); startDownload(retry.href); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) close(); });
  const startDownload = (url) => { const a = document.createElement("a"); a.href = url; a.rel = "noopener"; a.download = ""; a.style.display = "none"; document.body.append(a); a.click(); a.remove(); };
  document.addEventListener("click", (e) => {
    const dl = e.target.closest("[data-dl]"), sp = e.target.closest("[data-support]");
    if (dl) { e.preventDefault(); startDownload(dl.href); open("download", dl.href); }
    else if (sp) { e.preventDefault(); open("support"); }
  });
  return { open };
})();

/* ---------- ambient sound: a slow nocturne, generated live (no audio files) ---------- */
const Amb = (() => {
  const KEY = "rs-sound";
  const btn = document.querySelector(".snd");
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // Am9 > Fmaj7 > Cmaj9 > G6/9, eight seconds each
  const CHORDS = [[45, 48, 52, 55, 59], [41, 45, 48, 52, 55], [48, 52, 55, 59, 62], [43, 47, 50, 52, 57]];
  const STEP = 0.46, STEPS_PER_CHORD = 16;

  // Builds the whole instrument on any AudioContext, so it can also be rendered offline for testing.
  function makeEngine(ctx) {
    const rand = rng(7);
    const master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 24; comp.ratio.value = 3; comp.attack.value = 0.03; comp.release.value = 0.5;
    master.connect(comp); comp.connect(ctx.destination);

    // reverb: generated impulse response, 4.5 s tail
    const irLen = Math.floor(ctx.sampleRate * 4.5), ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < irLen; i++) { lp += 0.35 * ((rand() * 2 - 1) - lp); d[i] = lp * Math.pow(1 - i / irLen, 2.8); } }
    const rev = ctx.createConvolver(); rev.buffer = ir;
    const revIn = ctx.createGain(); revIn.gain.value = 0.8;
    const revOut = ctx.createGain(); revOut.gain.value = 0.7;
    revIn.connect(rev); rev.connect(revOut); revOut.connect(master);

    // dotted echo that matches the pluck grid
    const dl = ctx.createDelay(2); dl.delayTime.value = STEP * 1.5;
    const fb = ctx.createGain(); fb.gain.value = 0.36;
    const dlp = ctx.createBiquadFilter(); dlp.type = "lowpass"; dlp.frequency.value = 2400;
    const dlOut = ctx.createGain(); dlOut.gain.value = 0.5;
    dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(dlOut); dlOut.connect(master); dlOut.connect(revIn);

    const padBus = ctx.createGain(); padBus.gain.value = 1; padBus.connect(master); padBus.connect(revIn);
    const pluckBus = ctx.createGain(); pluckBus.gain.value = 1; pluckBus.connect(master); pluckBus.connect(dl); pluckBus.connect(revIn);

    // warm movement: a very slow filter sweep shared by the pad
    const padLP = ctx.createBiquadFilter(); padLP.type = "lowpass"; padLP.frequency.value = 900; padLP.Q.value = 0.4; padLP.connect(padBus);
    const sweep = ctx.createOscillator(), sweepG = ctx.createGain(); sweep.frequency.value = 0.045; sweepG.gain.value = 320; sweep.connect(sweepG); sweepG.connect(padLP.frequency); sweep.start();

    function pad(t, chord, dur) {
      chord.forEach((m, k) => {
        [-6, 6].forEach((det) => {
          const o = ctx.createOscillator(); o.type = k === 0 ? "sine" : "triangle"; o.frequency.value = mtof(m); o.detune.value = det + (rand() - 0.5) * 4;
          const g = ctx.createGain(); const peak = k === 0 ? 0.075 : 0.034;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 2.8); g.gain.setValueAtTime(peak, t + dur - 0.5); g.gain.linearRampToValueAtTime(0, t + dur + 3.2);
          o.connect(g); g.connect(padLP); o.start(t); o.stop(t + dur + 3.4);
        });
      });
    }
    function pluck(t, midi, vel) {
      const f = mtof(midi), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.setValueAtTime(3600, t); lp.frequency.exponentialRampToValueAtTime(900, t + 1.4);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      [["sine", 1, 1], ["triangle", 2, 0.25]].forEach(([type, mul, amp]) => {
        const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; o.frequency.value = f * mul; og.gain.value = amp; o.connect(og); og.connect(lp); o.start(t); o.stop(t + 2.5);
      });
      lp.connect(g); g.connect(pluckBus);
    }

    let step = 0, next = ctx.currentTime + 0.15;
    return {
      master,
      // schedule everything that falls before `until` (seconds on ctx time)
      run(until) {
        while (next < until) {
          const ci = Math.floor(step / STEPS_PER_CHORD) % CHORDS.length, within = step % STEPS_PER_CHORD, chord = CHORDS[ci];
          if (within === 0) pad(next, chord, STEPS_PER_CHORD * STEP);
          if (within > 1 && rand() < 0.3) {
            const pool = chord.flatMap((m) => [m + 24, m + 36]).filter((m) => m >= 67 && m <= 88);
            pluck(next, pool[Math.floor(rand() * pool.length)], 0.05 + rand() * 0.04);
          }
          step++; next += STEP;
        }
      },
      reset() { step = 0; next = ctx.currentTime + 0.15; },
    };
  }

  let ctx, eng, timer, on = false;
  const paint = () => { if (btn) { btn.setAttribute("aria-pressed", on); btn.querySelector("b").textContent = on ? "Sound on" : "Sound off"; } };
  async function set(v, save = true) {
    on = v; if (save) { try { localStorage.setItem(KEY, v ? "on" : "off"); } catch {} }
    if (on) {
      if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); eng = makeEngine(ctx); }
      await ctx.resume(); if (!on) return;
      eng.reset(); eng.run(ctx.currentTime + 2); clearInterval(timer); timer = setInterval(() => eng.run(ctx.currentTime + 2), 400);
      eng.master.gain.cancelScheduledValues(ctx.currentTime); eng.master.gain.setValueAtTime(eng.master.gain.value, ctx.currentTime); eng.master.gain.linearRampToValueAtTime(0.38, ctx.currentTime + 3.5);
    } else if (ctx) {
      clearInterval(timer);
      eng.master.gain.cancelScheduledValues(ctx.currentTime); eng.master.gain.setValueAtTime(eng.master.gain.value, ctx.currentTime); eng.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
      setTimeout(() => { if (!on) ctx.suspend(); }, 1000);
    }
    paint();
  }
  const pref = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  paint();
  btn?.addEventListener("click", (e) => { e.stopPropagation(); void set(!on); });
  // Browsers block autoplay, so the sound starts with the first click or key press unless the visitor muted it.
  if (pref !== "off") {
    const first = () => { removeEventListener("pointerdown", first); removeEventListener("keydown", first); removeEventListener("rs-interact", first); if (!on) void set(true, false); };
    addEventListener("pointerdown", first); addEventListener("keydown", first); addEventListener("rs-interact", first);
  }
  return { makeEngine, blip(f = 660) { if (!on || !ctx) return; const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25); } };
})();
