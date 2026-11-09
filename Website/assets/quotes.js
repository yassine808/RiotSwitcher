/* Rotating quotes: words leave right-to-left (blur, fade, drift up), next quote rises from below. */
(() => {
  const box = document.getElementById("quote");
  if (!box) return;
  const QUOTES = [
    "No passwords. No logging out.",
    "One click. Another account.",
    "Your smurf is waiting.",
    "Switch fast. Queue faster.",
    "Stay signed in, everywhere.",
    "Main, alt, smurf. All one tap away.",
    "Never type a password again.",
    "Built by a player, for players.",
  ];
  const HOLD = 2800;           // how long a quote stays fully visible
  const STEP = 70;             // delay between words
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let i = -1, cur = null;

  function make(text) {
    const q = document.createElement("div");
    q.className = "q";
    q.setAttribute("aria-label", text);
    text.split(" ").forEach((w) => { const s = document.createElement("span"); s.className = "w"; s.setAttribute("aria-hidden", "true"); s.textContent = w; q.appendChild(s); });
    return q;
  }
  // delay each word so the motion sweeps from the right edge toward the left
  function sweep(q) { const w = q.querySelectorAll(".w"), n = w.length; w.forEach((s, k) => (s.style.transitionDelay = (n - 1 - k) * STEP + "ms")); return n * STEP; }

  function next() {
    i = (i + 1) % QUOTES.length;
    const old = cur, q = make(QUOTES[i]);
    box.appendChild(q); cur = q;
    if (old) { sweep(old); old.classList.remove("in"); old.classList.add("out"); setTimeout(() => old.remove(), 1500 + old.children.length * STEP); }
    sweep(q);
    requestAnimationFrame(() => requestAnimationFrame(() => q.classList.add("in")));
  }
  if (reduce) { box.textContent = QUOTES[0]; return; }
  next();
  setInterval(next, HOLD + 700);
})();
