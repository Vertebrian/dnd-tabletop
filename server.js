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
  // Timer di heartbeat: abbastanza stretti da rilevare una connessione
  // morta in silenzio entro ~15-25s (invece che fino a 60s), ma non cosi'
  // aggressivi da scambiare un normale rallentamento di rete per una
  // disconnessione (cosa che causava falsi "server non risponde" al
  // rientro in stanza).
  pingInterval: 15000,
  pingTimeout: 25000,
  cors: { origin: "*" }
});

const rooms = new Map();
const roomOperations = new Map();

const MAX_RECENT_OPERATIONS = 2000;
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    revision: 0,
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
  state.revision = clampNumber(state.revision, 0, Number.MAX_SAFE_INTEGER, 0);
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
  // Lo stato viene gia' sanitizzato all'ingresso di ogni mutazione. Evitiamo
  // di risanitizzare tutte le scene a ogni semplice resync/focus del browser.
  if (!state || !state.scenes || typeof state.scenes !== "object" || !state.scenes[state.currentSceneId]) {
    normalizeState(state);
  } else {
    syncTopLevel(state);
  }
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
    revision: state.revision || 0,
    currentSceneId: scene.id,
    scene: scenePayload,
    imgSrc: scenePayload.imgSrc,
    map: scenePayload.map,
    grid: scenePayload.grid,
    fogState: scenePayload.fogState,
    drawings: scenePayload.drawings,
    tokens: scenePayload.tokens
  };

  if (includeAllScenes) {
    // applyState() usa direttamente scenes: evitiamo di duplicare nel wire
    // anche tutta la scena attiva (immagine, fog, disegni e pedine).
    return {
      revision: state.revision || 0,
      currentSceneId: scene.id,
      scenes: state.scenes
    };
  }
  return out;
}

function makePartialClientState(state, sceneId, src, opts = {}) {
  const scene = state.scenes?.[sceneId] || state.scenes?.[state.currentSceneId] || Object.values(state.scenes || {})[0] || makeDefaultScene();
  const scenePayload = { id: scene.id, name: scene.name };
  const out = { revision: state.revision || 0, currentSceneId: scene.id, scene: scenePayload };

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
  return socket.data.room || null;
}

function bumpRevision(state) {
  state.revision = clampNumber((state.revision || 0) + 1, 0, Number.MAX_SAFE_INTEGER, 1);
  return state.revision;
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function roomReady(socket, ack) {
  const room = getRoomName(socket);
  if (room) return room;
  reply(ack, { ok: false, error: "room-not-joined" });
  return null;
}

function mergeTokenStructure(currentTokens, incomingTokens) {
  const currentById = new Map((currentTokens || []).map((token) => [token.id, token]));
  return incomingTokens.map((token) => {
    const current = currentById.get(token.id);
    if (!current) return token;
    return { ...token, gx: current.gx, gy: current.gy };
  });
}

function acceptOperation(room, data, state, ack) {
  const opId = typeof data?._opId === "string" ? data._opId.slice(0, 180) : "";
  if (!opId) return true;
  if (!roomOperations.has(room)) roomOperations.set(room, { ids: new Set(), order: [] });
  const cache = roomOperations.get(room);
  if (cache.ids.has(opId)) {
    reply(ack, { ok: true, duplicate: true, revision: state.revision || 0 });
    return false;
  }
  cache.ids.add(opId);
  cache.order.push(opId);
  while (cache.order.length > MAX_RECENT_OPERATIONS) {
    cache.ids.delete(cache.order.shift());
  }
  return true;
}

function isMaster(socket) {
  return socket.data.role === "master";
}

function isPlayer(socket) {
  return socket.data.role === "player";
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
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

io.on("connection", (socket) => {
  console.log("Client connesso", socket.id);

  socket.on("role:set", (role, ack) => {
    const nextRole = role === "master" ? "master" : "player";
    // Il ruolo e' immutabile per tutta la vita del socket: chi e' entrato
    // come Player non puo' promuoversi a Master con un evento manuale.
    if (socket.data.role && socket.data.role !== nextRole) {
      reply(ack, { ok: false, error: "role-locked", role: socket.data.role });
      return;
    }
    socket.data.role = nextRole;
    reply(ack, { ok: true, role: nextRole });
  });

  socket.on("room:join", (rawRoom, ack) => {
    const room = sanitizeRoom(rawRoom);
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = room;
    socket.join(room);
    const state = getRoomState(room);
    console.log(`Client ${socket.id} entrato nella room ${room}`);
    // Il ruolo e' gia' stato registrato durante l'handshake applicativo.
    // Al Master inviamo tutte le scene una sola volta qui; al Player basta la
    // scena corrente. La successiva verifica per revisione non reinvia dati.
    socket.emit("state:update", { type: "state", sender: "server", ...makeClientState(state, isMaster(socket)) });
    reply(ack, { ok: true, room, revision: state.revision || 0 });
  });

  socket.on("state:request", (opts = {}, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!isRecord(opts)) opts = {};
    const state = getRoomState(room);
    const sinceRevision = Number(opts.sinceRevision);
    if (!opts.full && Number.isFinite(sinceRevision) && sinceRevision === (state.revision || 0)) {
      reply(ack, { ok: true, unchanged: true, revision: state.revision || 0 });
      return;
    }
    socket.emit("state:update", {
      type: "state",
      sender: "server",
      ...makeClientState(state, Boolean(opts.full))
    });
    reply(ack, { ok: true, revision: state.revision || 0 });
  });

  socket.on("state:update", (incoming, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    const state = getRoomState(room);
    if (!isRecord(incoming)) {
      reply(ack, { ok: false, error: "invalid-payload" });
      return;
    }

    // Solo il Master puo' modificare lo stato generale della stanza.
    // Il Player puo' inviare esclusivamente token:move, gestito piu' sotto.
    if (!isMaster(socket)) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }
    if (!acceptOperation(room, incoming, state, ack)) return;

    if (isRecord(incoming.scenes)) {
      // Import/sostituzione completa campagna: operazione rara e intenzionale.
      state.scenes = incoming.scenes;
      state.currentSceneId = incoming.currentSceneId || state.currentSceneId;
      normalizeState(state);
      bumpRevision(state);
      socket.to(room).emit("state:update", { type: "state", sender: "master", ...makeClientState(state, true) });
      reply(ack, { ok: true, revision: state.revision });
      return;
    }

    const src = incoming.scene || incoming;
    const sceneId = String(incoming.currentSceneId || src.id || state.currentSceneId || "scene-1").slice(0, 120);
    state.currentSceneId = sceneId;

    if (incoming.kind === "scene:replace") {
      const cleanScene = sanitizeScene({ ...src, id: sceneId }, sceneId);
      state.scenes[sceneId] = cleanScene;
      syncTopLevel(state);
      bumpRevision(state);
      socket.to(room).emit("state:update", { type: "state", sender: "master", ...makeClientState(state, false) });
      reply(ack, { ok: true, revision: state.revision });
      return;
    }

    const scene = getOrCreateScene(state, sceneId, src.name || "Scena");
    const explicitFields = Array.isArray(incoming.fields)
      ? new Set(incoming.fields.filter((field) => ["name", "imgSrc", "map", "grid", "fogState"].includes(field)))
      : null;
    const wants = (field) => explicitFields ? explicitFields.has(field) : hasOwn(src, field);
    let changed = false;

    if (wants("name") && typeof src.name === "string" && src.name.trim()) {
      scene.name = src.name.slice(0, 80);
      changed = true;
    }
    if (wants("imgSrc") && hasOwn(src, "imgSrc")) {
      scene.imgSrc = typeof src.imgSrc === "string" && src.imgSrc ? src.imgSrc : null;
      changed = true;
    }
    if (wants("map") && hasOwn(src, "map")) {
      scene.map = sanitizeMap(src.map);
      changed = true;
    }
    if (wants("grid") && hasOwn(src, "grid")) {
      scene.grid = sanitizeGrid(src.grid);
      changed = true;
    }
    if (wants("fogState") && hasOwn(src, "fogState")) {
      scene.fogState = sanitizeFogState(src.fogState);
      changed = true;
    }

    // Disegni e pedine hanno eventi dedicati. In questo modo un semplice
    // movimento della mappa non puo' sovrascrivere coordinate PG appena
    // ricevute dal Player con una copia locale piu' vecchia del Master.
    if (!changed) {
      reply(ack, { ok: true, revision: state.revision || 0, noop: true });
      return;
    }

    syncTopLevel(state);
    bumpRevision(state);
    const outgoing = makePartialClientState(state, sceneId, src, {
      includeImage: wants("imgSrc") && hasOwn(src, "imgSrc"),
      includeDrawings: false
    });
    socket.to(room).emit("state:update", { type: "state", sender: "master", ...outgoing });
    reply(ack, { ok: true, revision: state.revision });
  });

  socket.on("tokens:sync", (data, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!isMaster(socket)) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }
    if (!isRecord(data) || !Array.isArray(data.tokens)) {
      reply(ack, { ok: false, error: "invalid-payload" });
      return;
    }
    const state = getRoomState(room);
    if (!acceptOperation(room, data, state, ack)) return;
    const sceneId = String(data.sceneId || state.currentSceneId || "scene-1").slice(0, 120);
    const scene = getOrCreateScene(state, sceneId);
    const cleanTokens = sanitizeTokens(data.tokens);
    scene.tokens = data.mode === "structure"
      ? mergeTokenStructure(scene.tokens, cleanTokens)
      : cleanTokens;
    state.currentSceneId = sceneId;
    syncTopLevel(state);
    bumpRevision(state);
    socket.to(room).emit("tokens:replace", {
      sender: "master",
      revision: state.revision,
      sceneId,
      tokens: scene.tokens
    });
    reply(ack, { ok: true, revision: state.revision });
  });

  socket.on("drawing:add", (data, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!isMaster(socket)) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }
    if (!isRecord(data)) {
      reply(ack, { ok: false, error: "invalid-payload" });
      return;
    }
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    const drawing = sanitizeDrawing(data.drawing);
    if (!drawing) {
      reply(ack, { ok: false, error: "invalid-drawing" });
      return;
    }
    if (!acceptOperation(room, data, state, ack)) return;

    if (!scene.drawings.some((d) => d.id && d.id === drawing.id)) {
      scene.drawings.push(drawing);
      if (scene.drawings.length > MAX_DRAWINGS) scene.drawings.splice(0, scene.drawings.length - MAX_DRAWINGS);
      syncTopLevel(state);
      bumpRevision(state);
    }
    socket.to(room).emit("drawing:add", { sender: "master", revision: state.revision, sceneId, drawing });
    reply(ack, { ok: true, revision: state.revision });
  });

  socket.on("drawings:replace", (data, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!isMaster(socket)) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }
    if (!isRecord(data)) {
      reply(ack, { ok: false, error: "invalid-payload" });
      return;
    }
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    if (!acceptOperation(room, data, state, ack)) return;
    scene.drawings = sanitizeDrawings(data.drawings);
    syncTopLevel(state);
    bumpRevision(state);
    socket.to(room).emit("drawings:replace", { sender: "master", revision: state.revision, sceneId, drawings: scene.drawings });
    reply(ack, { ok: true, revision: state.revision });
  });

  socket.on("drawings:clear", (data = {}, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!isMaster(socket)) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }
    if (!isRecord(data)) {
      reply(ack, { ok: false, error: "invalid-payload" });
      return;
    }
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    if (!acceptOperation(room, data, state, ack)) return;
    scene.drawings = [];
    syncTopLevel(state);
    bumpRevision(state);
    socket.to(room).emit("drawings:clear", { sender: "master", revision: state.revision, sceneId });
    reply(ack, { ok: true, revision: state.revision });
  });

  socket.on("fog:append", (data, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!isMaster(socket)) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }
    if (!isRecord(data) || !Array.isArray(data.strokes)) {
      reply(ack, { ok: false, error: "invalid-payload" });
      return;
    }
    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = getOrCreateScene(state, sceneId);
    const strokes = data.strokes.map(sanitizeFogStroke).filter(Boolean);
    if (!strokes.length) {
      reply(ack, { ok: true, revision: state.revision || 0, noop: true });
      return;
    }
    if (!acceptOperation(room, data, state, ack)) return;
    scene.fogState = sanitizeFogState(scene.fogState);
    scene.fogState.strokes.push(...strokes);
    if (scene.fogState.strokes.length > MAX_FOG_STROKES) {
      scene.fogState.strokes.splice(0, scene.fogState.strokes.length - MAX_FOG_STROKES);
    }
    syncTopLevel(state);
    bumpRevision(state);
    socket.to(room).emit("fog:append", { sender: "master", revision: state.revision, sceneId, strokes });
    reply(ack, { ok: true, revision: state.revision });
  });

  socket.on("token:move", (data, ack) => {
    const room = roomReady(socket, ack);
    if (!room) return;
    if (!data?.id || (!isMaster(socket) && !isPlayer(socket))) {
      reply(ack, { ok: false, error: "forbidden" });
      return;
    }

    const state = getRoomState(room);
    const sceneId = data.sceneId || state.currentSceneId;
    const scene = state.scenes[sceneId];
    if (!scene || !Array.isArray(scene.tokens)) {
      reply(ack, { ok: false, error: "scene-not-found" });
      return;
    }

    const token = scene.tokens.find((item) => item.id === data.id);
    if (!token) {
      reply(ack, { ok: false, error: "token-not-found" });
      return;
    }

    // Il Player puo' muovere solo le pedine PG. PNG e qualunque altro
    // contenuto della scena restano completamente sotto il controllo Master.
    if (isPlayer(socket) && token.type !== "pg") {
      reply(ack, { ok: false, error: "token-forbidden" });
      return;
    }
    if (!acceptOperation(room, data, state, ack)) return;

    token.gx = clampNumber(data.gx, -100000, 100000, token.gx || 0);
    token.gy = clampNumber(data.gy, -100000, 100000, token.gy || 0);
    syncTopLevel(state);
    bumpRevision(state);

    const payload = {
      sender: socket.data.role,
      revision: state.revision,
      sceneId,
      id: token.id,
      gx: token.gx,
      gy: token.gy,
      seq: clampNumber(data.seq, 0, Number.MAX_SAFE_INTEGER, 0),
      final: data.final !== false
    };
    const broadcaster = socket.to(room);
    if (data.final === false && broadcaster.volatile) broadcaster.volatile.emit("token:move", payload);
    else broadcaster.emit("token:move", payload);
    reply(ack, { ok: true, revision: state.revision, gx: token.gx, gy: token.gy });
  });

  socket.on("client:keepalive", (data, ack) => {
    socket.data.lastKeepalive = Date.now();
    reply(ack, { ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnesso", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`D&D TableTop attivo su http://localhost:${PORT}`);
  // Stampa gli IP di rete locale a cui gli altri dispositivi (sullo
  // stesso WiFi/hotspot, anche senza internet) possono collegarsi.
  try {
    const os = require("os");
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) addrs.push(net.address);
      }
    }
    if (addrs.length) {
      console.log("Indirizzi per gli altri dispositivi sulla stessa rete:");
      addrs.forEach(a => console.log(`  -> http://${a}:${PORT}`));
    } else {
      console.log("Nessun indirizzo di rete locale trovato (sei connesso a un WiFi/hotspot?).");
    }
  } catch (e) {
    console.log("Impossibile determinare l'IP locale:", e.message);
  }
});
