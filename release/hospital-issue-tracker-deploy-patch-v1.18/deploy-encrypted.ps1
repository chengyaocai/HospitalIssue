<#
.SYNOPSIS
    One-click deploy for the Hospital Issue Tracker backend with source encryption.
    Copies the incremental patch -> encrypts backend/src on THIS machine (machine-bound)
    -> deletes plaintext -> registers a Windows service that boots in encrypted mode.

.NOTES
    Run AS ADMINISTRATOR. Requires nssm.exe placed at  <patch>\tools\nssm.exe
    (download: https://nssm.cc  - it is what turns the Node process into a real service).
    If nssm is missing the script will STOP before the service step and tell you where to drop it.
    Messages are in English so the script parses correctly on any system codepage.

.EXAMPLE
    .\deploy-encrypted.ps1 -InstallDir "D:\hospital-issue" -Port 3000
#>
param(
    [string]$InstallDir,
    [string]$ServiceName = 'HospitalIssueTracker',
    [int]$Port = 3000,
    [string]$NssmPath = '',
    [switch]$SkipService,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PatchRoot = $PSScriptRoot
if (-not $NssmPath) { $NssmPath = Join-Path $PatchRoot 'tools\nssm.exe' }

function Log($m) { Write-Host "[deploy-encrypted] $m" }
function Die($m) { Write-Host "[FATAL] $m" -ForegroundColor Red; exit 1 }

# --- 1. locate install dir ---
if (-not $InstallDir) {
    $InstallDir = Read-Host 'Path to the INSTALL directory (the one that contains runtime\ and backend\)'
}
$InstallDir = $InstallDir.Trim('"').TrimEnd('\')
if (-not (Test-Path $InstallDir)) { Die "Install dir not found: $InstallDir" }
$NodeExe = Join-Path $InstallDir 'runtime\node.exe'
if (-not (Test-Path $NodeExe)) { Die "runtime\node.exe not found under $InstallDir (this deploy uses the bundled Node)" }

# guard: encrypted boot needs module.register (Node >= 20.6)
$ver = (& $NodeExe --version 2>$null)
if (-not $ver) { Die "Cannot read runtime\node.exe version - the file may be corrupt." }
try { $v = [Version]($ver.Trim().TrimStart('v')) } catch { Die "Unrecognized runtime\node.exe version string: $ver" }
if ($v.Major -lt 20 -or ($v.Major -eq 20 -and $v.Minor -lt 6)) {
    Die "runtime\node.exe version too old ($ver); encrypted boot needs Node >= 20.6 (module.register). Upgrade node.exe in the deploy bundle first."
}

Log "Install dir : $InstallDir"
Log "Patch root  : $PatchRoot"
if ($DryRun) { Log 'DRY-RUN: no changes will be made.' }

# --- 2. apply incremental patch (overlay, do NOT purge target-only files) ---
function Robo($from, $to, $purge) {
    if (-not (Test-Path $from)) { Log "skip (no source): $from"; return }
    $args = @($from, $to, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NP')
    if ($purge) { $args += '/PURGE' }
    Log "robocopy $from -> $to $(if($purge){'[/PURGE]'}else{''})"
    if ($DryRun) { return }
    & robocopy.exe @args | Out-Null
    if ($LASTEXITCODE -gt 7) { Die "robocopy failed (code $LASTEXITCODE) for $from" }
}
Robo (Join-Path $PatchRoot 'backend') (Join-Path $InstallDir 'backend') $false
Robo (Join-Path $PatchRoot 'frontend\dist') (Join-Path $InstallDir 'frontend\dist') $true

# Also copy the updated run-server.bat (auto-detects encrypted vs plaintext source)
$runFrom = Join-Path $PatchRoot 'run-server.bat'
$runTo = Join-Path $InstallDir 'run-server.bat'
if (Test-Path $runFrom) {
    Log "copy run-server.bat -> $runTo"
    if (-not $DryRun) { Copy-Item -Path $runFrom -Destination $runTo -Force }
}

# --- 3. encrypt + purge (machine-bound; plaintext removed from disk) ---
$SrcDir = Join-Path $InstallDir 'backend\src'
$hasPlain = Get-ChildItem -Path $SrcDir -Filter '*.js' -Recurse -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.EndsWith('.enc') }
if (-not $hasPlain) {
    Log 'backend/src already encrypted (.js plaintext absent) -> skip encrypt step (idempotent).'
} else {
    Log 'Encrypting backend/src on THIS machine (fingerprint-bound) and removing plaintext...'
    if ($DryRun) { Log 'DRY-RUN: would run encrypt --purge' }
    else {
        Push-Location (Join-Path $InstallDir 'backend')
        try { & $NodeExe tools/encrypt-src.mjs --purge | Out-Host }
        finally { Pop-Location }
    }
}

# --- 4. register Windows service (encrypted boot) ---
if ($SkipService) { Log 'SkipService set -> service step skipped.' }
else {
    if (-not (Test-Path $NssmPath)) {
        Die "nssm.exe not found at '$NssmPath'. Download nssm from https://nssm.cc and place it there, then re-run."
    }
    $AppDir = Join-Path $InstallDir 'backend'
    Log "Registering service '$ServiceName' (auto-start, encrypted boot)..."
    if (-not $DryRun) {
        # remove if a previous install exists
        & $NssmPath status $ServiceName 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            & $NssmPath stop $ServiceName 2>$null | Out-Null
            & $NssmPath remove $ServiceName confirm 2>$null | Out-Null
        }
        & $NssmPath install $ServiceName $NodeExe | Out-Null
        & $NssmPath set $ServiceName AppDirectory $AppDir | Out-Null
        & $NssmPath set $ServiceName AppParameters "--import ./loader.mjs start-enc.mjs" | Out-Null
        & $NssmPath set $ServiceName DisplayName "Hospital Issue Tracker (encrypted)" | Out-Null
        & $NssmPath set $ServiceName Description "Software problem registry backend, source encrypted (machine-bound)." | Out-Null
        & $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
        & $NssmPath set $ServiceName AppExit Default Restart | Out-Null
        & $NssmPath set $ServiceName AppEnvironmentExtra "PORT=$Port" | Out-Null
        & $NssmPath set $ServiceName AppStdout (Join-Path $AppDir 'service.out.log') | Out-Null
        & $NssmPath set $ServiceName AppStderr (Join-Path $AppDir 'service.err.log') | Out-Null
        & $NssmPath start $ServiceName | Out-Null
        Start-Sleep -Seconds 4
    }
    # health check
    try {
        $code = (curl.exe -s -o $null -w '%{http_code}' "http://localhost:$Port/api/config" -m 5)
        if ($code -eq '200') { Log "Service health OK (GET /api/config -> 200)" }
        else { Log "Service started but /api/config returned $code (check service.out.log / service.err.log)" }
    } catch { Log 'Health check skipped (curl unavailable)' }
}

Log 'Done.'
