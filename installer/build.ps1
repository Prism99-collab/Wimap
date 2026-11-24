# Builds dist\Wimap.exe and dist\WimapSetup-<version>.exe.
# Usage: powershell -File installer\build.ps1 [-SkipTests]
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 is not installed. Install it with: winget install JRSoftware.InnoSetup' }

if (-not $SkipTests) {
  dotnet test "$root\tests\Wimap.Tests" -c Release
  if ($LASTEXITCODE) { throw 'dotnet tests failed' }
  node --test "$root\tests\ui"
  if ($LASTEXITCODE) { throw 'UI tests failed' }
}

dotnet publish "$root\src\Wimap" -c Release -o "$root\dist"
if ($LASTEXITCODE) { throw 'publish failed' }

& $iscc /Q "$root\installer\Wimap.iss"
if ($LASTEXITCODE) { throw 'installer build failed' }
Get-ChildItem "$root\dist\WimapSetup-*.exe" | Sort-Object LastWriteTime | Select-Object -Last 1 | ForEach-Object { "Built $($_.FullName)" }
