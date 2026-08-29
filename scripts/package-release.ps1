param(
  [string]$Version = "0.3.4",
  [string]$OutputDirectory = "D:\Downloads"
)

$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot
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

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

# Compress-Archive on some Windows builds writes backslashes into ZIP entry
# names. Chromium's unpacked-extension importer then turns the separator into
# a replacement character, so wasm/foo.wasm becomes one flat, unreadable file.
# Write entries explicitly with ZIP-standard forward slashes.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relative in $runtimeFiles) {
    $source = Join-Path $repository $relative
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing runtime file: $relative" }
    $entryName = $relative.Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $source,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}
Write-Output $zip
