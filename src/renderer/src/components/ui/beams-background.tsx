import { useEffect, useRef } from "react";
import { useAppActive } from "../../hooks/appActiveContext";

interface BeamsBackgroundProps {
  className?: string;
  intensity?: "subtle" | "medium" | "strong";
}

interface Beam {
  x: number;
  y: number;
  width: number;
  length: number;
  angle: number;
  speed: number;
  opacity: number;
  hueOffset: number; // spread around the theme hue
  pulse: number;
  pulseSpeed: number;
  sprite: HTMLCanvasElement | null;
}

const OPACITY = { subtle: 0.7, medium: 0.85, strong: 1 } as const;
const BEAM_COUNT = 30;
const SCALE = 0.5; // render at half resolution: far cheaper blur, looks the same
// Global drift multiplier. 1 was the original pace; 0.5 halves both the travel
// speed and the brightness pulse so the background light moves calmly.
const SPEED = 0.5;
const BLUR_PX = 18;
// Blur spreads this far past the beam's own box; the sprite needs the margin or
// the soft edge gets clipped.
const SPRITE_PAD = BLUR_PX * 2;
// The beams are slow, wide and already blurred, so a 30 Hz redraw is visually
// identical to 60 Hz. Motion is time-based, not frame-based, so the speed does
// not change. This halves canvas work and GPU uploads.
const FRAME_MS = 1000 / 30;
const HUE_REFRESH_FRAMES = 20;

function createBeam(w: number, h: number): Beam {
  return {
    x: Math.random() * w * 1.5 - w * 0.25,
    y: Math.random() * h * 1.5 - h * 0.25,
    width: 30 + Math.random() * 60,
    length: h * 2.5,
    angle: -35 + Math.random() * 10,
    speed: 0.6 + Math.random() * 1.2,
    opacity: 0.12 + Math.random() * 0.16,
    hueOffset: (Math.random() - 0.5) * 50,
    pulse: Math.random() * Math.PI * 2,
    pulseSpeed: 0.02 + Math.random() * 0.03,
    sprite: null,
  };
}

/** Hue (0-360) of the current theme glow, e.g. "rgb(58, 118, 235)" -> ~220 (Ocean blue). */
function glowHue(): number {
  const m = getComputedStyle(document.documentElement).getPropertyValue("--glow").match(/\d+/g);
  if (!m || m.length < 3) return 220;
  const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 220;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/**
 * Bake one beam (gradient + blur) into a small offscreen canvas.
 *
 * The old renderer set `ctx.filter = "blur(18px)"` and redrew 30 gradients on
 * every animation frame. Chromium allocated a blur surface for each of those
 * frames, which is what pushed the GPU process into the hundreds of MB. The
 * beam's shape never changes, only its position and brightness, so the blur is
 * baked once here and each frame becomes 30 `drawImage` calls.
 */
function bakeBeam(beam: Beam, hue: number, intensity: BeamsBackgroundProps["intensity"]): HTMLCanvasElement | null {
  const sprite = document.createElement("canvas");
  sprite.width = Math.ceil(beam.width + SPRITE_PAD * 2);
  sprite.height = Math.ceil(beam.length + SPRITE_PAD * 2);
  const sctx = sprite.getContext("2d");
  if (!sctx) return null;

  const o = beam.opacity * OPACITY[intensity ?? "strong"];
  const c = `hsla(${hue + beam.hueOffset}, 85%, 65%,`;
  const g = sctx.createLinearGradient(0, SPRITE_PAD, 0, SPRITE_PAD + beam.length);
  g.addColorStop(0, `${c} 0)`);
  g.addColorStop(0.1, `${c} ${o * 0.5})`);
  g.addColorStop(0.4, `${c} ${o})`);
  g.addColorStop(0.6, `${c} ${o})`);
  g.addColorStop(0.9, `${c} ${o * 0.5})`);
  g.addColorStop(1, `${c} 0)`);
  sctx.filter = `blur(${BLUR_PX}px)`;
  sctx.fillStyle = g;
  sctx.fillRect(SPRITE_PAD, SPRITE_PAD, beam.width, beam.length);
  return sprite;
}

/** Animated light beams that follow the theme colour. Sits behind the app. */
export function BeamsBackground({ className = "", intensity = "strong" }: Readonly<BeamsBackgroundProps>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = useAppActive();
  // Survive pause/resume and resize without scattering the light pattern. The
  // old code rebuilt every beam on each resize, which looked like a restart.
  const scene = useRef({ w: 0, h: 0, beams: [] as Beam[] });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let { w, h, beams } = scene.current;
    let hue = glowHue();
    let frame = 0;
    let raf = 0;
    let lastDraw = 0;

    const bakeAll = () => {
      for (const beam of beams) beam.sprite = bakeBeam(beam, hue, intensity);
    };

    const resize = () => {
      const nextW = Math.max(1, Math.round(window.innerWidth * SCALE));
      const nextH = Math.max(1, Math.round(window.innerHeight * SCALE));
      if (beams.length === 0) {
        beams = Array.from({ length: BEAM_COUNT }, () => createBeam(nextW, nextH));
      } else {
        // Keep each beam's relative position, thickness and speed. Rebuilding
        // them here made every resize flash a brand-new background.
        const sx = nextW / w;
        const sy = nextH / h;
        for (const beam of beams) {
          beam.x *= sx;
          beam.y *= sy;
          beam.width *= sx;
          beam.length *= sy;
          beam.speed *= sy;
        }
      }
      w = nextW;
      h = nextH;
      scene.current = { w, h, beams };
      canvas.width = w;
      canvas.height = h;
      bakeAll();
      // Resizing a canvas clears it. Draw the preserved frame immediately so
      // the window never shows a blank background between resize events.
      render(false, 0);
    };

    const resetBeam = (b: Beam, i: number) => {
      const spacing = w / 3;
      b.y = h + 50;
      b.x = (i % 3) * spacing + spacing / 2 + (Math.random() - 0.5) * spacing * 0.5;
      b.width = 50 + Math.random() * 50;
      b.speed = 0.25 + Math.random() * 0.2;
      b.opacity = 0.2 + Math.random() * 0.1;
      b.sprite = bakeBeam(b, hue, intensity);
    };

    const draw = (b: Beam) => {
      if (!b.sprite) return;
      ctx.save();
      ctx.globalAlpha = 0.8 + Math.sin(b.pulse) * 0.2;
      ctx.translate(b.x, b.y);
      ctx.rotate((b.angle * Math.PI) / 180);
      ctx.drawImage(b.sprite, -b.width / 2 - SPRITE_PAD, -SPRITE_PAD);
      ctx.restore();
    };

    const render = (move: boolean, deltaMs: number) => {
      if (move && frame++ % HUE_REFRESH_FRAMES === 0) {
        const nextHue = glowHue();
        if (nextHue !== hue) {
          hue = nextHue;
          bakeAll();
        }
      }
      const step = move ? deltaMs / (1000 / 60) : 0;
      ctx.clearRect(0, 0, w, h);
      beams.forEach((b, i) => {
        if (move) {
          b.y -= b.speed * SPEED * step;
          b.pulse += b.pulseSpeed * SPEED * step;
          if (b.y + b.length < -50) resetBeam(b, i);
        }
        draw(b);
      });
    };

    const loop = (now: number) => {
      if (now - lastDraw >= FRAME_MS) {
        const delta = lastDraw === 0 ? FRAME_MS : now - lastDraw;
        lastDraw = now;
        render(true, delta);
      }
      raf = requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener("resize", resize);
    if (reduced) render(false, 0);
    else if (active) {
      lastDraw = 0;
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [intensity, active]);

  return (
    <div aria-hidden className={`beams-bg ${className}`}>
      <canvas ref={canvasRef} />
      <div className="beams-bg-haze" />
    </div>
  );
}

export default BeamsBackground;
