// Render the tuner page in jsdom against the live /api/cards payload and check
// what the labels/ids refactor and the drag split touched: every control is
// labelled, ids are unique per card, the card count still matches, and a body
// drag / grip drag move the placement by the expected amount.
const fs = require("fs");
const { JSDOM } = require("jsdom");

const BASE = "http://127.0.0.1:8791";

function fakeCtx() {
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, drawImage: noop, save: noop, restore: noop,
    translate: noop, rotate: noop, beginPath: noop, rect: noop, fill: noop, stroke: noop,
    strokeRect: noop, setLineDash: noop, moveTo: noop, lineTo: noop,
    globalCompositeOperation: "source-over", globalAlpha: 1,
    fillStyle: "", strokeStyle: "", lineWidth: 1,
  };
}

(async () => {
  const payload = await (await fetch(`${BASE}/api/cards`)).json();
  const html = fs.readFileSync("tools/cards/tuner/index.html", "utf8");

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: `${BASE}/`,
    beforeParse(window) {
      window.fetch = async () => ({ ok: true, json: async () => payload, status: 200 });
      window.IntersectionObserver = class {
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
          setTimeout(() => this.cb([{ isIntersecting: true }], this), 0);
        }
        disconnect() {}
      };
      let frames = 0; window.requestAnimationFrame = (cb) => { if (frames++ < 80) setTimeout(cb, 0); return frames; };
      window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
      window.Image = class {
        set src(value) {
          this._src = value;
          this.naturalWidth = 1024;
          this.naturalHeight = 1024;
          setTimeout(() => this.onload && this.onload(), 0);
        }
      };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  const doc = dom.window.document;
  const cards = doc.querySelectorAll(".card");
  console.log("cards rendered:", cards.length, "expected:", payload.cards.length);

  const problems = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll("[id]")) {
    if (seen.has(el.id)) problems.push(`duplicate id ${el.id}`);
    seen.add(el.id);
  }
  for (const input of doc.querySelectorAll(".controls input")) {
    if (input.labels.length !== 1) {
      problems.push(`input ${input.className || input.type} has ${input.labels.length} labels`);
    }
  }
  console.log("ids unique:", seen.size === doc.querySelectorAll("[id]").length);
  console.log("problems:", problems.length ? problems : "none");
  console.log("load state:", doc.getElementById("loadState").textContent);

  const canvas = doc.querySelector(".card canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 268, height: 640, right: 268, bottom: 640 });
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  const read = (sel) => Number(doc.querySelector(`.card .${sel}`).value);
  const pointer = (type, x, y) =>
    canvas.dispatchEvent(
      new dom.window.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );

  // 1) body drag: the card follows the pointer 1:1.
  const beforeMove = { cx: read("cx"), cy: read("cy") };
  pointer("pointerdown", 134, 320);
  pointer("pointermove", 154, 330);
  pointer("pointerup", 154, 330);
  const afterMove = { cx: read("cx"), cy: read("cy") };
  console.log("move drag delta", (afterMove.cx - beforeMove.cx).toFixed(1), (afterMove.cy - beforeMove.cy).toFixed(1));

  // 2) east grip: width follows the pointer, the west edge stays put.
  const w0 = read("w");
  const cx0 = read("cx");
  const cy0 = read("cy");
  const west0 = cx0 - w0 / 2;
  pointer("pointerdown", cx0 + w0 / 2, cy0);
  pointer("pointermove", cx0 + w0 / 2 + 20, cy0);
  pointer("pointerup", cx0 + w0 / 2 + 20, cy0);
  const w1 = read("w");
  const cx1 = read("cx");
  console.log("east grip: w", w0.toFixed(1), "->", w1.toFixed(1), "| west edge", west0.toFixed(1), "->", (cx1 - w1 / 2).toFixed(1));

  dom.window.close();
})();
