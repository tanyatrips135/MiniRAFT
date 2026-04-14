const WebSocket = require("ws");
const { execSync } = require("child_process");

let lastKilledReplica = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed GET ${url}`);
  return res.json();
}

async function findLeaderPort() {
  const ports = [9001, 9002, 9003];
  for (const port of ports) {
    try {
      const data = await getJson(`http://localhost:${port}/status`);
      if (data.role === "Leader") return port;
    } catch {}
  }
  return null;
}

function portToReplica(port) {
  if (port === 9001) return "replica1";
  if (port === 9002) return "replica2";
  if (port === 9003) return "replica3";
  return null;
}

function runDockerCommand(command) {
  execSync(command, { stdio: "inherit" });
}

async function waitForLeaderExcluding(excludedPort, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const leaderPort = await findLeaderPort();
    if (leaderPort && leaderPort !== excludedPort) {
      return leaderPort;
    }
    await delay(200);
  }
  return null;
}

async function sendStrokeBurst(ws, count, prefix, pauseMs) {
  for (let i = 0; i < count; i += 1) {
    ws.send(
      JSON.stringify({
        type: "stroke",
        clientId: "failover-client",
        entryId: `${prefix}-${i}-${Date.now()}`,
        stroke: {
          color: prefix.startsWith("before") ? "#0b6e4f" : "#c75d2c",
          width: 3,
          points: [
            { x: 20 + i * 2, y: 24 + i * 4 },
            { x: 52 + i * 2, y: 44 + i * 4 }
          ]
        }
      })
    );
    await delay(pauseMs);
  }
}

async function run() {
  const ws = new WebSocket("ws://localhost:8080");
  const commits = [];
  let closed = false;
  let killedReplica = null;

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("close", () => {
    closed = true;
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "committed-stroke") {
        commits.push(msg.entry.entryId);
      }
    } catch {}
  });

  await sendStrokeBurst(ws, 4, "before-fail", 70);
  const commitsBeforeKill = commits.length;

  const leaderPort = await findLeaderPort();
  if (!leaderPort) throw new Error("No leader found before failover");

  killedReplica = portToReplica(leaderPort);
  if (!killedReplica) {
    throw new Error(`Could not map leader port ${leaderPort} to replica container`);
  }

  console.log(`Killing active leader ${killedReplica} on port ${leaderPort}`);
  lastKilledReplica = killedReplica;
  runDockerCommand(`docker compose kill ${killedReplica}`);

  const newLeaderPort = await waitForLeaderExcluding(leaderPort, 10000);
  if (!newLeaderPort) {
    throw new Error("No new leader elected after leader kill");
  }
  console.log(`New leader elected on port ${newLeaderPort}`);

  await sendStrokeBurst(ws, 10, "after-fail", 120);

  await delay(3500);

  if (closed) {
    throw new Error("Client disconnected during failover window");
  }

  if (commits.length <= commitsBeforeKill) {
    throw new Error("No additional commits observed after leader kill");
  }

  const unique = new Set(commits);
  if (unique.size !== commits.length) {
    throw new Error("Duplicate committed entries detected");
  }

  console.log(`Restarting killed replica ${killedReplica}`);
  runDockerCommand(`docker compose start ${killedReplica}`);
  lastKilledReplica = null;
  await delay(1500);

  ws.close();
  console.log("Automated failover test passed");
}

run().catch((err) => {
  try {
    if (lastKilledReplica) runDockerCommand(`docker compose start ${lastKilledReplica}`);
  } catch {}
  console.error(err);
  process.exit(1);
});
