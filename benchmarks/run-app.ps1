# Builds the packaged app and measures it. Run after changing renderer code.
#
#   pwsh -File benchmarks/run-app.ps1
#   pwsh -File benchmarks/run-app.ps1 -Label riotswitcher-optimized
param(
  [string]$Label = "riotswitcher-optimized",
  [int]$DurationSec = 45,
  [int]$Runs = 3
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  npm run dist
  & pwsh -File (Join-Path $PSScriptRoot "measure.ps1") `
    -Label $Label `
    -Exe (Join-Path $root "release/win-unpacked/RiotSwitcher.exe") `
    -DurationSec $DurationSec -Runs $Runs `
    -OutCsv (Join-Path $PSScriptRoot "results/measurements.csv") `
    -SizeDir (Join-Path $root "release/win-unpacked") `
    -Notes "Packaged app, 6 profiles, home view, beams background running."
}
finally {
  Pop-Location
}
