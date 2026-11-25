# Builds dist\Wimap-<version>.msix for the Microsoft Store.
#
# The defaults are Wimap's identity from Partner Center (Apps and games > Wimap > Product identity), so a plain
#   powershell -File installer\build-msix.ps1
# builds the package to upload. The Store signs it itself, so the upload is unsigned.
#
# -Test builds a separate "Wimap Test" package for trying it on this PC. Windows installs it only when it is
# signed with a certificate it trusts: pass -SignThumbprint with a code-signing certificate from
# Cert:\CurrentUser\My whose subject is "CN=Wimap Test", and trust that certificate in LocalMachine\TrustedPeople.
param(
  [string]$IdentityName = 'Prism99.Wimap',
  [string]$Publisher = 'CN=22A168C9-E643-49D5-80D3-35C64DB3A581',
  [string]$PublisherDisplayName = 'Prism99',
  [switch]$Test,
  [string]$SignThumbprint
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1
if (-not $sdk) { throw 'The Windows SDK is not installed. Install it with: winget install Microsoft.WindowsSDK.10.0.26100' }
$bin = $sdk.DirectoryName

# The version in Wimap.csproj, as the four-part number the Store wants (the last part must be 0).
[xml]$proj = Get-Content "$root\src\Wimap\Wimap.csproj"
$version = ($proj.Project.PropertyGroup | Where-Object Version | Select-Object -First 1).Version + '.0'

if ($Test) { $Publisher = 'CN=Wimap Test'; $IdentityName = 'Prism99.Wimap.Test' }

$stage = "$root\dist\msix"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }

# A normal folder publish (not single-file): the package is compressed anyway and the app starts faster.
dotnet publish "$root\src\Wimap" -c Release -o $stage -p:PublishSingleFile=false -p:IncludeNativeLibrariesForSelfExtract=false
if ($LASTEXITCODE) { throw 'publish failed' }

Copy-Item "$PSScriptRoot\msix\Assets" "$stage\Assets" -Recurse
$manifest = (Get-Content "$PSScriptRoot\msix\AppxManifest.xml" -Raw).
  Replace('{{IdentityName}}', $IdentityName).Replace('{{Publisher}}', [Security.SecurityElement]::Escape($Publisher)).
  Replace('{{PublisherDisplayName}}', [Security.SecurityElement]::Escape($PublisherDisplayName)).Replace('{{Version}}', $version)
[IO.File]::WriteAllText("$stage\AppxManifest.xml", $manifest, (New-Object Text.UTF8Encoding $false))

# Resource index, so Windows picks the right logo size for each place it shows one.
Push-Location $stage
try {
  & "$bin\makepri.exe" createconfig /cf priconfig.xml /dq en-US /o | Out-Null
  & "$bin\makepri.exe" new /pr . /cf priconfig.xml /of resources.pri /o | Out-Null
  if ($LASTEXITCODE) { throw 'makepri failed' }
  Remove-Item priconfig.xml
} finally { Pop-Location }

$out = "$root\dist\Wimap-$($version.Substring(0, $version.Length - 2))$(if ($Test) { '-test' }).msix"
& "$bin\makeappx.exe" pack /d $stage /p $out /o | Out-Null
if ($LASTEXITCODE) { throw 'makeappx failed' }
if ($SignThumbprint) {
  & "$bin\signtool.exe" sign /fd SHA256 /sha1 $SignThumbprint /s My $out | Out-Null
  if ($LASTEXITCODE) { throw 'signing failed' }
}
"Built $out"
