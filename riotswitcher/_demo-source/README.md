# Rebuilding the demo after you change the app UI

The demo on the site is your real `src/renderer` (unchanged) built with a fake backend.
To refresh it after UI changes, from your repo root:

1. Copy `mock.ts`, `entry.tsx`, `index.html` into a new folder `demo/` in the repo, and `vite.demo.config.ts` into the repo root.
2. Copy `official playercards/AgentMastery/Animated/*.webp` into `demo/public/cards/`.
3. `npx vite build -c vite.demo.config.ts`  (output: `demo-dist/`)
4. Replace the site's `demo/` folder with `demo-dist/`.

Dummy accounts live at the top of `mock.ts` (SEEDS).
