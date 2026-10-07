# Starts the fully local OpenDots stack: Ollama (local model) + OpenDots.
# Usage: right-click > Run with PowerShell, or: powershell -File start-local.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
try {
  Invoke-WebRequest http://127.0.0.1:11434/api/version -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch {
  Write-Host 'Starting Ollama...'
  # Larger context so tool-using conversations are not truncated.
  $env:OLLAMA_CONTEXT_LENGTH = '32768'
  Start-Process $ollama -ArgumentList serve -WindowStyle Hidden
  Start-Sleep 4
}

if (-not (Test-Path node_modules)) { npm ci }
if (-not (Test-Path localtools\.venv)) {
  Write-Warning 'localtools\.venv is missing; local tools will be unavailable. See docs/LOCAL.md.'
}

Start-Process 'http://127.0.0.1:5173'
npm run dev:local
