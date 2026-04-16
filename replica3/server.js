const express = require("express");
const { RaftNode } = require("./raftNode");

const app = express();
app.use(express.json({ limit: "1mb" }));

const nodeId = process.env.REPLICA_ID || "replica3";
const port = Number(process.env.PORT || 9003);
const selfUrl = process.env.SELF_URL || `http://${nodeId}:${port}`;
const gatewayUrl = process.env.GATEWAY_URL || "http://gateway:8080";
const electionMinMs = Number(process.env.ELECTION_MIN_MS || 500);
const electionMaxMs = Number(process.env.ELECTION_MAX_MS || 800);
const heartbeatMs = Number(process.env.HEARTBEAT_MS || 150);

const peers = (process.env.PEERS || "")
  .split(",")
  .map((raw) => raw.trim())
  .filter(Boolean)
  .map((item) => {
    const [id, url] = item.split("=");
    return { id, url };
  })
  .filter((peer) => peer.id !== nodeId);

const raft = new RaftNode({
  nodeId,
  port,
  selfUrl,
  gatewayUrl,
  peers,
  electionMinMs,
  electionMaxMs,
  heartbeatMs
});

raft.start();

app.get("/status", (_req, res) => {
  res.json(raft.status());
});

app.post("/request-vote", (req, res) => {
  const result = raft.handleRequestVote(req.body || {});
  res.json(result);
});

app.post("/heartbeat", (req, res) => {
  const result = raft.handleHeartbeat(req.body || {});
  res.json(result);
});

app.post("/append-entries", (req, res) => {
  const result = raft.handleAppendEntries(req.body || {});
  res.json(result);
});

app.post("/sync-log", (req, res) => {
  const result = raft.handleSyncLog(req.body || {});
  res.json(result);
});

app.post("/client-entry", async (req, res) => {
  if (raft.role !== "Leader") {
    return res.status(409).json({
      ok: false,
      error: "Not leader",
      leaderId: raft.leaderId,
      leaderUrl: raft.leaderUrl
    });
  }

  const { entryId, stroke } = req.body || {};
  if (!entryId || !stroke) {
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  const result = await raft.replicateEntry({ entryId, stroke });
  if (!result.success) {
    return res.status(503).json({ ok: false, error: result.error || "Commit failed" });
  }

  return res.json({ ok: true, committed: true, entry: result.entry });
});

const server = app.listen(port, () => {
  console.log(`[${nodeId}] replica-started on ${port}`);
});

function shutdown() {
  console.log(`[${nodeId}] replica-stopped on ${port}`);
  raft.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
