import express from "express";
import cors from "cors";
import { z } from "zod";
const app = express();
app.use(express.json({ limit: "2mb" }));
/**
 * CORS:
 * - allow local dev UI(s)
 * - allow any Railway deployment (https://*.up.railway.app)
 * - allow env override for custom domains
 */
const ALLOWED_ORIGINS = new Set((process.env.MC_ALLOWED_ORIGINS ||
    "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean));
function isRailwayOrigin(origin) {
    return /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/.test(origin);
}
app.use(cors({
    origin: (origin, cb) => {
        // allow non-browser clients (curl, PowerShell, node fetch)
        if (!origin)
            return cb(null, true);
        if (ALLOWED_ORIGINS.has(origin))
            return cb(null, true);
        if (isRailwayOrigin(origin))
            return cb(null, true);
        return cb(null, false);
    },
    credentials: false,
}));
/** ---------- Utilities ---------- */
const now = () => Date.now();
const uid = () => Math.random().toString(16).slice(2) + "-" + Math.random().toString(16).slice(2);
const sseClients = new Map();
function sseSend(evt, data) {
    const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients.values())
        c.res.write(payload);
}
/** ---------- Inbox SSE Stream ---------- */
const inboxSseClients = new Map();
/**
 * Sends a named SSE frame to all inbox stream clients.
 * The UI listens for EventSource.addEventListener("inbox", ...) for new items
 * and EventSource.addEventListener("snapshot", ...) for the initial load.
 */
function inboxSseSend(evt, data) {
    const frame = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of inboxSseClients.values())
        c.res.write(frame);
}
/** ---------- Event Log ---------- */
const EVENT_LOG_MAX = 800;
const eventLog = [];
/** ---------- Inbox Store ---------- */
const INBOX_MAX = 500;
const inbox = [];
function eventToInboxItem(e) {
    const p = e.payload;
    return {
        id: e.id,
        ts: e.ts,
        timestamp: new Date(e.ts).toISOString(),
        source: e.source,
        conversationId: e.conversationId ?? "unknown",
        from: p?.from ?? e.conversationId ?? null,
        name: p?.name ?? null,
        text: String(p?.text ?? ""),
        raw: e,
    };
}
function pushToInbox(e) {
    const item = eventToInboxItem(e);
    inbox.push(item);
    if (inbox.length > INBOX_MAX)
        inbox.splice(0, inbox.length - INBOX_MAX);
    // Notify all SSE inbox stream clients of the new item
    inboxSseSend("inbox", item);
}
const subscribers = new Map();
function publish(e) {
    eventLog.push(e);
    if (eventLog.length > EVENT_LOG_MAX)
        eventLog.shift();
    sseSend("event", e);
    // Push inbound WhatsApp messages into the dedicated inbox store
    if (e.type === "message.incoming.whatsapp") {
        pushToInbox(e);
    }
    const subs = subscribers.get(e.type) ?? [];
    for (const fn of subs) {
        Promise.resolve()
            .then(() => fn(e))
            .catch((err) => {
            const errEvt = {
                id: uid(),
                ts: now(),
                type: "system.error",
                source: "eventbus",
                payload: {
                    message: String(err?.message ?? err),
                    stack: String(err?.stack ?? ""),
                },
            };
            eventLog.push(errEvt);
            if (eventLog.length > EVENT_LOG_MAX)
                eventLog.shift();
            sseSend("event", errEvt);
        });
    }
}
const claims = new Map();
function claimKey(conversationId, eventId) {
    return `${conversationId}:${eventId}`;
}
function tryClaim(conversationId, eventId, agentId, ttlMs = 60_000) {
    const k = claimKey(conversationId, eventId);
    const existing = claims.get(k);
    const t = now();
    if (existing && existing.expiresAt > t)
        return { ok: false, claimedBy: existing.claimedBy };
    claims.set(k, { claimedBy: agentId, expiresAt: t + ttlMs });
    return { ok: true };
}
setInterval(() => {
    const t = now();
    for (const [k, c] of claims.entries())
        if (c.expiresAt <= t)
            claims.delete(k);
}, 10_000);
/** ---------- Outbox Queue ---------- */
const OUTBOX_MAX = 300;
const outbox = [];
function outboxPush(item) {
    outbox.push(item);
    if (outbox.length > OUTBOX_MAX)
        outbox.splice(0, outbox.length - OUTBOX_MAX);
    sseSend("outbox", outbox.slice(-100));
}
subscribers.set("message.outgoing.whatsapp", [
    (e) => {
        const conversationId = e.conversationId ?? "unknown";
        const text = String(e.payload?.text ?? "");
        outboxPush({
            id: e.id,
            ts: e.ts,
            channel: "whatsapp",
            conversationId,
            text,
            meta: { source: e.source },
            status: "pending",
        });
    },
]);
subscribers.set("message.outgoing.gmail", [
    (e) => {
        const conversationId = e.conversationId ?? "unknown";
        const text = String(e.payload?.text ?? "");
        outboxPush({
            id: e.id,
            ts: e.ts,
            channel: "gmail",
            conversationId,
            text,
            meta: { source: e.source },
            status: "pending",
        });
    },
]);
/** ---------- Agent Registry ---------- */
const agents = new Map();
function baseAgent(a) {
    return {
        ...a,
        metrics: { processed1h: 0, success1h: 0, failure1h: 0, avgLatencyMs1h: 0 },
    };
}
function seedAgents() {
    const initial = [
        baseAgent({
            id: "agent.router",
            name: "Router Agent",
            version: "1.0.0",
            enabled: true,
            status: "running",
            subscriptions: ["message.incoming.whatsapp", "message.incoming.gmail", "system.health.alert"],
            allowedTools: ["memory.read", "memory.write", "agent.forward"],
            rateLimitPerMin: 120,
            maxConcurrency: 4,
        }),
        baseAgent({
            id: "agent.comms",
            name: "Comms Agent",
            version: "1.0.0",
            enabled: true,
            status: "running",
            subscriptions: ["agent.forward.comms"],
            allowedTools: ["whatsapp.send", "gmail.send", "draft.reply"],
            rateLimitPerMin: 60,
            maxConcurrency: 2,
        }),
        baseAgent({
            id: "agent.task",
            name: "Task Agent",
            version: "1.0.0",
            enabled: true,
            status: "running",
            subscriptions: ["agent.forward.task"],
            allowedTools: ["calendar.lookup", "web.search", "notes.create"],
            rateLimitPerMin: 60,
            maxConcurrency: 2,
        }),
        baseAgent({
            id: "agent.ops",
            name: "Ops Agent",
            version: "1.0.0",
            enabled: true,
            status: "running",
            subscriptions: ["system.health.alert", "system.error"],
            allowedTools: ["service.restart", "alert.push"],
            rateLimitPerMin: 30,
            maxConcurrency: 1,
        }),
        baseAgent({
            id: "agent.memory",
            name: "Memory Agent",
            version: "1.0.0",
            enabled: true,
            status: "running",
            subscriptions: ["agent.forward.memory"],
            allowedTools: ["memory.read", "memory.write"],
            rateLimitPerMin: 120,
            maxConcurrency: 2,
        }),
        baseAgent({
            id: "agent.builder",
            name: "Builder Agent",
            version: "1.0.0",
            enabled: true,
            status: "running",
            subscriptions: ["agent.forward.builder"],
            allowedTools: ["config.write", "codegen.ui", "codegen.workflow"],
            rateLimitPerMin: 30,
            maxConcurrency: 1,
        }),
        // Worker Executor shows up as a "system agent" so UI doesn't show 0
        baseAgent({
            id: "worker.executor.local",
            name: "Worker Executor (Local)",
            version: "0.1.0",
            enabled: true,
            status: "stopped", // will be updated by health poll (if enabled)
            subscriptions: ["system.health.alert"],
            allowedTools: ["worker.health", "worker.run"],
            rateLimitPerMin: 120,
            maxConcurrency: 2,
        }),
    ];
    for (const a of initial)
        agents.set(a.id, a);
}
seedAgents();
function getAgentsArray() {
    return Array.from(agents.values()).sort((x, y) => x.id.localeCompare(y.id));
}
function recordMetric(agentId, ok, latencyMs) {
    const a = agents.get(agentId);
    if (!a)
        return;
    a.metrics.processed1h += 1;
    if (ok)
        a.metrics.success1h += 1;
    else
        a.metrics.failure1h += 1;
    const n = a.metrics.processed1h;
    a.metrics.avgLatencyMs1h = Math.round((a.metrics.avgLatencyMs1h * (n - 1) + latencyMs) / n);
    a.lastEventTs = now();
    sseSend("agents", getAgentsArray());
}
function isEnabled(agentId) {
    const a = agents.get(agentId);
    return !!a?.enabled;
}
function forwardToAgent(targetAgentId, original) {
    const type = targetAgentId === "agent.comms"
        ? "agent.forward.comms"
        : targetAgentId === "agent.task"
            ? "agent.forward.task"
            : targetAgentId === "agent.memory"
                ? "agent.forward.memory"
                : targetAgentId === "agent.builder"
                    ? "agent.forward.builder"
                    : "agent.forward";
    publish({
        id: uid(),
        ts: now(),
        type,
        source: "agent.router",
        conversationId: original.conversationId,
        payload: { originalEvent: original },
    });
}
/** ---------- Behaviours ---------- */
subscribers.set("message.incoming.whatsapp", [
    async (e) => {
        const start = now();
        if (!isEnabled("agent.router"))
            return;
        const conversationId = e.conversationId ?? "unknown";
        const c = tryClaim(conversationId, e.id, "agent.router", 30_000);
        if (!c.ok)
            return;
        const text = String(e.payload?.text ?? "").toLowerCase();
        let target = "agent.comms";
        if (text.includes("schedule") || text.includes("remind") || text.includes("book"))
            target = "agent.task";
        if (text.includes("remember") || text.includes("memory"))
            target = "agent.memory";
        if (text.includes("build") || text.includes("ui") || text.includes("config"))
            target = "agent.builder";
        publish({
            id: uid(),
            ts: now(),
            type: "agent.routing.decision",
            source: "agent.router",
            conversationId,
            payload: { routedTo: target, reason: "keyword_rules_v1" },
        });
        forwardToAgent(target, e);
        recordMetric("agent.router", true, now() - start);
    },
]);
subscribers.set("message.incoming.gmail", [
    async (e) => {
        const start = now();
        if (!isEnabled("agent.router"))
            return;
        const conversationId = e.conversationId ?? "gmail:unknown";
        const c = tryClaim(conversationId, e.id, "agent.router", 30_000);
        if (!c.ok)
            return;
        publish({
            id: uid(),
            ts: now(),
            type: "agent.routing.decision",
            source: "agent.router",
            conversationId,
            payload: { routedTo: "agent.comms", reason: "gmail_default" },
        });
        forwardToAgent("agent.comms", e);
        recordMetric("agent.router", true, now() - start);
    },
]);
subscribers.set("agent.forward.comms", [
    async (e) => {
        const start = now();
        if (!isEnabled("agent.comms"))
            return;
        const original = e.payload?.originalEvent;
        const conversationId = e.conversationId ?? original?.conversationId ?? "unknown";
        const text = String(original?.payload?.text ?? "");
        // Unicode escapes prevent emoji byte-corruption in terminals / HTTP layers
        const preview = text.length > 180 ? text.slice(0, 180) + "\u2026" : text;
        const reply = "\u2705 Comms Agent: Received \"" + preview + "\"";
        publish({
            id: uid(),
            ts: now(),
            type: "message.outgoing.whatsapp",
            source: "agent.comms",
            conversationId,
            payload: { text: reply },
        });
        recordMetric("agent.comms", true, now() - start);
    },
]);
subscribers.set("agent.forward.task", [
    async (e) => {
        const start = now();
        if (!isEnabled("agent.task"))
            return;
        const original = e.payload?.originalEvent;
        const conversationId = e.conversationId ?? original?.conversationId ?? "unknown";
        const text = String(original?.payload?.text ?? "");
        const reply = "\uD83D\uDCC5 Task Agent: I can help with scheduling. You said: \"" +
            (text.length > 180 ? text.slice(0, 180) + "\u2026" : text) +
            "\"";
        publish({
            id: uid(),
            ts: now(),
            type: "message.outgoing.whatsapp",
            source: "agent.task",
            conversationId,
            payload: { text: reply },
        });
        recordMetric("agent.task", true, now() - start);
    },
]);
subscribers.set("agent.forward.memory", [
    async (e) => {
        const start = now();
        if (!isEnabled("agent.memory"))
            return;
        const original = e.payload?.originalEvent;
        const conversationId = e.conversationId ?? original?.conversationId ?? "unknown";
        const text = String(original?.payload?.text ?? "");
        const reply = "\uD83E\uDDE0 Memory Agent: I heard: \"" +
            (text.length > 180 ? text.slice(0, 180) + "\u2026" : text) +
            "\" (memory wiring coming next)";
        publish({
            id: uid(),
            ts: now(),
            type: "message.outgoing.whatsapp",
            source: "agent.memory",
            conversationId,
            payload: { text: reply },
        });
        recordMetric("agent.memory", true, now() - start);
    },
]);
subscribers.set("agent.forward.builder", [
    async (e) => {
        const start = now();
        if (!isEnabled("agent.builder"))
            return;
        const original = e.payload?.originalEvent;
        const conversationId = e.conversationId ?? original?.conversationId ?? "unknown";
        const text = String(original?.payload?.text ?? "");
        const reply = "\uD83D\uDEE0\uFE0F Builder Agent: I can help with UI/config/build tasks. You said: \"" +
            (text.length > 180 ? text.slice(0, 180) + "\u2026" : text) +
            "\"";
        publish({
            id: uid(),
            ts: now(),
            type: "message.outgoing.whatsapp",
            source: "agent.builder",
            conversationId,
            payload: { text: reply },
        });
        recordMetric("agent.builder", true, now() - start);
    },
]);
/** ---------- Worker Executor health polling ---------- */
const WORKER_EXECUTOR_URL = process.env.MC_WORKER_EXECUTOR_URL || "";
const WORKER_EXECUTOR_ENABLED = /^https?:\/\//.test(WORKER_EXECUTOR_URL);
async function pollWorkerExecutor() {
    const a = agents.get("worker.executor.local");
    if (!a)
        return;
    const start = now();
    try {
        const r = await fetch(`${WORKER_EXECUTOR_URL}/health`, { method: "GET" });
        const ok = r.ok;
        a.status = ok ? "running" : "degraded";
        recordMetric("worker.executor.local", ok, now() - start);
        if (!ok) {
            publish({
                id: uid(),
                ts: now(),
                type: "system.health.alert",
                source: "worker.executor.local",
                payload: { message: `Worker executor unhealthy (${r.status})`, url: WORKER_EXECUTOR_URL },
            });
        }
    }
    catch (err) {
        a.status = "stopped";
        recordMetric("worker.executor.local", false, now() - start);
        publish({
            id: uid(),
            ts: now(),
            type: "system.health.alert",
            source: "worker.executor.local",
            payload: {
                message: `Worker executor unreachable: ${String(err?.message ?? err)}`,
                url: WORKER_EXECUTOR_URL,
            },
        });
    }
    finally {
        sseSend("agents", getAgentsArray());
    }
}
if (WORKER_EXECUTOR_ENABLED) {
    setInterval(() => {
        void pollWorkerExecutor();
    }, 5_000);
}
/** ---------- Routes ---------- */
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        name: "openclaw-mission-control-server",
        time: new Date().toISOString(),
        agents: getAgentsArray().length,
        workerExecutorUrl: WORKER_EXECUTOR_ENABLED ? WORKER_EXECUTOR_URL : "DISABLED",
    });
});
app.get("/agents", (_req, res) => {
    res.json({ ok: true, agents: getAgentsArray() });
});
app.post("/agents/:id/toggle", (req, res) => {
    const id = String(req.params.id || "");
    const a = agents.get(id);
    if (!a)
        return res.status(404).json({ ok: false, error: "Agent not found" });
    a.enabled = !a.enabled;
    sseSend("agents", getAgentsArray());
    return res.json({ ok: true, agent: a });
});
app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const id = uid();
    sseClients.set(id, { id, res });
    // initial snapshots
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, id })}\n\n`);
    res.write(`event: agents\ndata: ${JSON.stringify(getAgentsArray())}\n\n`);
    res.write(`event: outbox\ndata: ${JSON.stringify(outbox.slice(-100))}\n\n`);
    res.write(`event: backlog\ndata: ${JSON.stringify(eventLog.slice(-200))}\n\n`);
    req.on("close", () => {
        sseClients.delete(id);
    });
});
const IngressSchema = z.object({
    type: z.string().min(1),
    source: z.string().default("ingress"),
    conversationId: z.string().optional(),
    payload: z.record(z.any()).default({}),
});
app.post("/ingress", (req, res) => {
    const parsed = IngressSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const e = {
        id: uid(),
        ts: now(),
        type: body.type,
        source: body.source,
        conversationId: body.conversationId,
        payload: body.payload,
    };
    publish(e);
    res.json({ ok: true, event: e });
});
const SimSchema = z.object({
    type: z.string().min(1),
    conversationId: z.string().min(1),
    payload: z.record(z.any()).optional(),
    text: z.string().optional(),
});
app.post("/simulate", (req, res) => {
    const parsed = SimSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const payload = body.payload ?? {};
    if (typeof body.text === "string")
        payload.text = body.text;
    const e = {
        id: uid(),
        ts: now(),
        type: body.type,
        source: "simulate",
        conversationId: body.conversationId,
        payload,
    };
    publish(e);
    res.json({ ok: true, event: e });
});
app.get("/outbox", (_req, res) => {
    res.json({ ok: true, outbox: outbox.slice(-200) });
});
const AckSchema = z.object({
    id: z.string().min(1),
    status: z.enum(["acked", "failed"]),
});
app.post("/outbox/ack", (req, res) => {
    const parsed = AckSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const body = parsed.data;
    const item = outbox.find((x) => x.id === body.id);
    if (!item)
        return res.status(404).json({ ok: false, error: "Outbox item not found" });
    item.status = body.status;
    item.ackTs = now();
    sseSend("outbox", outbox.slice(-100));
    return res.json({ ok: true, item });
});
/** ---------- Inbox Routes ---------- */
/**
 * GET /inbox/whatsapp
 * Returns all inbound WhatsApp messages from the in-memory inbox store.
 * Shape: { ok: true, items: InboxItem[] }  — items is ALWAYS an array.
 */
app.get("/inbox/whatsapp", (_req, res) => {
    res.json({ ok: true, items: inbox.slice() });
});
/**
 * GET /inbox
 * Alias of /inbox/whatsapp — returns all inbound WhatsApp messages.
 * Shape: { ok: true, items: InboxItem[] }  — items is ALWAYS an array.
 */
app.get("/inbox", (_req, res) => {
    res.json({ ok: true, items: inbox.slice() });
});
/**
 * GET /api/inbox
 * Matches the path called by the UI WhatsAppInbox component (fetchInbox uses `${baseUrl}/api/inbox`).
 * Returns all inbound WhatsApp messages from the in-memory inbox store.
 * Shape: { ok: true, items: InboxItem[] }  — items is ALWAYS an array.
 */
app.get("/api/inbox", (_req, res) => {
    res.json({ ok: true, items: inbox.slice() });
});
/**
 * GET /api/inbox/stream
 * SSE stream consumed by the UI's WhatsAppInbox component.
 *
 * Protocol:
 *   event: hello     — fires immediately; confirms connection is open
 *   event: snapshot  — fires immediately; full array of current inbox items
 *   event: inbox     — fires for each new inbound WhatsApp message (single InboxItem)
 */
app.get("/api/inbox/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const id = uid();
    inboxSseClients.set(id, { id, res });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(inbox.slice())}\n\n`);
    req.on("close", () => {
        inboxSseClients.delete(id);
    });
});
/** ---------- Meta WhatsApp Webhook ---------- */
/**
 * GET /webhook
 * Meta webhook verification handshake.
 * Meta sends hub.mode, hub.verify_token, hub.challenge as query params.
 * Respond with hub.challenge as plain text when the token matches.
 */
app.get("/webhook", (req, res) => {
    const mode = String(req.query["hub.mode"] ?? "");
    const token = String(req.query["hub.verify_token"] ?? "");
    const challenge = String(req.query["hub.challenge"] ?? "");
    if (mode === "subscribe" && token === (process.env.META_VERIFY_TOKEN ?? "")) {
        // eslint-disable-next-line no-console
        console.log("[mc] Meta webhook verified");
        return res.status(200).type("text/plain").send(challenge);
    }
    // eslint-disable-next-line no-console
    console.warn("[mc] Meta webhook verification failed — bad token or mode");
    return res.status(403).json({ ok: false, error: "Forbidden" });
});
/**
 * POST /webhook
 * Receives inbound WhatsApp messages from the Meta Cloud API.
 * Responds 200 immediately (Meta requires a fast acknowledgement).
 * Extracts sender wa_id, profile name, and message text, then publishes
 * a message.incoming.whatsapp event into the internal event bus.
 *
 * Expected payload shape (Cloud API):
 * {
 *   entry: [{
 *     changes: [{
 *       value: {
 *         contacts: [{ wa_id, profile: { name } }],
 *         messages: [{ from, text: { body }, type }]
 *       }
 *     }]
 *   }]
 * }
 */
app.post("/webhook", (req, res) => {
    // Acknowledge immediately — Meta will retry if we don't respond quickly.
    res.sendStatus(200);
    const body = req.body;
    // eslint-disable-next-line no-console
    console.log("[mc] POST /webhook", JSON.stringify(body));
    try {
        const value = body?.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];
        const contact = value?.contacts?.[0];
        // Only handle inbound text messages; skip status updates and other types.
        if (!message || message.type !== "text")
            return;
        const waId = String(contact?.wa_id ?? message.from ?? "unknown");
        const name = String(contact?.profile?.name ?? "");
        const text = String(message.text?.body ?? "");
        publish({
            id: uid(),
            ts: now(),
            type: "message.incoming.whatsapp",
            source: "meta",
            conversationId: waId,
            payload: { from: waId, name, text },
        });
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error("[mc] POST /webhook parse error", err);
    }
});
/** ---------- Start ---------- */
const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || Number(process.env.MC_SERVER_PORT) || 8787;
app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[mc] Server listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[mc] Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ")} + *.up.railway.app`);
    // eslint-disable-next-line no-console
    console.log(`[mc] Worker executor: ${WORKER_EXECUTOR_ENABLED ? WORKER_EXECUTOR_URL : "DISABLED"}`);
});
