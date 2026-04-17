const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const canvas = document.getElementById("board");
const colorPicker = document.getElementById("color");
const widthPicker = document.getElementById("width");
const clearBtn = document.getElementById("clearLocal");

const ctx = canvas.getContext("2d");
const committedStrokes = [];
const renderedEntries = new Set();
const clientId = `client-${Math.random().toString(16).slice(2)}`;

let ws = null;
let reconnectTimer = null;
let isDrawing = false;
let currentStroke = null;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * window.devicePixelRatio);
  canvas.height = Math.floor(rect.height * window.devicePixelRatio);
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  redrawCommittedBoard();
}

function setStatus(state, text) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = text;
}

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.hostname}:8080`;
}

function connect() {
  ws = new WebSocket(wsUrl());
  setStatus("connecting", "Connecting...");

  ws.addEventListener("open", () => {
    setStatus("connected", "Connected");
  });

  ws.addEventListener("close", () => {
    setStatus("disconnected", "Disconnected - retrying");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 900);
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "board-state" && Array.isArray(msg.entries)) {
      committedStrokes.length = 0;
      renderedEntries.clear();
      for (const entry of msg.entries) {
        if (!entry || !entry.entryId || !entry.stroke) continue;
        if (renderedEntries.has(entry.entryId)) continue;
        renderedEntries.add(entry.entryId);
        committedStrokes.push(entry.stroke);
      }
      redrawCommittedBoard();
    }

    if (msg.type === "committed-stroke" && msg.entry) {
      const { entryId, stroke } = msg.entry;
      if (!renderedEntries.has(entryId)) {
        renderedEntries.add(entryId);
        committedStrokes.push(stroke);
        drawStroke(stroke);
      }
    }

    if (msg.type === "gateway-backpressure") {
      redrawCommittedBoard();
    }
  });
}

function relativePoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function drawStroke(stroke) {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

  for (let i = 1; i < stroke.points.length; i += 1) {
    const p = stroke.points[i];
    ctx.lineTo(p.x, p.y);
  }

  ctx.stroke();
}

function redrawCommittedBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of committedStrokes) {
    drawStroke(stroke);
  }
}

function startDrawing(event) {
  isDrawing = true;
  const point = relativePoint(event);
  currentStroke = {
    color: colorPicker.value,
    width: Number(widthPicker.value),
    points: [point]
  };
}

function continueDrawing(event) {
  if (!isDrawing || !currentStroke) return;

  const point = relativePoint(event);
  const prev = currentStroke.points[currentStroke.points.length - 1];
  currentStroke.points.push(point);

  ctx.strokeStyle = currentStroke.color;
  ctx.lineWidth = currentStroke.width;
  ctx.beginPath();
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
}

function finishDrawing() {
  if (!isDrawing || !currentStroke) return;

  isDrawing = false;
  if (currentStroke.points.length < 2) {
    currentStroke = null;
    return;
  }

  const entryId = `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "stroke",
        clientId,
        entryId,
        stroke: currentStroke
      })
    );
  }

  redrawCommittedBoard();

  currentStroke = null;
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  startDrawing(e);
});
canvas.addEventListener("pointermove", continueDrawing);
canvas.addEventListener("pointerup", finishDrawing);
canvas.addEventListener("pointercancel", finishDrawing);
canvas.addEventListener("pointerleave", finishDrawing);

clearBtn.addEventListener("click", () => {
  committedStrokes.length = 0;
  renderedEntries.clear();
  redrawCommittedBoard();
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
connect();
