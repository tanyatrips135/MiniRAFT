const WebSocket = require("ws");
const { execSync } = require("child_process");

const REPLICA_PORTS = {
  replica1: 9001,
  replica2: 9002,
  replica3: 9003
};

const COMPOSE_FILE = process.env.COMPOSE_FILE || "../docker-compose.yml";
let stoppedReplica = null;

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerCompose(args) {
  execSync(`docker compose -f "${COMPOSE_FILE}" ${args}`, { stdio: "inherit" });
}

async function getStatus(port) {
  const res = await fetch(`http://localhost:${port}/status`);
  if (!res.ok) throw new Error(`status failed for ${port}`);
  return res.json();
}

async function getStatusSafe(port) {
  try {
    return await getStatus(port);
  } catch {
    return null;
  }
}

async function getClusterStatuses() {
  const ports = Object.values(REPLICA_PORTS);
  return Promise.all(ports.map((port) => getStatusSafe(port)));
}

async function waitFor(checkFn, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await checkFn();
    if (ok) return true;
    await delay(intervalMs);
  }
  return false;
}

function chooseFollowerToRestart(statuses) {
  const followers = statuses.filter((s) => s && s.role !== "Leader");
  if (followers.length === 0) return null;
  followers.sort((a, b) => a.commitIndex - b.commitIndex);
  return followers[0];
}

function makeStroke(seed) {
  const base = 30 + seed * 3;
  return {
    color: "#225ea8",
    width: 3,
    points: [
      { x: base, y: base },
      { x: base + 12, y: base + 9 },
      { x: base + 24, y: base + 18 }
    ]
  };
}

async function sendWritesThroughGateway(count, prefix) {
  const ws = new WebSocket("ws://localhost:8080");
  let committedCount = 0;

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "committed-stroke" && msg.entry?.entryId?.startsWith(prefix)) {
        committedCount += 1;
      }
    } catch {}
  });

  for (let i = 0; i < count; i += 1) {
    ws.send(
      JSON.stringify({
        type: "stroke",
        clientId: "restart-sync-client",
        entryId: `${prefix}-${i}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        stroke: makeStroke(i)
      })
    );
    await delay(70);
  }

  await delay(2500);
  ws.close();
  return committedCount;
}

async function run() {
  const initial = await getClusterStatuses();
  if (initial.some((s) => s === null)) {
    throw new Error("All three replicas must be healthy before running restart-sync");
  }

  const leader = initial.find((s) => s.role === "Leader");
  if (!leader) throw new Error("No leader found");

  const targetFollower = chooseFollowerToRestart(initial);
  if (!targetFollower) throw new Error("No follower available to restart");

  const targetReplica = targetFollower.nodeId;
  const targetPort = REPLICA_PORTS[targetReplica];
  const beforeMaxCommit = Math.max(...initial.map((s) => s.commitIndex));

  console.log(`Leader is ${leader.nodeId}. Restarting follower ${targetReplica}.`);

  stoppedReplica = targetReplica;
  dockerCompose(`kill ${targetReplica}`);

  const wentDown = await waitFor(async () => {
    const st = await getStatusSafe(targetPort);
    return st === null;
  }, 8000, 250);

  if (!wentDown) {
    throw new Error(`Follower ${targetReplica} did not go down after kill`);
  }

  const committedDuringDowntime = await sendWritesThroughGateway(12, "restart-sync");
  if (committedDuringDowntime === 0) {
    throw new Error("No committed writes observed while follower was down");
  }

  const midStatuses = await getClusterStatuses();
  const midAvailable = midStatuses.filter(Boolean);
  const midMaxCommit = Math.max(...midAvailable.map((s) => s.commitIndex));

  if (midMaxCommit <= beforeMaxCommit) {
    throw new Error("Cluster commit index did not advance while follower was down");
  }

  dockerCompose(`start ${targetReplica}`);
  stoppedReplica = null;

  const cameBack = await waitFor(async () => {
    const st = await getStatusSafe(targetPort);
    return st !== null;
  }, 12000, 300);

  if (!cameBack) {
    throw new Error(`Follower ${targetReplica} did not come back after start`);
  }

  const caughtUp = await waitFor(async () => {
    const statuses = await getClusterStatuses();
    if (statuses.some((s) => s === null)) return false;

    const maxCommit = Math.max(...statuses.map((s) => s.commitIndex));
    const maxLogLength = Math.max(...statuses.map((s) => s.logLength));
    const target = statuses.find((s) => s.nodeId === targetReplica);
    if (!target) return false;

    return target.commitIndex === maxCommit && target.logLength === maxLogLength;
  }, 20000, 500);

  if (!caughtUp) {
    const finalStatuses = await getClusterStatuses();
    const target = finalStatuses.find((s) => s && s.nodeId === targetReplica);
    const maxCommit = Math.max(...finalStatuses.filter(Boolean).map((s) => s.commitIndex));
    throw new Error(
      `Follower ${targetReplica} did not catch up in time. targetCommit=${target?.commitIndex}, expected=${maxCommit}`
    );
  }

  console.log("Automated restart-sync test passed");
}

run().catch((err) => {
  try {
    if (stoppedReplica) {
      dockerCompose(`start ${stoppedReplica}`);
    }
  } catch {}

  console.error(err);
  process.exit(1);
});
