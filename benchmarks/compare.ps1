# Aggregates benchmarks/results/measurements.csv by label and writes
# benchmarks/results/summary.csv. Every value is the mean of the measured runs.
#
# Run 1 of every label is the first launch of that binary on the machine, so it
# includes a one-time antivirus scan and disk cache fill. It is kept as
# `startup_ms_first` and excluded from the means; the means cover runs 2..N.
#
#   pwsh -File benchmarks/compare.ps1
param(
  [string]$Csv = "benchmarks/results/measurements.csv",
  [string]$OutCsv = "benchmarks/results/summary.csv"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Csv)) { throw "No measurements at $Csv" }

function Mean($values, $property, $digits) {
  $average = ($values | Measure-Object $property -Average).Average
  if ($null -eq $average) { return "" }
  return [math]::Round($average, $digits)
}

$rows = Import-Csv $Csv
$summary = foreach ($group in ($rows | Group-Object label)) {
  $all = $group.Group
  $first = $all | Where-Object { [int]$_.run -eq 1 } | Select-Object -First 1
  $warm = @($all | Where-Object { [int]$_.run -gt 1 })
  if ($warm.Count -eq 0) { $warm = @($all) }

  [pscustomobject]@{
    label = $group.Name
    runs = $warm.Count
    startup_ms_first = if ($first) { $first.startup_ms } else { "" }
    startup_ms = Mean $warm "startup_ms" 0
    ws_mb = Mean $warm "ws_mb_avg" 1
    private_mb = Mean $warm "private_mb_avg" 1
    cpu_pct = Mean $warm "cpu_pct_avg" 2
    gpu_mem_mb = Mean $warm "gpu_mem_mb_avg" 1
    gpu_util_pct = Mean $warm "gpu_util_pct_avg" 2
    proc_count = Mean $warm "proc_count" 1
    exe_mb = Mean $warm "exe_mb" 2
    size_dir_mb = ($warm | Where-Object { $_.size_dir_mb -ne "" } | Select-Object -First 1).size_dir_mb
  }
}

$dir = Split-Path -Parent $OutCsv
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$summary | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding utf8
$summary | Format-Table -AutoSize
