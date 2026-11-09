(() => {
  const box = document.getElementById("demo"), f = document.getElementById("app"), bg = document.getElementById("bgimg");
  const fit = () => { f.style.transform = `scale(${box.clientWidth / 1100})`; };
  new ResizeObserver(fit).observe(box); fit();
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow || !e.data) return;
    if (e.data.rs === "interact") window.dispatchEvent(new Event("rs-interact"));
    if (e.data.rs === "card" && bg && e.data.src) { // the live account's card tints the page background
      bg.classList.add("off"); setTimeout(() => { bg.src = e.data.src.startsWith("data:") ? e.data.src : "demo/" + e.data.src.replace(/^.*\/(cards\/)/, "$1"); bg.classList.remove("off"); }, 500);
    }
  });
})();
