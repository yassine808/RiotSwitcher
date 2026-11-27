# Runs the language baselines and the app, appending measured rows to
# benchmarks/results/measurements.csv. Build the Rust variants first:
#   cargo build --release   (in each src-tauri / egui-bare folder)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $measure = Join-Path $PSScriptRoot "measure.ps1"
  $csv = Join-Path $PSScriptRoot "results/measurements.csv"

  & pwsh -File $measure -Label electron-bare `
    -Exe (Join-Path $root "node_modules/electron/dist/electron.exe") `
    -Arguments (Join-Path $PSScriptRoot "variants/electron-bare") `
    -DurationSec 30 -Runs 3 -OutCsv $csv `
    -Notes "Chromium shell, empty page; no framework, no backend."

  & pwsh -File $measure -Label tauri-bare `
    -Exe (Join-Path $PSScriptRoot "variants/tauri-bare/src-tauri/target/release/bench-tauri.exe") `
    -DurationSec 30 -Runs 3 -OutCsv $csv `
    -Notes "Rust + WebView2 shell, same HTML."

  & pwsh -File $measure -Label egui-bare `
    -Exe (Join-Path $PSScriptRoot "variants/egui-bare/target/release/bench-egui.exe") `
    -DurationSec 30 -Runs 3 -OutCsv $csv `
    -Notes "Rust + egui, native GPU renderer, same labels."

  $pythonw = Join-Path $env:LOCALAPPDATA "Programs/Python/Python39/pythonw.exe"
  if (Test-Path $pythonw) {
    & pwsh -File $measure -Label tkinter-bare `
      -Exe $pythonw `
      -Arguments (Join-Path $PSScriptRoot "variants/tkinter-bare/main.py") `
      -DurationSec 30 -Runs 3 -OutCsv $csv `
      -Notes "Python 3.9 + Tk 8.6, native widgets."
  }

  & pwsh -File $measure -Label riotswitcher-3.1.24-baseline `
    -Exe (Join-Path $PSScriptRoot "artifacts/baseline-win-unpacked/RiotSwitcher.exe") `
    -DurationSec 45 -Runs 3 -OutCsv $csv -SizeDir (Join-Path $PSScriptRoot "artifacts/baseline-win-unpacked") `
    -Notes "Packaged app before optimization, 6 profiles, home view, beams background running."
}
finally {
  Pop-Location
}
