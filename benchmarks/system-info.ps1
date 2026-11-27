# Writes the machine profile that every benchmark number belongs to.
#   pwsh -File benchmarks/system-info.ps1
$ErrorActionPreference = "Stop"

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cs = Get-CimInstance Win32_ComputerSystem
$gpus = Get-CimInstance Win32_VideoController
$power = (powercfg /getactivescheme) -join " "
$node = (node --version) 2>$null
$electron = ""
if (Test-Path "node_modules/electron/package.json") {
  $electron = (Get-Content "node_modules/electron/package.json" -Raw | ConvertFrom-Json).version
}
$rust = (rustc --version) 2>$null
$python = (py -3.9 --version) 2>$null
$screen = Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution } | Select-Object -First 1

$out = "benchmarks/results/system.csv"
$dir = Split-Path -Parent $out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

[pscustomobject]@{
  timestamp_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  os = "$($os.Caption) build $($os.BuildNumber)"
  cpu = $cpu.Name
  physical_cores = $cpu.NumberOfCores
  logical_cpus = $cpu.NumberOfLogicalProcessors
  cpu_max_mhz = $cpu.MaxClockSpeed
  ram_gb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  gpus = ($gpus | ForEach-Object { "$($_.Name) $($_.DriverVersion)" }) -join " | "
  display = if ($screen) { "$($screen.CurrentHorizontalResolution)x$($screen.CurrentVerticalResolution) @ $($screen.CurrentRefreshRate)Hz" } else { "" }
  power_plan = $power
  node = "$node"
  electron = "$electron"
  rustc = "$rust"
  python = "$python"
  notes = "Local Windows desktop; Parsec virtual display adapter is present."
} | Export-Csv -Path $out -NoTypeInformation -Encoding utf8

Get-Content $out
