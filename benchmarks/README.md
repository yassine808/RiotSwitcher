# Benchmarks

Every number here is measured, not estimated. `measure.ps1` reads the process
tree and the Windows GPU performance counters; `results/measurements.csv` holds
one row per run, and `results/summary.csv` is the per-label mean.

## What is measured

| Column                 | Meaning                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `startup_ms`           | launch → first visible window (`MainWindowHandle` + `IsWindowVisible`) |
| `ws_mb_avg/max`        | sum of working set over the process tree                               |
| `private_mb_avg/max`   | sum of private bytes over the process tree                             |
| `cpu_pct_avg/max`      | process-tree CPU time delta ÷ wall time ÷ logical CPUs                 |
| `gpu_mem_mb_avg/max`   | sum of `GPU Process Memory(*)\Dedicated Usage` for the tree            |
| `gpu_util_pct_avg/max` | sum of `GPU Engine(*)\Utilization Percentage` for the tree             |
| `proc_count`           | processes in the tree (main + renderer + GPU + utility + backend)      |
| `exe_mb`               | the launcher executable                                                |
| `size_dir_mb`          | the whole install folder, when the label has one                       |

GPU engine percentages are summed across engines (`3D`, `Copy`, …), so they can
exceed 100. They are comparable between labels, not a fraction of one GPU.

## Method

- Three runs per label, 30 s each (45 s for the app), 4 s warm-up after the
  window is visible.
- Run 1 is the first launch of that binary on the machine, so it pays the
  one-time antivirus scan and disk cache fill. It is reported as
  `startup_ms_first`; every other column is the mean of runs 2–3. The raw rows
  for all three runs stay in `measurements.csv`.
- Samples every second; the process tree is refreshed every 5 s so late utility
  processes are included.
- The machine is otherwise idle: no builds, installs or downloads during a run.
- `Balanced` power plan, `1280x1024 @ 60Hz` through the Parsec virtual display.
  The machine profile is written to `results/system.csv`.

## Baselines

| Label                          | Language / shell                       | Renderer            |
| ------------------------------ | -------------------------------------- | ------------------- |
| `electron-bare`                | JavaScript + Electron 44               | Chromium            |
| `tauri-bare`                   | Rust + Tauri 2                         | WebView2 (Chromium) |
| `egui-bare`                    | Rust + egui 0.37                       | native GPU (glow)   |
| `tkinter-bare`                 | Python 3.9 + Tk 8.6                    | native GDI          |
| `riotswitcher-3.1.24-baseline` | TypeScript + Electron + Python backend | Chromium            |
| `riotswitcher-optimized`       | same app, optimized render loop        | Chromium            |

The three shells render the same heading, button and eight profile rows, so the
difference is the shell, not the content. Tauri still uses Chromium's engine
through WebView2; that is the point of including it.

## Run

```powershell
# machine profile
pwsh -File benchmarks/system-info.ps1

# build the Rust baselines once
cargo build --release --manifest-path benchmarks/variants/egui-bare/Cargo.toml
cargo build --release --manifest-path benchmarks/variants/tauri-bare/src-tauri/Cargo.toml

# all language baselines + the saved pre-optimization app
pwsh -File benchmarks/run-baselines.ps1

# rebuild the app, then measure the optimized build
pwsh -File benchmarks/run-app.ps1

# aggregate
pwsh -File benchmarks/compare.ps1
```

`benchmarks/artifacts/` holds the pre-optimization unpacked build and is
gitignored; it is only needed to re-measure the baseline after a rebuild.

## Results

Measured on 2026-11-27 on the machine in `results/system.csv`. Two warm runs
per label; run 1 is the cold first launch. Raw rows: `results/measurements.csv`.
Summary: `results/summary.csv`.

### The app, before and after the render-loop change

| Metric | 3.1.24 baseline | optimized | Change |
| --- | --- | --- | --- |
| CPU, % of all 12 threads | 14.86 | 9.07 | **−39%** |
| GPU engine, % summed | 29.13 | 24.34 | **−16%** |
| Working set, MB | 525.0 | 494.2 | **−31 MB** |
| Private bytes, MB | 488.3 | 489.6 | +1 MB (flat) |
| Dedicated GPU memory, MB | 183.2 | 200.9 | +18 MB |
| Warm startup, ms | 392 | 314 | −78 ms |
| First launch, ms | 1 978 | 7 264 | not comparable |

The change bakes each beam's gradient and 18 px blur into one offscreen sprite
and redraws at 30 Hz instead of 60 Hz. CPU and GPU load drop because Chromium
no longer allocates a blur surface per beam per frame. The cost is one resident
texture per beam: about 18 MB of dedicated GPU memory. Working set falls by
31 MB; private bytes are dominated by the Python backend and do not move.

The first launch is excluded because it is dominated by a one-time antivirus
scan of the freshly built folder; it varied from 2.0 s to 7.3 s between builds
and says nothing about the renderer. Warm startup differs by 78 ms, which is
close to build-to-build variance and is not claimed as an effect of the change.

### Language and shell baselines

| Label | Warm startup, ms | Working set, MB | Private, MB | CPU % | GPU mem, MB | Processes |
| --- | --- | --- | --- | --- | --- | --- |
| `tkinter-bare` | 210 | 25.4 | 10.6 | ~0 | 0 | 1 |
| `egui-bare` | 34 | 64.3 | 63.1 | ~0 | 12.1 | 1 |
| `electron-bare` | 159 | 287.1 | 140.9 | ~0 | 17.8 | 4 |
| `tauri-bare` | 30 | 333.6 | 158.4 | ~0 | 26.0 | 7 |
| `riotswitcher-3.1.24-baseline` | 392 | 525.0 | 488.3 | 14.86 | 183.2 | 6 |
| `riotswitcher-optimized` | 314 | 494.2 | 489.6 | 9.07 | 200.9 | 6 |

What the rows say:

- **Tauri is not lighter than Electron here.** The Rust shell starts faster
  (30 ms vs 159 ms) but uses more working set (333.6 MB vs 287.1 MB) because
  WebView2 runs seven processes against Electron's four. Both render the same
  static page; the difference is the webview, not the language.
- **Native toolkits are the only real memory win.** egui is 64 MB and Tkinter
  25 MB, at the cost of giving up HTML/CSS for the UI. That is a rewrite, not an
  optimization.
- **The app's cost is the animation and the backend, not the shell.** The bare
  Electron shell idles at 0.02% CPU; the app idles at 9% with the beams running
  and a Python backend attached. The render-loop change removed about 5.8
  percentage points of that CPU.

Caveats: the display is a Parsec virtual adapter at 1280×1024 @ 60 Hz, so GPU
numbers are relative, not absolute; the binaries are unsigned, so antivirus
behaviour differs between machines; and two warm runs per label is enough to
separate these gaps, not enough for small ones.

