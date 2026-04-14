const WebSocket = require("ws");

const CLIENTS = 3;
const STROKES_PER_CLIENT = 5;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStroke(seed) {
  const base = 20 + seed * 5;
  return {
    color: "#0b6e4f",
    width: 3,
    points: [
      { x: base, y: base },
      { x: base + 12, y: base + 10 },
      { x: base + 22, y: base + 18 }
    ]
  };
}

async function run() {
  const sockets = [];
  const receivedByClient = [];

  for (let i = 0; i < CLIENTS; i += 1) {
    receivedByClient.push([]);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://localhost:8080");
      ws.on("open", () => resolve());
      ws.on("error", reject);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "committed-stroke") {
            receivedByClient[i].push(msg.entry.entryId);
          }
        } catch {}
      });
      sockets.push(ws);
    });
  }

  for (let client = 0; client < CLIENTS; client += 1) {
    for (let j = 0; j < STROKES_PER_CLIENT; j += 1) {
      const entryId = `smoke-${client}-${j}-${Date.now()}`;
      sockets[client].send(
        JSON.stringify({
          type: "stroke",
          clientId: `smoke-client-${client}`,
          entryId,
          stroke: makeStroke(client * 10 + j)
        })
      );
      await delay(30);
    }
  }

  await delay(2500);

  const expected = CLIENTS * STROKES_PER_CLIENT;
  const baseline = receivedByClient[0];
  if (baseline.length < expected) {
    throw new Error(`Expected at least ${expected} commits, got ${baseline.length}`);
  }

  for (let i = 1; i < CLIENTS; i += 1) {
    if (receivedByClient[i].length !== baseline.length) {
      throw new Error("Client commit counts diverged");
    }

    for (let k = 0; k < baseline.length; k += 1) {
      if (receivedByClient[i][k] !== baseline[k]) {
        throw new Error("Commit ordering diverged across clients");
      }
    }
  }

  for (const ws of sockets) {
    ws.close();
  }

  console.log("Smoke test passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
