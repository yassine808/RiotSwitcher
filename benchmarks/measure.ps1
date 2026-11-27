# Measures one desktop app's start-up, CPU, GPU and RAM, then appends one CSV row.
#
#   pwsh -File benchmarks/measure.ps1 -Label electron-bare `
#     -Exe node_modules/electron/dist/electron.exe `
#     -Arguments benchmarks/variants/electron-bare -DurationSec 30 -Runs 3
#
# Every number in benchmarks/results/*.csv comes from this script. Nothing is
# estimated: memory and CPU are read from the process tree, GPU from the
# Windows GPU performance counters.

param(
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$Exe,
  [string[]]$Arguments = @(),
  [int]$DurationSec = 30,
  [int]$Runs = 3,
  [int]$WarmupSec = 4,
  [string]$OutCsv = "benchmarks/results/measurements.csv",
  [string]$Notes = "",
  [string]$SizeDir = ""
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BenchWin32 {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$logicalCpus = [Environment]::ProcessorCount

function Get-ProcessTreeIds {
  param([int]$RootId)
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $ids = [System.Collections.Generic.List[int]]::new()
  $ids.Add($RootId)
  $added = $true
  while ($added) {
    $added = $false
    foreach ($proc in $all) {
      if ($ids.Contains([int]$proc.ParentProcessId) -and -not $ids.Contains([int]$proc.ProcessId)) {
        $ids.Add([int]$proc.ProcessId)
        $added = $true
      }
    }
  }
  return $ids
}

function Get-TreeSample {
  param([System.Collections.Generic.List[int]]$Ids)
  $ws = 0L
  $priv = 0L
  $cpu = 0.0
  $alive = [System.Collections.Generic.List[int]]::new()
  foreach ($id in $Ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $alive.Add($id)
    $ws += $proc.WorkingSet64
    $priv += $proc.PrivateMemorySize64
    $cpu += $proc.TotalProcessorTime.TotalSeconds
  }
  return [pscustomobject]@{ Ids = $alive; Ws = $ws; Priv = $priv; Cpu = $cpu }
}

function Get-GpuSample {
  param([System.Collections.Generic.List[int]]$Ids)
  $idSet = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($id in $Ids) { [void]$idSet.Add($id) }
  $mem = 0L
  $util = 0.0
  foreach ($row in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue)) {
    $m = [regex]::Match($row.Name, '^pid_(\d+)_')
    if ($m.Success -and $idSet.Contains([int]$m.Groups[1].Value)) {
      $mem += [int64]$row.DedicatedUsage
    }
  }
  foreach ($row in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue)) {
    $m = [regex]::Match($row.Name, '^pid_(\d+)_')
    if ($m.Success -and $idSet.Contains([int]$m.Groups[1].Value)) {
      $util += [double]$row.UtilizationPercentage
    }
  }
  return [pscustomobject]@{ Mem = $mem; Util = $util }
}

function Get-DirSize {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) { return "" }
  $item = Get-Item $Path
  if ($item.PSIsContainer) {
    return (Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  }
  return $item.Length
}

$csvDir = Split-Path -Parent $OutCsv
if ($csvDir -and -not (Test-Path $csvDir)) { New-Item -ItemType Directory -Force $csvDir | Out-Null }

$exeItem = Get-Item $Exe
$exeMb = [math]::Round($exeItem.Length / 1MB, 2)
$sizeBytes = Get-DirSize $SizeDir
$sizeMb = if ($sizeBytes -eq "") { "" } else { [math]::Round($sizeBytes / 1MB, 2) }

for ($run = 1; $run -le $Runs; $run++) {
  $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $startupMs = $null
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { break }
    $p.Refresh()
    if ($p.MainWindowHandle -ne [IntPtr]::Zero -and [BenchWin32]::IsWindowVisible($p.MainWindowHandle)) {
      $startupMs = [int]$sw.ElapsedMilliseconds
      break
    }
    Start-Sleep -Milliseconds 25
  }
  if ($null -eq $startupMs) {
    $startupMs = ""
    Write-Warning "$Label run $run : no visible window within 45s"
  }

  Start-Sleep -Seconds $WarmupSec

  $ids = Get-ProcessTreeIds -RootId $p.Id
  $prev = Get-TreeSample -Ids $ids
  $prevAt = [System.Diagnostics.Stopwatch]::GetTimestamp()
  $samples = [System.Collections.Generic.List[object]]::new()

  for ($i = 0; $i -lt $DurationSec; $i++) {
    Start-Sleep -Seconds 1
    if (($i % 5) -eq 0) { $ids = Get-ProcessTreeIds -RootId $p.Id }
    $now = Get-TreeSample -Ids $ids
    $nowAt = [System.Diagnostics.Stopwatch]::GetTimestamp()
    $elapsed = ($nowAt - $prevAt) / [System.Diagnostics.Stopwatch]::Frequency
    $cpuPct = 0.0
    if ($elapsed -gt 0) {
      $cpuPct = (($now.Cpu - $prev.Cpu) / $elapsed) / $logicalCpus * 100
    }
    $gpu = Get-GpuSample -Ids $now.Ids
    $samples.Add([pscustomobject]@{
      Ws = $now.Ws
      Priv = $now.Priv
      Cpu = $cpuPct
      GpuMem = $gpu.Mem
      GpuUtil = $gpu.Util
      Procs = $now.Ids.Count
    })
    $prev = $now
    $prevAt = $nowAt
  }

  $procCount = ($samples | Measure-Object Procs -Average).Average
  $row = [pscustomobject]@{
    timestamp_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    label = $Label
    run = $run
    exe = $Exe
    exe_mb = $exeMb
    size_dir_mb = $sizeMb
    startup_ms = $startupMs
    proc_count = [math]::Round($procCount, 1)
    ws_mb_avg = [math]::Round((($samples | Measure-Object Ws -Average).Average) / 1MB, 1)
    ws_mb_max = [math]::Round((($samples | Measure-Object Ws -Maximum).Maximum) / 1MB, 1)
    private_mb_avg = [math]::Round((($samples | Measure-Object Priv -Average).Average) / 1MB, 1)
    private_mb_max = [math]::Round((($samples | Measure-Object Priv -Maximum).Maximum) / 1MB, 1)
    cpu_pct_avg = [math]::Round((($samples | Measure-Object Cpu -Average).Average), 2)
    cpu_pct_max = [math]::Round((($samples | Measure-Object Cpu -Maximum).Maximum), 2)
    gpu_mem_mb_avg = [math]::Round((($samples | Measure-Object GpuMem -Average).Average) / 1MB, 1)
    gpu_mem_mb_max = [math]::Round((($samples | Measure-Object GpuMem -Maximum).Maximum) / 1MB, 1)
    gpu_util_pct_avg = [math]::Round((($samples | Measure-Object GpuUtil -Average).Average), 2)
    gpu_util_pct_max = [math]::Round((($samples | Measure-Object GpuUtil -Maximum).Maximum), 2)
    duration_s = $DurationSec
    notes = $Notes
  }
  $row | Export-Csv -Path $OutCsv -NoTypeInformation -Append -Encoding utf8
  Write-Output ("{0} run={1} startup_ms={2} ws_avg={3}MB private_avg={4}MB cpu_avg={5}% gpu_mem_avg={6}MB gpu_util_avg={7}%" -f `
      $Label, $run, $row.startup_ms, $row.ws_mb_avg, $row.private_mb_avg, $row.cpu_pct_avg, $row.gpu_mem_mb_avg, $row.gpu_util_pct_avg)

  if (-not $p.HasExited) { $p.Kill($true) }
  Start-Sleep -Seconds 3
}
