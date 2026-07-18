const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Le mappe in base64 possono essere grandi, ma gli aggiornamenti frequenti
  // ora viaggiano come delta piccoli invece che come stato completo.
  maxHttpBufferSize: 20 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: "*" }
});

const rooms = new Map();

const MAX_DRAWINGS = 3000;
const MAX_POINTS_PER_DRAWING = 1200;
const MAX_FOG_STROKES = 5000;
const MAX_TOKENS = 600;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function makeId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizePoint(p) {
  if (!p || typeof p !== "object") return null;
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function decimatePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function sanitizeDrawing(d) {
  if (!d || typeof d !== "object") return null;
  const type = ["pen", "rect", "circle"].includes(d.type) ? d.type : "pen";
  const base = {
    id: String(d.id || makeId("draw")),
    type,
    color: typeof d.color === "string" ? d.color.slice(0, 80) : "rgba(0,0,0,1)",
    size: clampNumber(d.size, 1, 300, 4)
  };

  if (type === "pen") {
    const points = Array.isArray(d.points) ? d.points.map(sanitizePoint).filter(Boolean) : [];
    if (points.length < 2) return null;
    base.points = decimatePoints(points, MAX_POINTS_PER_DRAWING);
  } else if (type === "rect") {
    base.x = clampNumber(d.x, -1e7, 1e7, 0);
    base.y = clampNumber(d.y, -1e7, 1e7, 0);
    base.w = clampNumber(d.w, -1e7, 1e7, 0);
    base.h = clampNumber(d.h, -1e7, 1e7, 0);
  } else if (type === "circle") {
    base.cx = clampNumber(d.cx, -1e7, 1e7, 0);
    base.cy = clampNumber(d.cy, -1e7, 1e7, 0);
    base.rx = clampNumber(d.rx, -1e7, 1e7, 0);
    base.ry = clampNumber(d.ry, -1e7, 1e7, 0);
  }
  return base;
}

function sanitizeDrawings(drawings) {
  if (!Array.isArray(drawings)) return [];
  return drawings
    .slice(-MAX_DRAWINGS)
    .map(sanitizeDrawing)
    .filter(Boolean);
}

function sanitizeFogStroke(stroke) {
  if (!stroke || typeof stroke !== "object") return null;
  const kind = stroke.kind === "rect" ? "rect" : "circle";
  const out = {
    kind,
    op: stroke.op === "hide" ? "hide" : "reveal",
    x: clampNumber(stroke.x, -1e7, 1e7, 0),
    y: clampNumber(stroke.y, -1e7, 1e7, 0)
  };
  if (kind === "rect") {
    out.w = clampNumber(stroke.w, -1e7, 1e7, 0);
    out.h = clampNumber(stroke.h, -1e7, 1e7, 0);
  } else {
    out.r = clampNumber(stroke.r, 0, 1e7, 1);
  }
  return out;
}

function sanitizeFogState(fogState) {
  const fog = fogState && typeof fogState === "object" ? fogState : {};
  return {
    base: fog.base === "clear" ? "clear" : "dark",
    color: fog.color === "white" ? "white" : "black",
    strokes: Array.isArray(fog.strokes)
      ? fog.strokes.slice(-MAX_FOG_STROKES).map(sanitizeFogStroke).filter(Boolean)
      : []
  };
}

function sanitizeMap(map) {
  const m = map && typeof map === "object" ? map : {};
  return {
    x: clampNumber(m.x, -1e7, 1e7, 100),
    y: clampNumber(m.y, -1e7, 1e7, 80),
    scale: clampNumber(m.scale, 0.01, 50, 1),
    locked: Boolean(m.locked)
  };
}

function sanitizeGrid(grid) {
  const g = grid && typeof grid === "object" ? grid : {};
  return {
    x: clampNumber(g.x, -1e7, 1e7, 0),
    y: clampNumber(g.y, -1e7, 1e7, 0),
    size: clampNumber(g.size, 2, 5000, 50),
    opacity: clampNumber(g.opacity, 0, 1, 1),
    color: typeof g.color === "string" ? g.color.slice(0, 80) : "rgba(0,0,0,1)",
    locked: Boolean(g.locked)
  };
}

function sanitizeToken(token) {
  if (!token || typeof token !== "object") return null;
  return {
    id: String(token.id || makeId("token")),
    label: String(token.label || "Pedina").slice(0, 60),
    type: token.type === "png" ? "png" : "pg",
    w: clampNumber(token.w, 1, 20, 1),
    h: clampNumber(token.h, 1, 20, 1),
    gx: clampNumber(token.gx, -100000, 100000, 0),
    gy: clampNumber(token.gy, -100000, 100000, 0),
    icon: typeof token.icon === "string" ? token.icon.slice(0, 500) : null,
    assetId: typeof token.assetId === "string" ? token.assetId.slice(0, 80) : null
  };
}

function sanitizeTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  return tokens.slice(-MAX_TOKENS).map(sanitizeToken).filter(Boolean);
}

function makeDefaultScene() {
  return {
    id: "scene-1",
    name: "Scena 1",
    imgSrc: null,
    map: { x: 100, y: 80, scale: 1, locked: false },
    grid: { x: 0, y: 0, size: 50, opacity: 1, color: "rgba(0,0,0,1)", locked: false },
    fogState: { base: "dark", color: "black", strokes: [] },
    drawings: [],
    tokens: []
  };
}

function sanitizeScene(scene, fallbackId = "scene-1") {
  const s = scene && typeof scene === "object" ? scene : {};
  return {
    id: String(s.id || fallbackId),
    name: String(s.name || "Scena").slice(0, 80),
    imgSrc: typeof s.imgSrc === "string" && s.imgSrc ? s.imgSrc : null,
    map: sanitizeMap(s.map),
    grid: sanitizeGrid(s.grid),
    fogState: sanitizeFogState(s.fogState),
    drawings: sanitizeDrawings(s.drawings),
    tokens: sanitizeTokens(s.tokens)
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
    drawings: scene.drawings,
    tokens: scene.tokens
  };
}

function normalizeState(state) {
  if (!state || typeof state !== "object") state = emptyState();
  if (!state.scenes || typeof state.scenes !== "object") {
    const scene = sanitizeScene({
      id: "scene-1",
      name: "Scena 1",
      imgSrc: state.imgSrc || null,
      map: state.map,
      grid: state.grid,
      fogState: state.fogState,
      drawings: state.drawings,
      tokens: state.tokens
    }, "scene-1");
    state.currentSceneId = scene.id;
    state.scenes = { [scene.id]: scene };
  } else {
    const cleanScenes = {};
    for (const [id, scene] of Object.entries(state.scenes)) {
      const clean = sanitizeScene({ ...scene, id: scene?.id || id }, id);
      cleanScenes[clean.id] = clean;
    }
    state.scenes = cleanScenes;
    if (!state.currentSceneId || !state.scenes[state.currentSceneId]) {
      state.currentSceneId = Object.keys(state.scenes)[0] || "scene-1";
    }
    if (!state.scenes[state.currentSceneId]) {
      const scene = makeDefaultScene();
      state.currentSceneId = scene.id;
      state.scenes = { [scene.id]: scene };
    }
  }
  return syncTopLevel(state);
}

function syncTopLevel(state) {
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
  normalizeState(state);
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

function makePartialClientState(state, sceneId, src, opts = {}) {
  const scene = state.scenes?.[sceneId] || state.scenes?.[state.currentSceneId] || Object.values(state.scenes || {})[0] || makeDefaultScene();
  const scenePayload = { id: scene.id, name: scene.name };
  const out = { currentSceneId: scene.id, scene: scenePayload };

  if (opts.includeImage) {
    scenePayload.imgSrc = scene.imgSrc || null;
    out.imgSrc = scenePayload.imgSrc;
  }
  if (hasOwn(src, "map")) {
    scenePayload.map = scene.map;
    out.map = scene.map;
  }
  if (hasOwn(src, "grid")) {
    scenePayload.grid = scene.grid;
    out.grid = scene.grid;
  }
  if (hasOwn(src, "fogState")) {
    scenePayload.fogState = scene.fogState;
    out.fogState = scene.fogState;
  }
  if (hasOwn(src, "tokens")) {
    scenePayload.tokens = scene.tokens || [];
    out.tokens = scenePayload.tokens;
  }
  if (opts.includeDrawings) {
    scenePayload.drawings = scene.drawings || [];
    out.drawings = scenePayload.drawings;
  }
  return out;
}

function getRoomName(socket) {
  return socket.data.room || "default";
}

function getRoomState(room) {
  if (!rooms.has(room)) rooms.set(room, emptyState());
  return rooms.get(room);
}

function getOrCreateScene(state, sceneId, name = "Scena") {
  if (!state.scenes || typeof state.scenes !== "object") normalizeState(state);
  if (!state.scenes[sceneId]) {
    state.scenes[sceneId] = sanitizeScene({ ...makeDefaultScene(), id: sceneId, name }, sceneId);
  }
  return state.scenes[sceneId];
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
    getRoomState(room);
    console.log(`Client ${socket.id} entrato nella room ${room}`);
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
    if (!incoming || typeof incoming !== "object") return;

    if (incoming.sender === "player") {
      const sceneId = incoming.currentSceneId || state.currentSceneId;
      if (Array.isArray(incoming.tokens)) {
        const scene = getOrCreateScene(state, sceneId);
        scene.tokens = sanitizeTokens(incoming.tokens);
        syncTopLevel(state);
        socket.to(room).emit("state:update", {
          type: "state",
          sender: "player",
          currentSceneId: sceneId,
          tokens: scene.tokens
        });
      }
      return;
    }

    if (incoming.scenes && typeof incoming.scenes === "object") {
      // Import completo campagna: raro, ma supportato.
      state.scenes = incoming.scenes;
      state.currentSceneId = incoming.currentSceneId || state.currentSceneId;
      normalizeState(state);
      socket.to(room).emit("state:update", { type: "state", sender: "master", ...makeClientState(state, true) });
      return;
    }

    const src = incoming.scene || incoming;
    const sceneId = incoming.currentSceneId || src.id || state.currentSceneId;
    state.currentSceneId = sceneId;
    const scene = getOrCreateScene(state, sceneId, src.name || "Scena");

    if (typeof src.name === "string" && src.name.trim()) scene.name = src.name.slice(0, 80);
    if (hasOwn(src, "imgSrc") && typeof src.imgSrc === "string" && src.imgSrc) scene.imgSrc = src.imgSrc;
    if (hasOwn(src, "map")) scene.map = sanitizeMap(src.map);
    if (hasOwn(src, "grid")) scene.grid = sanitizeGrid(src.grid);
    if (hasOwn(src, "fogState")) scene.fogState = sanitizeFogState(src.fogState);
    if (hasOwn(src, "drawings") && Array.isArray(src.drawings)) scene.drawings = sanitizeDrawings(src.drawings);
    if (hasOwn(src, "tokens") && Array.isArray(src.tokens)) scene.tokens = sanitizeTokens(src.tokens);
    syncTopLevel(state);

    const includeImage = Boolean(hasOwn(src, "imgSrc") && src.imgSrc);
    const includeDrawings = Array.isArray(src.drawings);
    const outgoing = makePartialClientState(state, sceneId, src, { includeImage, includeDrawings });
    socket.to(room).emit("state:update", { type: "state", sender: "master", ...outgoing });
  });

  socket.on("drawing:add", (data) => {
    if (!data || typeof data !== "object") return;
    const room = getRoomName(socket);
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    const drawing = sanitizeDrawing(data.drawing);
    if (!drawing) return;

    if (!scene.drawings.some((d) => d.id && d.id === drawing.id)) {
      scene.drawings.push(drawing);
      if (scene.drawings.length > MAX_DRAWINGS) scene.drawings.splice(0, scene.drawings.length - MAX_DRAWINGS);
      syncTopLevel(state);
    }
    socket.to(room).emit("drawing:add", { sender: "master", sceneId, drawing });
  });

  socket.on("drawings:replace", (data) => {
    if (!data || typeof data !== "object") return;
    const room = getRoomName(socket);
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    scene.drawings = sanitizeDrawings(data.drawings);
    syncTopLevel(state);
    socket.to(room).emit("drawings:replace", { sender: "master", sceneId, drawings: scene.drawings });
  });

  socket.on("drawings:clear", (data = {}) => {
    const room = getRoomName(socket);
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    scene.drawings = [];
    syncTopLevel(state);
    socket.to(room).emit("drawings:clear", { sender: "master", sceneId });
  });

  socket.on("fog:append", (data) => {
    if (!data || typeof data !== "object" || !Array.isArray(data.strokes)) return;
    const room = getRoomName(socket);
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    const strokes = data.strokes.map(sanitizeFogStroke).filter(Boolean);
    if (!strokes.length) return;
    scene.fogState = sanitizeFogState(scene.fogState);
    scene.fogState.strokes.push(...strokes);
    if (scene.fogState.strokes.length > MAX_FOG_STROKES) {
      scene.fogState.strokes.splice(0, scene.fogState.strokes.length - MAX_FOG_STROKES);
    }
    syncTopLevel(state);
    socket.to(room).emit("fog:append", { sender: "master", sceneId, strokes });
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
        token.gx = clampNumber(data.gx, -100000, 100000, token.gx || 0);
        token.gy = clampNumber(data.gy, -100000, 100000, token.gy || 0);
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
