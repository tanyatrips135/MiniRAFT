const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);
const REPLICA_URLS = (process.env.REPLICA_URLS || "http://replica1:9001,http://replica2:9002,http://replica3:9003,http://replica4:9004")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let activeLeaderUrl = null;
let activeLeaderId = null;
let isShuttingDown = false;

const clients = new Set();
const committedCache = new Set();
const committedEntries = [];

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(payload) {
  for (const ws of clients) {
    sendJson(ws, payload);
  }
}

async function postJson(url, body, timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function getStatus(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    const res = await fetch(`${url}/status`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLeader() {
  const statuses = await Promise.all(REPLICA_URLS.map((url) => getStatus(url)));

  for (let i = 0; i < statuses.length; i += 1) {
    const st = statuses[i];
    if (st && st.role === "Leader") {
      activeLeaderUrl = REPLICA_URLS[i];
      activeLeaderId = st.nodeId;
      return true;
    }
  }

  let highestTerm = -1;
  let hintedLeader = null;
  for (const st of statuses) {
    if (!st) continue;
    if (st.term > highestTerm && st.leaderUrl) {
      highestTerm = st.term;
      hintedLeader = st.leaderUrl;
    }
  }

  if (hintedLeader) {
    activeLeaderUrl = hintedLeader;
    activeLeaderId = null;
    return true;
  }

  activeLeaderUrl = null;
  activeLeaderId = null;
  return false;
}

async function forwardStrokeToLeader(strokeEnvelope) {
  if (!activeLeaderUrl) {
    await discoverLeader();
  }

  if (!activeLeaderUrl) {
    return { ok: false, error: "No leader available" };
  }

  try {
    let response = await postJson(`${activeLeaderUrl}/client-entry`, strokeEnvelope, 1200);

    if (!response.ok && response.status === 409 && response.data && response.data.leaderUrl) {
      activeLeaderUrl = response.data.leaderUrl;
      response = await postJson(`${activeLeaderUrl}/client-entry`, strokeEnvelope, 1200);
    }

    if (!response.ok) {
      await discoverLeader();
      return { ok: false, error: "Leader rejected entry" };
    }

    return { ok: true };
  } catch {
    await discoverLeader();
    return { ok: false, error: "Leader unreachable" };
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, leaderUrl: activeLeaderUrl, leaderId: activeLeaderId });
});

app.post("/committed", (req, res) => {
  const { entry } = req.body;
  if (!entry || !entry.entryId || !entry.stroke) {
    return res.status(400).json({ ok: false, error: "Invalid commit payload" });
  }

  if (!committedCache.has(entry.entryId)) {
    committedCache.add(entry.entryId);
    committedEntries.push(entry);
    if (committedEntries.length > 5000) {
      committedEntries.shift();
    }
    if (committedCache.size > 5000) {
      const first = committedCache.values().next().value;
      committedCache.delete(first);
    }

    broadcast({
      type: "committed-stroke",
      entry
    });
  }

  return res.json({ ok: true });
});

wss.on("connection", (ws) => {
  clients.add(ws);
  sendJson(ws, {
    type: "gateway-status",
    leaderUrl: activeLeaderUrl,
    leaderId: activeLeaderId
  });
  sendJson(ws, {
    type: "board-state",
    entries: committedEntries
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      sendJson(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    if (msg.type !== "stroke") {
      return;
    }

    const strokeEnvelope = {
      stroke: msg.stroke,
      entryId: msg.entryId,
      clientId: msg.clientId,
      sentAt: Date.now()
    };

    const result = await forwardStrokeToLeader(strokeEnvelope);
    if (!result.ok) {
      sendJson(ws, {
        type: "gateway-backpressure",
        error: result.error
      });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

const leaderPoll = setInterval(() => {
  discoverLeader().catch(() => {});
}, 700);

server.listen(PORT, () => {
  console.log(`[gateway] listening on ${PORT}`);
  discoverLeader().catch(() => {});
});

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(leaderPoll);

  for (const ws of clients) {
    try {
      ws.close();
    } catch {}
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
