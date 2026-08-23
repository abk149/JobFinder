# Post-install model setup for JobFinder.
#
# Called by the installer when the user leaves the model checkbox ticked.
#
# The important behaviour: IF THE MODEL IS ALREADY THERE, DO NOTHING. A re-install, or
# a machine where Ollama was already set up, must not re-download several gigabytes.
# Every step is non-fatal - JobFinder runs without a model (scanning, fit scoring, the
# answer bank and the tracker are all local), so a failure here should never fail the
# installation.

[CmdletBinding()]
param(
    [string]$Model     = 'deepseek-r1:8b',
    [string]$SynthModel = 'qwen2.5:7b-instruct',
    [string]$EmbedModel = 'nomic-embed-text',
    [switch]$SkipSynth
)

$ErrorActionPreference = 'Continue'

function Write-Step($msg) { Write-Host ""; Write-Host "  $msg" }

Write-Host "JobFinder - local model setup"
Write-Host "============================="

# -- Find Ollama ----------------------------------------------------------------
# The installer may have just added it to PATH without this shell seeing the update,
# so check the default install locations too.
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) {
    foreach ($candidate in @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe",
        "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
    )) {
        if (Test-Path $candidate) { $ollama = $candidate; break }
    }
}

if (-not $ollama) {
    Write-Step "Ollama is not installed - skipping model download."
    Write-Host "     JobFinder still works: scanning, fit scoring, the answer bank and the"
    Write-Host "     tracker are all local. To add the AI features later:"
    Write-Host "       1. Install Ollama from https://ollama.com/download"
    Write-Host "       2. Run:  ollama pull $Model"
    exit 0
}

Write-Step "Found Ollama at $ollama"

# -- Make sure the service is up, without starting a second one ----------------
$running = $false
try {
    $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 3
    if ($probe.StatusCode -eq 200) { $running = $true }
} catch { $running = $false }

if (-not $running) {
    Write-Step "Starting the Ollama service..."
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        try {
            $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 2
            if ($probe.StatusCode -eq 200) { $running = $true; break }
        } catch { }
    }
    if (-not $running) {
        Write-Step "Ollama did not respond on port 11434 - skipping."
        Write-Host "     Start it yourself later and run:  ollama pull $Model"
        exit 0
    }
} else {
    Write-Step "Ollama is already running."
}

# -- What is already installed? ------------------------------------------------
# `ollama list` prints one model per line with the tag in the first column. Matching
# on the exact tag avoids treating "deepseek-r1:1.5b" as "deepseek-r1:8b".
$installed = @()
try {
    $listing = & $ollama list 2>$null
    foreach ($line in $listing) {
        $trimmed = "$line".Trim()
        if ($trimmed -and $trimmed -notmatch '^NAME\s') {
            $installed += ($trimmed -split '\s+')[0]
        }
    }
} catch { }

if ($installed.Count -gt 0) {
    Write-Step "Models already on this machine: $($installed -join ', ')"
}

function Ensure-Model([string]$name, [string]$why) {
    if ($installed -contains $name) {
        Write-Host "  [skip]  $name is already installed - reusing it ($why)"
        return
    }
    Write-Host ""
    Write-Host "  [pull]  $name  ($why)"
    Write-Host "          One-time download. It resumes if interrupted."
    try {
        & $ollama pull $name
        if ($LASTEXITCODE -eq 0) { Write-Host "  [ok]    $name installed." }
        else { Write-Host "  [warn]  pull exited with code $LASTEXITCODE - retry later from the dashboard." }
    } catch {
        Write-Host "  [warn]  pull failed: $($_.Exception.Message)"
    }
}

# The chat model the user asked for.
Ensure-Model $Model 'chat and autofill drafting'

# Embeddings are small and make the answer bank match semantically rather than by
# exact key - worth having even on a slow connection.
Ensure-Model $EmbedModel 'semantic matching for the answer bank (~275 MB)'

# An instruct model is 3-5x faster than a reasoning model for interview-prep synthesis
# and far more reliable at long JSON. Optional, and skippable for a smaller install.
if (-not $SkipSynth) {
    Ensure-Model $SynthModel 'interview prep and cover letters - much faster than a reasoning model'
}

Write-Host ""
Write-Host "  Done. JobFinder picks the best installed model automatically."
exit 0
