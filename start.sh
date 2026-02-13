#!/bin/bash
# Claude Code Free — Linux/macOS Launcher
# Starts the proxy and opens Claude Code CLI

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect Node.js
if ! command -v node &> /dev/null; then
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        export NVM_DIR="$HOME/.nvm"
        . "$NVM_DIR/nvm.sh"
    else
        echo "❌ Node.js not found. Install it first: https://nodejs.org"
        exit 1
    fi
fi

# Kill any existing proxy on port 51200
kill -9 $(lsof -t -i :51200) 2>/dev/null || true
sleep 0.5

# Start proxy in background (logs go to file, not terminal)
node "$SCRIPT_DIR/proxy.mjs" > /dev/null 2>&1 &
PROXY_PID=$!
sleep 1

# Check if proxy started
if ! kill -0 $PROXY_PID 2>/dev/null; then
    echo "❌ Proxy failed to start! Check ~/.claude-code-via-antigravity-proxy.log"
    exit 1
fi

echo "✅ Proxy running (PID: $PROXY_PID)"
echo "   Log: ~/.claude-code-via-antigravity-proxy.log"

# Set environment and launch Claude Code CLI
export ANTHROPIC_BASE_URL=http://localhost:51200
export ANTHROPIC_API_KEY=claude-code-via-antigravity

claude --dangerously-skip-permissions

# When Claude exits, kill proxy
kill $PROXY_PID 2>/dev/null
echo "Proxy stopped."
