# Claude Code Free

**Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI for free** through Google's Antigravity (Cloud Code Assist) subscription.

> A lightweight local proxy that bridges Claude Code CLI ↔ Google Cloud Code Assist API, giving you access to **Claude Opus 4.6** and **Claude Sonnet 4.5** — no Anthropic API key needed.

---

## How It Works

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────────────┐
│  Claude Code  │────▶│  Local Proxy     │────▶│  Google Cloud Code Assist│
│  CLI          │◀────│  (localhost:51200)│◀────│  (Antigravity API)       │
└──────────────┘     └─────────────────┘     └──────────────────────────┘
   Anthropic API         Translates             Has Claude models via
   format                formats                Google subscription
```

The proxy intercepts Claude Code CLI requests, translates them from Anthropic's format to Google's Cloud Code Assist API, and returns the responses in the format Claude Code expects. This works because Google's Antigravity/Code Assist subscription includes access to Claude models.

## Prerequisites

- **Node.js 18+** — [Download](https://nodejs.org)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **Google Account** with [Antigravity IDE Ultra](https://one.google.com/explore-plan/gemini-ultra) or [Google One AI Premium](https://one.google.com/explore-plan/gemini-ultra) subscription

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/SovranAMR/claude-code-via-antigravity.git
cd claude-code-via-antigravity
```

### 2. Authenticate with Google

```bash
node setup.mjs login
```

This opens your browser for Google OAuth. Sign in with the account that has the Antigravity/AI Premium subscription.

### 3. Launch Claude Code

**Linux / macOS:**
```bash
./start.sh
```

**Windows (PowerShell):**
```powershell
.\start.ps1
```

**Windows (double-click):**
Just double-click `start.bat`

That's it! Claude Code CLI opens with full access to Claude models. 🚀

---

## Available Models

| Model | Description |
|---|---|
| `claude-opus-4-6-thinking` | Most capable, with extended thinking |
| `claude-sonnet-4-5` | Fast and capable |
| `claude-sonnet-4-5-thinking` | Sonnet with thinking |

All Claude Code model requests are automatically mapped to the best available model.

## Platform Support

### ✅ Linux
Fully supported. Desktop shortcut included:

```bash
# Copy desktop shortcut
cp claude-free.desktop ~/.local/share/applications/
# Edit the Exec line to point to your start.sh path:
sed -i "s|%SCRIPT_DIR%|$(pwd)|g" ~/.local/share/applications/claude-free.desktop
```

### ✅ macOS
Fully supported via `start.sh`. You can also create an Automator app for dock access.

### ✅ Windows
Fully supported via PowerShell (`start.ps1`) or batch file (`start.bat`).

**Requirements:**
- Node.js for Windows
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Windows Terminal recommended

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `51200` | Port for the local proxy |
| `ANTHROPIC_BASE_URL` | `http://localhost:51200` | Set automatically by launcher |
| `ANTHROPIC_API_KEY` | `claude-code-via-antigravity` | Set automatically (any value works) |

### Proxy Log

The proxy writes logs to a file instead of the terminal to keep Claude Code's UI clean:

- **Linux/macOS:** `~/.claude-code-via-antigravity-proxy.log`
- **Windows:** `%USERPROFILE%\.claude-code-via-antigravity-proxy.log`

Watch logs in real-time:
```bash
tail -f ~/.claude-code-via-antigravity-proxy.log
```

### Token Refresh

Tokens are automatically refreshed by the proxy. If you encounter auth errors:

```bash
node setup.mjs refresh
```

---

## Project Structure

```
claude-code-via-antigravity/
├── proxy.mjs          # Local proxy server (Anthropic ↔ Google translation)
├── setup.mjs          # OAuth authentication & credential setup
├── start.sh           # Linux/macOS launcher
├── start.ps1          # Windows PowerShell launcher
├── start.bat          # Windows batch launcher
├── claude-free.desktop # Linux desktop shortcut
├── LICENSE            # MIT
└── README.md
```

## How the Proxy Works (Technical)

1. **Message Conversion**: Translates Anthropic's Messages API format to Google's `streamGenerateContent` format
2. **Tool Schema Sanitization**: Strips unsupported JSON Schema fields (`anyOf`, `oneOf`, `$schema`), flattens complex types, and ensures all schemas have a `type` field
3. **Streaming**: Converts Google's SSE stream to Anthropic's SSE stream format in real-time
4. **Role Alternation**: Enforces Google's `user→model→user→model` turn structure by merging consecutive same-role messages
5. **Thinking Blocks**: Drops internal thinking blocks that would confuse the API
6. **Dynamic Thinking Budget**: Scales thinking budget based on request size (25% of `max_tokens`, clamped 1024–10240)
7. **Parallel Endpoints**: Races both production and sandbox endpoints simultaneously for lower latency
8. **Auto Token Refresh**: Refreshes OAuth tokens automatically when they expire

## Troubleshooting

| Issue | Solution |
|---|---|
| `Cannot read credentials` | Run `node setup.mjs login` first |
| `429 Rate Limited` | Wait a few seconds and retry |
| `503 Service Unavailable` | Google's API is temporarily down, retry |
| `tools.*.input_schema.type: Field required` | Update to the latest version |
| Proxy logs mixed with Claude output | Update to latest version (logs now go to file) |
| `EADDRINUSE` | Kill existing proxy: `kill -9 $(lsof -t -i :51200)` |

## Contributing

Pull requests welcome! Some areas that could use improvement:

- [ ] macOS Automator app template
- [ ] Prompt caching support (if Google API adds it)
- [ ] Streaming thinking blocks back to Claude Code
- [ ] Auto-update mechanism

## Disclaimer

This project is not affiliated with Anthropic or Google. It uses publicly available APIs. Use responsibly and in accordance with Google's and Anthropic's terms of service.

## License

**Personal & Non-Commercial Use Only** — see [LICENSE](LICENSE)

You may use, modify, and share this freely for personal/hobby purposes. Commercial use, resale, or bundling with paid products is not permitted.

