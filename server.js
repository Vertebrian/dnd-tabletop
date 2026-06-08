const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 20 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: "*" }
});

const rooms = new Map();

function makeDefaultScene() {
  return {
    id: "scene-1",
    name: "Scena 1",
    imgSrc: null,
    map: { x: 100, y: 80, scale: 1, locked: false },
    grid: { x: 0, y: 0, size: 50, opacity: 1, color: "rgba(0,0,0,1)", locked: false },
    fogState: { base: "dark", strokes: [] },
    drawings: [],
    tokens: []
  };
}

function emptyState() {
  const scene = makeDefaultScene();
  return {
    currentSceneId: scene.id,
    scenes: { [scene.id]: scene },
    imgSrc: scene.imgSrc,
    map: scene.map,
    grid: scene.grid,
    fogState: scene.fogState,
    tokens: scene.tokens
  };
}

function normalizeState(state) {
  if (!state.scenes) {
    const scene = {
      id: "scene-1",
      name: "Scena 1",
      imgSrc: state.imgSrc || null,
      map: state.map || { x: 100, y: 80, scale: 1, locked: false },
      grid: state.grid || { x: 0, y: 0, size: 50, opacity: 1, color: "rgba(0,0,0,1)", locked: false },
      fogState: state.fogState || { base: "dark", strokes: [] },
      drawings: Array.isArray(state.drawings) ? state.drawings : [],
      tokens: Array.isArray(state.tokens) ? state.tokens : []
    };
    state.currentSceneId = scene.id;
    state.scenes = { [scene.id]: scene };
  }
  return state;
}

function syncTopLevel(state) {
  normalizeState(state);
  const scene = state.scenes[state.currentSceneId] || Object.values(state.scenes)[0];
  if (!scene) return state;
  state.currentSceneId = scene.id;
  state.imgSrc = scene.imgSrc || null;
  state.map = scene.map;
  state.grid = scene.grid;
  state.fogState = scene.fogState;
  state.drawings = scene.drawings || [];
  state.tokens = scene.tokens || [];
  return state;
}

function makeClientState(state, includeAllScenes = false) {
  syncTopLevel(state);
  const scene = state.scenes[state.currentSceneId] || Object.values(state.scenes)[0] || makeDefaultScene();
  const scenePayload = {
    id: scene.id,
    name: scene.name,
    imgSrc: scene.imgSrc || null,
    map: scene.map,
    grid: scene.grid,
    fogState: scene.fogState,
    drawings: scene.drawings || [],
    tokens: scene.tokens || []
  };

  const out = {
    currentSceneId: scene.id,
    scene: scenePayload,
    imgSrc: scenePayload.imgSrc,
    map: scenePayload.map,
    grid: scenePayload.grid,
    fogState: scenePayload.fogState,
    drawings: scenePayload.drawings,
    tokens: scenePayload.tokens
  };

  if (includeAllScenes) out.scenes = state.scenes;
  return out;
}

function getRoomName(socket) {
  return socket.data.room || "default";
}

function getRoomState(room) {
  if (!rooms.has(room)) rooms.set(room, emptyState());
  return normalizeState(rooms.get(room));
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
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

io.on("connection", (socket) => {
  console.log("Client connesso", socket.id);

  socket.on("room:join", (rawRoom, ack) => {
    const room = sanitizeRoom(rawRoom);
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = room;
    socket.join(room);
    const state = getRoomState(room);
    console.log(`Client ${socket.id} entrato nella room ${room}`);
    socket.emit("state:update", { type: "state", sender: "server", ...makeClientState(state, false) });
    if (typeof ack === "function") ack({ ok: true, room });
  });

  socket.on("state:request", (opts = {}) => {
    const room = getRoomName(socket);
    const state = getRoomState(room);
    socket.emit("state:update", {
      type: "state",
      sender: "server",
      ...makeClientState(state, Boolean(opts.full))
    });
  });

  socket.on("state:update", (incoming) => {
    const room = getRoomName(socket);
    const state = getRoomState(room);
    if (!incoming) return;

    if (incoming.sender === "player") {
      const sceneId = incoming.currentSceneId || state.currentSceneId;
      if (Array.isArray(incoming.tokens)) {
        normalizeState(state);
        if (state.scenes[sceneId]) state.scenes[sceneId].tokens = incoming.tokens;
        syncTopLevel(state);
        socket.to(room).emit("state:update", {
          type: "state",
          sender: "player",
          currentSceneId: sceneId,
          tokens: incoming.tokens
        });
      }
      return;
    }

    if (incoming.scenes) {
      // Import completo campagna: raro, ma supportato.
      state.scenes = incoming.scenes;
      state.currentSceneId = incoming.currentSceneId || state.currentSceneId;
      syncTopLevel(state);
      io.to(room).emit("state:update", { type: "state", sender: "master", ...makeClientState(state, true) });
      return;
    }

    const sceneId = incoming.currentSceneId || state.currentSceneId;
    if (!state.scenes[sceneId]) {
      state.scenes[sceneId] = { ...makeDefaultScene(), id: sceneId, name: incoming.scene?.name || "Scena" };
    }
    state.currentSceneId = sceneId;
    const scene = state.scenes[sceneId];
    const src = incoming.scene || incoming;

    if (src.name) scene.name = src.name;
    if (src.imgSrc) scene.imgSrc = src.imgSrc;
    if (src.map) scene.map = src.map;
    if (src.grid) scene.grid = src.grid;
    if (src.fogState) scene.fogState = src.fogState;
    if (Array.isArray(src.drawings)) scene.drawings = src.drawings;
    if (Array.isArray(src.tokens)) scene.tokens = src.tokens;
    syncTopLevel(state);

    const includeImage = Boolean(src.imgSrc);
    const outgoing = makeClientState(state, false);
    if (!includeImage && outgoing.scene) outgoing.scene.imgSrc = null;
    if (!includeImage) outgoing.imgSrc = null;
    io.to(room).emit("state:update", { type: "state", sender: "master", ...outgoing });
  });

  socket.on("token:move", (data) => {
    const room = getRoomName(socket);
    if (!data?.id) return;

    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = state.scenes[sceneId];
    if (scene && Array.isArray(scene.tokens)) {
      const token = scene.tokens.find(t => t.id === data.id);
      if (token) {
        token.gx = data.gx;
        token.gy = data.gy;
      }
    }

    socket.to(room).emit("token:move", data);
  });

  socket.on("client:keepalive", (data, ack) => {
    socket.data.lastKeepalive = Date.now();
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnesso", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`D&D TableTop attivo su http://localhost:${PORT}`);
});
