param(
  [string]$Version = "0.2.0",
  [string]$OutputDirectory = "D:\Downloads"
)

$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "tex-line-breaker-extension-release"
$zip = Join-Path $OutputDirectory "tex-line-breaker-extension-v$Version.zip"
$runtimeFiles = @(
  "manifest.json",
  "shared.js",
  "hyphenation-en-us.js",
  "content.js",
  "options.html",
  "options.css",
  "options.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "README.md",
  "UPDATE.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "wasm\tex_line_breaker_core.wasm"
)

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($relative in $runtimeFiles) {
  $source = Join-Path $repository $relative
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing runtime file: $relative" }
  $destination = Join-Path $stage $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Write-Output $zip
