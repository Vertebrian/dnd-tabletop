const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 20 * 1024 * 1024,
  cors: { origin: "*" }
});

const rooms = new Map();

function emptyState() {
  return {
    imgSrc: null,
    map: { x: 100, y: 80, scale: 1, locked: false },
    grid: { x: 0, y: 0, size: 50, opacity: 0.6, color: "rgba(0,0,0,1)", locked: false },
    fogState: { base: "dark", strokes: [] },
    tokens: []
  };
}

function getRoomName(socket) {
  return socket.data.room || "default";
}

function getRoomState(room) {
  if (!rooms.has(room)) rooms.set(room, emptyState());
  return rooms.get(room);
}

function sanitizeRoom(room) {
  return String(room || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "default";
}

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("Client connesso", socket.id);

  socket.on("room:join", (rawRoom, ack) => {
    const room = sanitizeRoom(rawRoom);
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = room;
    socket.join(room);
    const state = getRoomState(room);
    console.log(`Client ${socket.id} entrato nella room ${room}`);
    socket.emit("state:update", { type: "state", sender: "server", ...state });
    if (typeof ack === "function") ack({ ok: true, room });
  });

  socket.on("state:request", () => {
    const room = getRoomName(socket);
    const state = getRoomState(room);
    socket.emit("state:update", { type: "state", sender: "server", ...state });
  });

  socket.on("state:update", (incoming) => {
    const room = getRoomName(socket);
    const state = getRoomState(room);
    if (!incoming) return;

    if (incoming.sender === "player") {
      if (Array.isArray(incoming.tokens)) {
        state.tokens = incoming.tokens;
        socket.to(room).emit("state:update", {
          type: "state",
          sender: "player",
          tokens: state.tokens
        });
      }
      return;
    }

    if (incoming.imgSrc) state.imgSrc = incoming.imgSrc;
    if (incoming.map) state.map = incoming.map;
    if (incoming.grid) state.grid = incoming.grid;
    if (incoming.fogState) state.fogState = incoming.fogState;
    if (Array.isArray(incoming.tokens)) state.tokens = incoming.tokens;

    io.to(room).emit("state:update", { type: "state", sender: "master", ...state });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnesso", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mini VTT attivo su http://localhost:${PORT}`);
});
