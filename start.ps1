# Claude Code Free — Windows PowerShell Launcher
# Starts the proxy and opens Claude Code CLI

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js not found. Install it first: https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Kill any existing proxy on port 51200
$existing = Get-NetTCPConnection -LocalPort 51200 -ErrorAction SilentlyContinue
if ($existing) {
    $existing | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}

# Start proxy in background
$proxy = Start-Process node -ArgumentList "$ScriptDir\proxy.mjs" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

if ($proxy.HasExited) {
    Write-Host "❌ Proxy failed to start! Check ~\.claude-code-via-antigravity-proxy.log" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Proxy running (PID: $($proxy.Id))" -ForegroundColor Green
Write-Host "   Log: ~\.claude-code-via-antigravity-proxy.log"

# Set environment and launch Claude Code CLI
$env:ANTHROPIC_BASE_URL = "http://localhost:51200"
$env:ANTHROPIC_API_KEY = "claude-code-via-antigravity"

claude --dangerously-skip-permissions

# When Claude exits, kill proxy
Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue
Write-Host "Proxy stopped."
