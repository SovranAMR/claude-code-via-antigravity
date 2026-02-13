/**
 * Claude Code Free — Local Proxy
 * 
 * Bridges Claude Code CLI ↔ Google Cloud Code Assist API.
 * Translates Anthropic Messages API requests to Google's streamGenerateContent format.
 *
 * GitHub: https://github.com/SovranAMR/claude-code-via-antigravity
 */
import http from "node:http";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// File-based logger — avoids polluting Claude Code's terminal
const LOG_PATH = join(homedir(), ".claude-code-via-antigravity-proxy.log");
function log(...args) {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    try { appendFileSync(LOG_PATH, `${line}\n`); } catch { }
}

// ── Config ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT || "51200", 10);
const CRED_PATH = join(homedir(), ".claude-code-via-antigravity-credentials.json");
const PROD_EP = "https://cloudcode-pa.googleapis.com";
const SANDBOX_EP = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ENDPOINTS = [PROD_EP, SANDBOX_EP];
const ANTIGRAVITY_VERSION = "1.15.8";

// ── Credentials ─────────────────────────────────────────────────────────
let creds;
try { creds = JSON.parse(readFileSync(CRED_PATH, "utf-8")); }
catch { console.error("❌ Cannot read", CRED_PATH); process.exit(1); }

async function refreshToken() {
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            refresh_token: creds.refresh_token,
            grant_type: "refresh_token",
        }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
    creds.access_token = data.access_token;
    creds.expires_at = Date.now() + (data.expires_in || 3600) * 1000 - 300000;
    writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
    return data.access_token;
}

async function getToken() {
    if (Date.now() >= (creds.expires_at || 0)) await refreshToken();
    return creds.access_token;
}

// ── Model mapping ───────────────────────────────────────────────────────
// Claude Code CLI sends Anthropic model names; map to Antigravity IDs
const MODEL_MAP = {
    // Direct matches
    "claude-sonnet-4-5-20250514": "claude-sonnet-4-5",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-opus-4-5-20250414": "claude-opus-4-6-thinking",
    "claude-opus-4-5": "claude-opus-4-6-thinking",
    "claude-sonnet-4-20250514": "claude-sonnet-4-5",
    // Thinking variants
    "claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
    "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    // Haiku fallback
    "claude-haiku-3-5-20241022": "claude-sonnet-4-5",
    "claude-3-5-haiku-20241022": "claude-sonnet-4-5",
};

function mapModel(anthropicModel) {
    // Try direct mapping
    if (MODEL_MAP[anthropicModel]) return MODEL_MAP[anthropicModel];
    // Try contains-based matching
    if (anthropicModel.includes("opus")) return "claude-opus-4-6-thinking";
    if (anthropicModel.includes("sonnet")) return "claude-sonnet-4-5-thinking";
    // Default
    return "claude-opus-4-6-thinking";
}

function isThinkingModel(modelId) {
    return modelId.includes("thinking");
}

// ── Anthropic → Google format conversion ────────────────────────────────

// Safely extract text from tool_result content (string, array, or object)
function extractText(content) {
    if (content == null) return "(no output)";
    if (typeof content === "string") return content || "(empty)";
    if (Array.isArray(content)) {
        const texts = content.filter(b => b?.type === "text").map(b => b.text);
        return texts.join("\n") || "(empty)";
    }
    return JSON.stringify(content);
}

function convertAnthropicToGoogle(anthropicReq) {
    const googleModel = mapModel(anthropicReq.model);
    const rawContents = [];

    // Convert messages
    for (const msg of (anthropicReq.messages || [])) {
        if (!msg) continue;

        const role = msg.role === "assistant" ? "model" : "user";

        // Handle tool_result messages specially (user role with tool results)
        if (Array.isArray(msg.content)) {
            const toolResults = msg.content.filter(b => b?.type === "tool_result");
            if (toolResults.length > 0) {
                // Build function response parts
                const toolParts = toolResults.map(tr => ({
                    functionResponse: {
                        name: tr.tool_use_id || "unknown",
                        id: tr.tool_use_id,
                        response: { output: extractText(tr.content) },
                    },
                }));
                rawContents.push({ role: "user", parts: toolParts });

                // Also collect non-tool-result text from this message
                const textBlocks = msg.content.filter(b => b?.type === "text" && b.text);
                if (textBlocks.length > 0) {
                    rawContents.push({ role: "user", parts: textBlocks.map(b => ({ text: String(b.text) })) });
                }
                continue;
            }
        }

        // Regular message conversion
        const parts = [];
        if (typeof msg.content === "string") {
            if (msg.content) parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (!block) continue;

                switch (block.type) {
                    case "text":
                        if (block.text != null && block.text !== "") {
                            parts.push({ text: String(block.text) });
                        }
                        break;
                    case "thinking":
                        // Drop thinking blocks — internal Claude reasoning
                        break;
                    case "image":
                        parts.push({
                            inlineData: {
                                mimeType: block.source?.media_type || "image/png",
                                data: block.source?.data || "",
                            },
                        });
                        break;
                    case "tool_use":
                        parts.push({
                            functionCall: {
                                name: block.name,
                                args: block.input || {},
                                id: block.id,
                            },
                        });
                        break;
                    default:
                        // Unknown block type — safe text fallback
                        const txt = block.text || block.content;
                        if (txt) parts.push({ text: String(typeof txt === "string" ? txt : JSON.stringify(txt)) });
                        break;
                }
            }
        }

        // Sanitize: only keep valid parts
        const sanitizedParts = parts.filter(p => {
            if (p.text !== undefined) return typeof p.text === "string" && p.text.length > 0;
            if (p.functionCall) return true;
            if (p.functionResponse) return true;
            if (p.inlineData) return true;
            return false;
        });

        // If message became empty (e.g. all thinking blocks dropped), add placeholder
        if (sanitizedParts.length === 0) {
            sanitizedParts.push({ text: "..." });
        }

        rawContents.push({ role, parts: sanitizedParts });
    }

    // Enforce role alternation: merge consecutive same-role messages
    const contents = [];
    for (const entry of rawContents) {
        const prev = contents[contents.length - 1];
        if (prev && prev.role === entry.role) {
            // Merge parts into previous message
            prev.parts.push(...entry.parts);
        } else {
            contents.push({ ...entry });
        }
    }

    // Build request
    const request = { contents };

    // System prompt — pass through Claude Code's system instructions as-is
    const systemParts = [];
    if (anthropicReq.system) {
        if (typeof anthropicReq.system === "string") {
            systemParts.push({ text: anthropicReq.system });
        } else if (Array.isArray(anthropicReq.system)) {
            for (const block of anthropicReq.system) {
                if (block.type === "text") systemParts.push({ text: block.text });
            }
        }
    }
    request.systemInstruction = { role: "user", parts: systemParts };

    // Generation config
    const generationConfig = {};
    const rawMaxTokens = anthropicReq.max_tokens || 16384;

    // Dynamic thinking config for thinking models
    if (isThinkingModel(googleModel)) {
        // Use Claude Code's budget if provided, otherwise scale dynamically:
        // 25% of max_tokens, clamped between 1024 and 10240
        const clientBudget = anthropicReq.thinking?.budget_tokens;
        const dynamicBudget = Math.min(10240, Math.max(1024, Math.floor(rawMaxTokens * 0.25)));
        const thinkingBudget = clientBudget || dynamicBudget;

        // CRITICAL: maxOutputTokens MUST be greater than thinkingBudget
        const maxOutputTokens = Math.max(rawMaxTokens, thinkingBudget + 1024);
        generationConfig.maxOutputTokens = maxOutputTokens;
        generationConfig.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget,
        };
        log(`  [thinking] budget=${thinkingBudget}${clientBudget ? ' (from client)' : ' (auto)'} maxOut=${maxOutputTokens}`);
    } else {
        generationConfig.maxOutputTokens = rawMaxTokens;
    }
    if (anthropicReq.temperature !== undefined) generationConfig.temperature = anthropicReq.temperature;

    if (Object.keys(generationConfig).length > 0) {
        request.generationConfig = generationConfig;
    }

    // Tools
    if (anthropicReq.tools && anthropicReq.tools.length > 0) {
        const isClaude = googleModel.startsWith("claude-");
        request.tools = [{
            functionDeclarations: anthropicReq.tools.map(tool => {
                const cleaned = ensureSchemaType(sanitizeSchema(stripDollarSchema(tool.input_schema || {})));
                return {
                    name: tool.name,
                    description: tool.description || "",
                    // Claude: `parameters` (passes through to Anthropic input_schema)
                    // Gemini: `parametersJsonSchema` (full JSON Schema support)
                    // Both need sanitization because Google protobuf layer rejects unknown fields
                    ...(isClaude ? { parameters: cleaned } : { parametersJsonSchema: cleaned }),
                };
            }),
        }];
    }

    const body = {
        project: creds.project_id,
        model: googleModel,
        request,
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    };

    return body;
}

// Strip only $schema (and other $-prefixed meta fields) from schemas
// Keep everything else intact for Claude's full JSON Schema support
function stripDollarSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(stripDollarSchema);
    const clean = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key.startsWith("$")) continue; // strip $schema, $id, $ref, $comment etc.
        if (typeof value === "object" && value !== null) {
            clean[key] = stripDollarSchema(value);
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

// Only keep fields that Google's protobuf Schema type supports
const ALLOWED_SCHEMA_FIELDS = new Set([
    "type", "description", "properties", "required", "items", "enum", "nullable",
]);

function sanitizeSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(sanitizeSchema);

    // Flatten anyOf/oneOf: pick the most descriptive variant or merge
    let working = schema;
    if (working.anyOf || working.oneOf) {
        const variants = (working.anyOf || working.oneOf).filter(v => v && typeof v === "object");
        if (variants.length === 1) {
            // Single variant — use it directly, merge description from parent
            working = { ...variants[0], ...(working.description ? { description: working.description } : {}) };
        } else if (variants.length > 1) {
            // Multiple variants — try to find the most specific one (has enum or properties)
            const specific = variants.find(v => v.enum || v.properties);
            if (specific) {
                working = { ...specific, ...(working.description ? { description: working.description } : {}) };
            } else {
                // No specific variant — just use the first one
                working = { ...variants[0], ...(working.description ? { description: working.description } : {}) };
            }
        }
    }

    const clean = {};
    for (const [key, value] of Object.entries(working)) {
        if (!ALLOWED_SCHEMA_FIELDS.has(key)) continue;
        if (key === "properties" && typeof value === "object") {
            clean.properties = Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, sanitizeSchema(v)])
            );
        } else if (key === "items") {
            clean.items = sanitizeSchema(value);
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

function ensureSchemaType(schema) {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(ensureSchemaType);

    const s = { ...schema };

    // Default type if missing
    if (!s.type) {
        if (s.properties) s.type = "object";
        else if (s.items) s.type = "array";
        else if (s.enum) s.type = "string";
        else s.type = "object";
    }

    // Recurse into nested schemas
    if (s.properties && typeof s.properties === "object") {
        s.properties = Object.fromEntries(
            Object.entries(s.properties).map(([k, v]) => [k, ensureSchemaType(v)])
        );
    }
    if (s.items) s.items = ensureSchemaType(s.items);

    return s;
}

// ── Google SSE → Anthropic Messages response conversion ─────────────────

function convertGoogleSSEToAnthropicStream(googleSSE, anthropicModel) {
    // Parse all SSE events
    const events = [];
    const lines = googleSSE.split("\n");
    for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try { events.push(JSON.parse(jsonStr)); } catch { }
    }

    // Collect all text and tool calls
    const content = [];
    let inputTokens = 0, outputTokens = 0;
    let stopReason = "end_turn";

    for (const event of events) {
        const resp = event.response;
        if (!resp) continue;
        const candidate = resp.candidates?.[0];
        if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
                if (part.text !== undefined && !part.thoughtSignature) {
                    // Only include non-thinking text
                    const existing = content.find(b => b.type === "text");
                    if (existing) { existing.text += part.text; }
                    else { content.push({ type: "text", text: part.text }); }
                }
                if (part.functionCall) {
                    content.push({
                        type: "tool_use",
                        id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        name: part.functionCall.name,
                        input: part.functionCall.args || {},
                    });
                }
            }
            if (candidate.finishReason === "STOP") stopReason = "end_turn";
        }
        if (resp.usageMetadata) {
            inputTokens = resp.usageMetadata.promptTokenCount || 0;
            outputTokens = (resp.usageMetadata.candidatesTokenCount || 0) +
                (resp.usageMetadata.thoughtsTokenCount || 0);
        }
    }

    if (content.some(b => b.type === "tool_use")) stopReason = "tool_use";
    if (content.length === 0) content.push({ type: "text", text: "" });

    return {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: anthropicModel,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
        },
    };
}

// ── Streaming: Google SSE → Anthropic SSE ───────────────────────────────

async function streamGoogleToAnthropic(googleResp, res, anthropicModel) {
    const reader = googleResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let contentIndex = 0;
    let started = false;
    let inputTokens = 0, outputTokens = 0;

    // Send message_start
    const msgStart = {
        type: "message_start",
        message: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: anthropicModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const jsonStr = line.slice(5).trim();
                if (!jsonStr) continue;
                let chunk;
                try { chunk = JSON.parse(jsonStr); } catch { continue; }

                const resp = chunk.response;
                if (!resp) continue;
                const candidate = resp.candidates?.[0];
                if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                        // Skip thinking signatures (internal markers)
                        if (part.thoughtSignature && !part.text) continue;

                        if (part.text !== undefined) {
                            const isThinking = part.thought === true;
                            if (isThinking) continue; // Skip thinking for now

                            if (!started) {
                                // content_block_start
                                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                                    type: "content_block_start",
                                    index: contentIndex,
                                    content_block: { type: "text", text: "" },
                                })}\n\n`);
                                started = true;
                            }
                            // content_block_delta
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: "content_block_delta",
                                index: contentIndex,
                                delta: { type: "text_delta", text: part.text },
                            })}\n\n`);
                        }
                        if (part.functionCall) {
                            if (started) {
                                // Close text block
                                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                                    type: "content_block_stop", index: contentIndex,
                                })}\n\n`);
                                contentIndex++;
                                started = false;
                            }
                            const toolId = `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                            // Tool use block
                            res.write(`event: content_block_start\ndata: ${JSON.stringify({
                                type: "content_block_start",
                                index: contentIndex,
                                content_block: { type: "tool_use", id: toolId, name: part.functionCall.name, input: {} },
                            })}\n\n`);
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                                type: "content_block_delta",
                                index: contentIndex,
                                delta: { type: "input_json_delta", partial_json: JSON.stringify(part.functionCall.args || {}) },
                            })}\n\n`);
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                                type: "content_block_stop", index: contentIndex,
                            })}\n\n`);
                            contentIndex++;
                        }
                    }
                }
                if (resp.usageMetadata) {
                    inputTokens = resp.usageMetadata.promptTokenCount || 0;
                    outputTokens = (resp.usageMetadata.candidatesTokenCount || 0) +
                        (resp.usageMetadata.thoughtsTokenCount || 0);
                }
            }
        }
    } catch (err) {
        log("[stream error]", err.message);
    }

    // Close last block
    if (started) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop", index: contentIndex,
        })}\n\n`);
    }

    // message_delta
    const hasToolUse = contentIndex > (started ? 1 : 0);
    res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens },
    })}\n\n`);

    // message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    res.end();
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

    // Only handle POST /v1/messages
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
    }

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    let anthropicReq;
    try { anthropicReq = JSON.parse(body); }
    catch { res.writeHead(400); res.end('{"error":"Invalid JSON"}'); return; }

    const isStream = anthropicReq.stream === true;
    const originalModel = anthropicReq.model;
    const googlePayload = convertAnthropicToGoogle(anthropicReq);

    log(`[${new Date().toISOString()}] ${originalModel} → ${googlePayload.model} (stream=${isStream})`);

    try {
        const token = await getToken();
        const headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": `antigravity/${ANTIGRAVITY_VERSION} linux/x86_64`,
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            "Client-Metadata": JSON.stringify({
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
            }),
        };

        // Add anthropic-beta header for thinking models
        if (isThinkingModel(googlePayload.model)) {
            headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
        }

        // Race both endpoints in parallel — use whichever succeeds first
        const payloadStr = JSON.stringify(googlePayload);
        const fetchOne = async (ep) => {
            const url = `${ep}/v1internal:streamGenerateContent?alt=sse`;
            const r = await fetch(url, { method: "POST", headers, body: payloadStr });
            if (!r.ok) {
                const errText = await r.text();
                log(`  [${ep}] ${r.status}: ${errText.slice(0, 200)}`);
                throw { status: r.status, errText, ep };
            }
            return r;
        };

        const results = await Promise.allSettled(ENDPOINTS.map(fetchOne));
        const success = results.find(r => r.status === "fulfilled");
        let googleResp;

        if (success) {
            googleResp = success.value;
        } else {
            // Both failed — check for rate limit or unavailable
            const firstErr = results[0].reason;
            if (firstErr?.status === 429 || firstErr?.status === 503) {
                res.writeHead(529, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    type: "error",
                    error: {
                        type: "overloaded_error", message: firstErr.status === 429
                            ? "Overloaded — Claude rate limited on Antigravity. Try again shortly."
                            : "Service temporarily unavailable. Try again."
                    },
                }));
                return;
            }
            // Forward the error from production endpoint
            const errMsg = firstErr?.errText?.slice(0, 300) || "All endpoints failed";
            log(`[proxy error]`, errMsg);
            res.writeHead(firstErr?.status === 400 ? 400 : 500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                type: "error",
                error: { type: "api_error", message: errMsg },
            }));
            return;
        }

        if (isStream) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            await streamGoogleToAnthropic(googleResp, res, originalModel);
        } else {
            // Non-streaming: collect full response
            const sseText = await googleResp.text();
            const anthropicResp = convertGoogleSSEToAnthropicStream(sseText, originalModel);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(anthropicResp));
        }
    } catch (err) {
        log("[proxy error]", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            type: "error",
            error: { type: "api_error", message: err.message },
        }));
    }
});

server.listen(PORT, () => {
    const msg = `🚀 Antigravity Proxy running on http://localhost:${PORT}\n   Log: ${LOG_PATH}`;
    console.log(msg);
    log(`--- Proxy started on :${PORT} ---`);
    log(`   Endpoint: ${SANDBOX_EP}/v1internal:streamGenerateContent?alt=sse`);
    log(`   Project: ${creds.project_id}`);
    log(`   Models: claude-sonnet-4-5, claude-opus-4-6-thinking, claude-sonnet-4-5-thinking`);
});
