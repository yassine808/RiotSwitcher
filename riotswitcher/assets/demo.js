/* Interactive demo with dummy accounts. Nothing here touches a real account. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const accounts = [
    { id: 1, name: "Nova#EUW", card: "Reyna", rank: "Platinum 1 · 51 RR", color: "#4fd1c5", w: 36, l: 59 },
    { id: 2, name: "Pixel#0001", card: "Jett", rank: "Gold 1 · 54 RR", color: "#c8aa6e", w: 16, l: 17 },
    { id: 3, name: "Quiet#2468", card: "Sage", rank: "Immortal 1 · 120 RR", color: "#ff5f7a", w: 88, l: 61 },
  ];
  const spare = { name: "Ember#7710", card: "Omen", rank: "Unranked", color: "#9aa4b4", w: 0, l: 0 };
  let running = null, busy = false, added = false;

  const row = $("#row"), status = $("#status"), count = $("#count"), addBtn = $("#add"), bg = $("#bgimg");
  const say = (t, b) => { status.className = "status" + (b ? " busy" : ""); $("#stxt").textContent = t; };
  const art = (c) => `cards/${c}.webp`;
  const setBg = (c) => { bg.classList.add("off"); setTimeout(() => { bg.src = art(c); bg.classList.remove("off"); }, 500); };

  function render() {
    count.textContent = accounts.length;
    addBtn.disabled = added;
    row.innerHTML = accounts.map((a) => {
      const isRun = running === a.id;
      return `<div class="pc${isRun ? " run" : ""}">
        <div class="art" style="background-image:url(${art(a.card)})"><div class="meta"><b>${isRun ? "RUNNING" : "READY"}</b><span class="plate">${a.name}</span><div class="rk" style="color:${a.color}">${a.rank}</div>${a.w + a.l ? `<div class="wl"><i>${a.w}W</i><u>${a.l}L</u></div>` : ""}</div></div>
        <button class="go${busy ? " busy" : ""}" data-id="${a.id}" ${busy || isRun ? "disabled" : ""}>${isRun ? "RUNNING" : "START"}</button></div>`;
    }).join("");
  }

  async function launch(id) {
    const a = accounts.find((x) => x.id === id);
    busy = true; render(); Amb.blip(520);
    const steps = running ? ["Closing the Riot Client", "Saving the current session", `Restoring ${a.name}`, "Launching the Riot Client"] : [`Restoring ${a.name}`, "Launching the Riot Client"];
    for (const s of steps) { say(s + "…", true); await new Promise((r) => setTimeout(r, 650)); }
    busy = false; running = id; render(); setBg(a.card); Amb.blip(880);
    say(`${a.name} is signed in. The game was never touched.`);
  }

  row.addEventListener("click", (e) => { const b = e.target.closest(".go"); if (b && !busy) launch(+b.dataset.id); });

  // tabs
  document.querySelectorAll(".tabs button").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === t));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === t.dataset.view));
    Amb.blip(600);
  }));

  // add account
  const modal = $("#modal");
  addBtn.addEventListener("click", () => { modal.classList.add("on"); Amb.blip(600); });
  $("#cancel").addEventListener("click", () => modal.classList.remove("on"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("on"); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") modal.classList.remove("on"); });
  $("#capture").addEventListener("click", () => {
    modal.classList.remove("on"); added = true; accounts.push({ id: 4, ...spare }); render(); Amb.blip(760);
    say("Ember#7710 added. Its login is saved on this PC.");
  });

  document.querySelectorAll(".sw[data-snd]").forEach((s) => s.addEventListener("change", () => Amb.blip(700)));
  render();
})();
