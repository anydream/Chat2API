<#
.SYNOPSIS
    Build Chat2API Release for Windows (x64)
.DESCRIPTION
    Compiles the Electron app and packages into NSIS installer + portable executable.
    
    MUST run as Administrator — the build extracts archives with symbolic links.

    --- Usage ---
    # 正常编译（首次构建）
    .\scripts\windows\build-release.ps1

    # 缓存损坏时清理后再编译
    .\scripts\windows\build-release.ps1 -CleanCache

    # 不使用国内镜像（已有代理时）
    .\scripts\windows\build-release.ps1 -NoMirror

    ~~~~~~~~~~~~
    ~~~~~~~~~~~~
.PARAMETER CleanCache
    Clean the electron-builder winCodeSign cache before building (if cache corrupted).
.PARAMETER NoMirror
    Do not set npmmirror.com mirrors (use GitHub direct download).
.NOTES
    Requires:  Node.js 18+, npm
    Requires:  Administrator privileges (for winCodeSign symlink extraction)
    Output:    dist/Chat2API-<version>-x64-setup.exe
               dist/Chat2API-<version>-x64-portable.exe
#>

param(
    [switch]$CleanCache,
    [switch]$NoMirror
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- Fix PowerShell output encoding for UTF-8 ---
$prevEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null

$ProjectRoot = Split-Path -Path $PSScriptRoot -Parent | Split-Path -Parent
Set-Location -LiteralPath $ProjectRoot

Write-Host "=== Chat2API Release Build (Windows x64) ===" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot" -ForegroundColor Gray
Write-Host ""

# ---- Check admin (required for winCodeSign symlink extraction) ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Administrator privileges required.`nPlease restart PowerShell as Administrator and re-run:  .\scripts\windows\build-release.ps1"
    exit 1
}

# ---- Step 1: Check prerequisites ----
function Test-Command($cmd) {
    try { $null = Get-Command $cmd -ErrorAction Stop; return $true }
    catch { return $false }
}

Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Yellow

if (-not (Test-Command node)) {
    Write-Error "Node.js is not installed. Install Node.js 18+ from https://nodejs.org"
    exit 1
}
Write-Host "  Node.js: $(node -v)" -ForegroundColor Green

if (-not (Test-Command npm)) {
    Write-Error "npm is not installed."
    exit 1
}
Write-Host "  npm:     $(npm -v)" -ForegroundColor Green

# ---- Step 2: Clean build artifacts ----
Write-Host ""
Write-Host "[2/5] Cleaning previous build artifacts..." -ForegroundColor Yellow

$cleanDirs = @('out', 'dist')
foreach ($dir in $cleanDirs) {
    $path = Join-Path -Path $ProjectRoot -ChildPath $dir
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
        Write-Host "  Removed: $dir/" -ForegroundColor Gray
    } else {
        Write-Host "  Clean:   $dir/ (already clean)" -ForegroundColor Gray
    }
}

# ---- Optional: Clean winCodeSign cache (only when corrupted) ----
if ($CleanCache) {
    $wcsCache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
    if (Test-Path -LiteralPath $wcsCache) {
        Write-Host "  Cleaning winCodeSign cache..." -ForegroundColor Gray
        Remove-Item -LiteralPath $wcsCache -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  Skipped: winCodeSign cache (use -CleanCache if corrupted)" -ForegroundColor Gray
}

# ---- Step 3: Check dependencies ----
Write-Host ""
Write-Host "[3/5] Checking npm dependencies..." -ForegroundColor Yellow

if (-not (Test-Path -LiteralPath (Join-Path -Path $ProjectRoot -ChildPath 'node_modules'))) {
    Write-Host "  node_modules not found, running npm install..." -ForegroundColor Gray
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm install failed."
        exit 1
    }
}
Write-Host "  node_modules OK." -ForegroundColor Green

# ---- Step 4: Set npmmirror mirrors (China-friendly, avoids GitHub timeouts) ----
if (-not $NoMirror) {
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    Write-Host ""
    Write-Host "[4/5] Using mirrors: npmmirror.com" -ForegroundColor Yellow
    Write-Host "  ELECTRON_MIRROR              = $($env:ELECTRON_MIRROR)" -ForegroundColor Gray
    Write-Host "  ELECTRON_BUILDER_BINARIES_MIRROR = $($env:ELECTRON_BUILDER_BINARIES_MIRROR)" -ForegroundColor Gray
    Write-Host "  (set -NoMirror to use GitHub direct download)" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "[4/5] Using default download (GitHub)" -ForegroundColor Yellow
}

# ---- Step 5: Build + Package ----
Write-Host ""
Write-Host "[5/5] Building and packaging (npm run build:win)..." -ForegroundColor Yellow

npm run build:win
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed."
    # Restore encoding before exit
    [Console]::OutputEncoding = $prevEncoding
    exit 1
}

# ---- Done ----
Write-Host ""
Write-Host "=== Build Successful ===" -ForegroundColor Cyan

$distDir = Join-Path -Path $ProjectRoot -ChildPath 'dist'
if (Test-Path -LiteralPath $distDir) {
    Write-Host "Output directory: $distDir" -ForegroundColor Green
    Get-ChildItem -LiteralPath $distDir -File | ForEach-Object {
        Write-Host "  $($_.Length.ToString('N0').PadLeft(12)) B  $($_.Name)" -ForegroundColor White
    }
}
Write-Host ""

# Restore console encoding
[Console]::OutputEncoding = $prevEncoding
