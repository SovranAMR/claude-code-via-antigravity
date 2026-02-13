#!/usr/bin/env node
/**
 * Claude Code via Antigravity — Setup & Authentication
 * 
 * Authenticates with Google using the Antigravity (Code Assist) OAuth client,
 * fetches the project ID, and stores credentials for the proxy.
 *
 * OAuth client credentials are auto-extracted from your locally installed
 * Antigravity IDE — nothing is hardcoded in this source code.
 *
 * Usage:
 *   node setup.mjs login    # First-time setup (opens browser)
 *   node setup.mjs refresh  # Refresh access token
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// ── Auto-detect OAuth credentials from installed Antigravity IDE ────────

function findAntigravityCredentials() {
    const home = homedir();

    // Search paths for Antigravity extensions (Linux, macOS, Windows)
    const searchPaths = [
        join(home, ".antigravity", "extensions"),
        join(home, ".vscode", "extensions"),
        join(home, ".vscode-server", "extensions"),
        // Windows paths
        join(home, "AppData", "Local", "Programs", "antigravity", "resources"),
        join(home, ".config", "Antigravity"),
    ];

    // Also check Antigravity Cockpit shared credentials
    const cockpitCreds = join(home, ".antigravity_cockpit", "credentials.json");
    if (existsSync(cockpitCreds)) {
        try {
            const data = JSON.parse(readFileSync(cockpitCreds, "utf-8"));
            const accounts = data.accounts || {};
            const firstAccount = Object.values(accounts)[0];
            if (firstAccount?.refreshToken) {
                console.log("  Found existing Antigravity Cockpit credentials");
                // We still need the client ID/secret from the extension
            }
        } catch { }
    }

    // Regex patterns to find OAuth client ID and secret in extension JS files
    const clientIdPattern = /["'](\d{12}-[a-z0-9]+\.apps\.googleusercontent\.com)["']/;
    const clientSecretPattern = /["'](GOCSPX-[A-Za-z0-9_-]+)["']/;

    for (const searchPath of searchPaths) {
        if (!existsSync(searchPath)) continue;

        try {
            const entries = readdirSync(searchPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const name = entry.name.toLowerCase();

                // Look for Antigravity-related extensions
                if (!name.includes("antigravity") && !name.includes("cloudcode") && !name.includes("gemini")) continue;

                const extDir = join(searchPath, entry.name);
                const jsFiles = findJsFiles(extDir, 3);

                for (const jsFile of jsFiles) {
                    try {
                        const content = readFileSync(jsFile, "utf-8");
                        const idMatch = content.match(clientIdPattern);
                        const secretMatch = content.match(clientSecretPattern);

                        if (idMatch && secretMatch) {
                            console.log(`  ✅ Found OAuth credentials in: ${entry.name}`);
                            return {
                                clientId: idMatch[1],
                                clientSecret: secretMatch[1],
                            };
                        }
                    } catch { }
                }
            }
        } catch { }
    }

    return null;
}

// Recursively find .js files up to a certain depth
function findJsFiles(dir, maxDepth, depth = 0) {
    if (depth >= maxDepth) return [];
    const results = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
                results.push(...findJsFiles(fullPath, maxDepth, depth + 1));
            } else if (entry.isFile() && entry.name.endsWith(".js")) {
                results.push(fullPath);
            }
        }
    } catch { }
    return results;
}

// ── OAuth Setup ─────────────────────────────────────────────────────────

let CLIENT_ID, CLIENT_SECRET;

function loadCredentials() {
    const found = findAntigravityCredentials();
    if (!found) {
        console.error("\n❌ Could not find Antigravity IDE installation.");
        console.error("   Make sure Antigravity IDE is installed on this machine.");
        console.error("   Download: https://idx.google.com/\n");
        process.exit(1);
    }
    CLIENT_ID = found.clientId;
    CLIENT_SECRET = found.clientSecret;
}

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];

const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com";
const CREDS_PATH = join(homedir(), ".claude-code-via-antigravity-credentials.json");

// ── PKCE ────────────────────────────────────────────────────────────────
function generatePkce() {
    const verifier = randomBytes(32).toString("hex");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

function buildAuthUrl(challenge, state) {
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
}

// ── Token Exchange ──────────────────────────────────────────────────────
async function exchangeCode(code, verifier) {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed: ${text}`);
    }

    const data = await response.json();
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in ?? 0) * 1000 - 5 * 60 * 1000,
    };
}

async function refreshAccessToken(refreshToken) {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
    });

    if (!response.ok) throw new Error("Token refresh failed");

    const data = await response.json();
    return {
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in ?? 0) * 1000 - 5 * 60 * 1000,
    };
}

// ── Fetch Project ID ────────────────────────────────────────────────────
async function fetchProjectId(accessToken) {
    const response = await fetch(`${CODE_ASSIST_URL}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "claude-code-via-antigravity",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            "Client-Metadata": JSON.stringify({
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
            }),
        },
        body: JSON.stringify({
            metadata: {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
            },
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        console.error("loadCodeAssist error:", text);
        return null;
    }

    const data = await response.json();
    return data.cloudaicompanionProject?.id
        || (typeof data.cloudaicompanionProject === "string" ? data.cloudaicompanionProject : null);
}

// ── Open Browser (cross-platform) ──────────────────────────────────────
function openBrowser(url) {
    const os = platform();
    try {
        if (os === "win32") execSync(`start "" "${url}"`);
        else if (os === "darwin") execSync(`open "${url}"`);
        else execSync(`xdg-open "${url}" 2>/dev/null`);
    } catch {
        console.log("\n  Could not open browser. Please open this URL manually:\n");
        console.log(`  ${url}\n`);
    }
}

// ── OAuth Callback Server ───────────────────────────────────────────────
function startCallbackServer() {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            if (!req.url?.startsWith("/oauth-callback")) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            const url = new URL(req.url, "http://localhost:51121");
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>✅ Authentication successful! You can close this tab.</h1>");
            server.close();
            resolve({
                code: url.searchParams.get("code"),
                state: url.searchParams.get("state"),
            });
        });
        server.listen(51121, "127.0.0.1", () => {
            console.log("  OAuth callback server listening on port 51121...");
        });
        server.on("error", reject);
    });
}

// ── Login Flow ──────────────────────────────────────────────────────────
async function login() {
    console.log("\n🔐 Starting OAuth authentication...\n");
    console.log("  Detecting Antigravity installation...");
    loadCredentials();

    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("hex");
    const authUrl = buildAuthUrl(challenge, state);

    const callbackPromise = startCallbackServer();

    console.log("  Opening browser...\n");
    openBrowser(authUrl);

    const { code, state: returnedState } = await callbackPromise;
    if (!code) throw new Error("No OAuth code received");
    if (returnedState !== state) throw new Error("OAuth state mismatch");

    console.log("\n  Exchanging token...");
    const tokens = await exchangeCode(code, verifier);

    console.log("  Fetching project ID...");
    const projectId = await fetchProjectId(tokens.access_token);

    if (!projectId) {
        console.error("\n❌ Could not fetch project ID. Make sure you have an active Antigravity/Code Assist subscription.");
        process.exit(1);
    }

    // Get email
    let email = "unknown";
    try {
        const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (res.ok) email = (await res.json()).email || "unknown";
    } catch { }

    // Save credentials
    const creds = {
        ...tokens,
        project_id: projectId,
        email,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
    };
    writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));

    console.log(`\n✅ Authentication successful!`);
    console.log(`   Email:       ${email}`);
    console.log(`   Project:     ${projectId}`);
    console.log(`   Credentials: ${CREDS_PATH}`);
    console.log(`\n🚀 Start Claude Code:\n`);
    if (platform() === "win32") {
        console.log(`   .\\start.bat\n`);
    } else {
        console.log(`   ./start.sh\n`);
    }
}

// ── Refresh Command ─────────────────────────────────────────────────────
async function refresh() {
    if (!existsSync(CREDS_PATH)) {
        console.log("No credentials found. Run: node setup.mjs login");
        process.exit(1);
    }
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
    // Use stored client credentials for refresh
    CLIENT_ID = creds.client_id;
    CLIENT_SECRET = creds.client_secret;

    console.log("Refreshing token...");
    const newTokens = await refreshAccessToken(creds.refresh_token);
    creds.access_token = newTokens.access_token;
    creds.expires_at = newTokens.expires_at;
    writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
    console.log("✅ Token refreshed!");
}

// ── CLI ─────────────────────────────────────────────────────────────────
const cmd = process.argv[2] || "login";
if (cmd === "login") {
    login().catch(err => { console.error("❌", err.message); process.exit(1); });
} else if (cmd === "refresh") {
    refresh().catch(err => { console.error("❌", err.message); process.exit(1); });
} else {
    console.log("Usage: node setup.mjs [login|refresh]");
}
