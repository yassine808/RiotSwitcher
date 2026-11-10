(() => {
  const box = document.getElementById("demo"), f = document.getElementById("app"), glow = document.getElementById("glowimg");
  const fit = () => { f.style.transform = `scale(${box.clientWidth / 1100})`; };
  new ResizeObserver(fit).observe(box); fit();
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow || !e.data) return;
    if (e.data.rs === "interact") window.dispatchEvent(new Event("rs-interact"));
    if (e.data.rs === "card" && glow && e.data.src) { // the live account's card lights the page
      const m = String(e.data.src).match(/cards\/([A-Za-z]+)/);
      const src = m ? `bg/${m[1]}.webp` : e.data.src;
      glow.classList.add("off"); setTimeout(() => { glow.src = src; glow.classList.remove("off"); }, 500);
    }
  });
})();

// dim the card wall a little once the visitor scrolls down to the FAQ
addEventListener("scroll", () => document.body.classList.toggle("past", scrollY > innerHeight * 0.35), { passive: true });
