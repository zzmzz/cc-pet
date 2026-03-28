$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm not found. Install Node.js and ensure npm is in PATH."
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
  if (-not ($env:Path.Split(";") -contains $cargoBin)) {
    $env:Path = $cargoBin + ";" + $env:Path
  }
} else {
  Write-Warning "Cargo bin not found at $cargoBin. Install Rust via rustup if tauri cannot find cargo."
}

Write-Host "Starting CC Pet (tauri dev)..." -ForegroundColor Cyan
npm run tauri dev
