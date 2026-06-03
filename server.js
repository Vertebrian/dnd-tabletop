const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50 * 1024 * 1024
});

let sharedState = null;

app.use(express.static(path.join(__dirname, "public")));

function mergeState(incoming) {
  if (!incoming) return sharedState;

  if (!sharedState) {
    sharedState = { ...incoming };
    return sharedState;
  }

  if (incoming.sender === "player") {
    if (Array.isArray(incoming.tokens)) {
      sharedState.tokens = incoming.tokens;
    }
    return sharedState;
  }

  // Master update: keep the old image if this update does not include it.
  const previousImage = sharedState.imgSrc || null;
  sharedState = { ...sharedState, ...incoming };
  if (!incoming.imgSrc && previousImage) {
    sharedState.imgSrc = previousImage;
  }
  return sharedState;
}

io.on("connection", (socket) => {
  console.log("Client connesso", socket.id);

  if (sharedState) {
    socket.emit("state:update", sharedState);
  }

  socket.on("state:request", () => {
    if (sharedState) socket.emit("state:update", sharedState);
  });

  socket.on("state:update", (state) => {
    const merged = mergeState(state);
    if (merged) io.emit("state:update", merged);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnesso", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("SERVER BAROVIA AVVIATO");
  console.log("localhost:", `http://localhost:${PORT}`);
  console.log("LAN:", `http://192.168.137.1:${PORT}`);
  console.log("=================================");
});
