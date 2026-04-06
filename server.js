const http = require("http");
const { WebSocketServer } = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Territory Conquest Server Running");
});

const wss = new WebSocketServer({ server });

const GRID = 20;
const MAX_PLAYERS = 4;

const COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12"];
const STARTS = [
  { x: 1, y: 1 },
  { x: GRID - 2, y: GRID - 2 },
  { x: GRID - 2, y: 1 },
  { x: 1, y: GRID - 2 },
];

let rooms = {};

function createRoom(roomId) {
  const grid = Array.from({ length: GRID }, () => Array(GRID).fill(null));
  return {
    id: roomId,
    players: {},
    grid,
    turn: null,
    started: false,
    turnOrder: [],
    turnIndex: 0,
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  Object.values(room.players).forEach((p) => {
    if (p.ws.readyState === 1) p.ws.send(data);
  });
}

function getState(room) {
  return {
    type: "state",
    grid: room.grid,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [
        id,
        { name: p.name, color: p.color, score: p.score, armies: p.armies },
      ])
    ),
    turn: room.turn,
    started: room.started,
    turnOrder: room.turnOrder,
  };
}

function countTiles(grid, playerId) {
  let count = 0;
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++)
      if (grid[y][x] === playerId) count++;
  return count;
}

function getNeighbors(x, y) {
  return [
    [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
  ].filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < GRID && ny < GRID);
}

function canAttack(room, playerId, tx, ty) {
  const neighbors = getNeighbors(tx, ty);
  return neighbors.some(([nx, ny]) => room.grid[ny][nx] === playerId);
}

function nextTurn(room) {
  room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
  room.turn = room.turnOrder[room.turnIndex];
  const p = room.players[room.turn];
  if (p) {
    p.armies += 3 + Math.floor(countTiles(room.grid, room.turn) / 5);
  }
  broadcast(room, getState(room));
  broadcast(room, { type: "message", text: `${p?.name || "?"}'s turn! They gained armies.` });
}

function startGame(room) {
  room.started = true;
  room.turnOrder = Object.keys(room.players);
  room.turnIndex = 0;
  room.turn = room.turnOrder[0];

  // Place starting tiles
  room.turnOrder.forEach((pid, i) => {
    const { x, y } = STARTS[i];
    room.grid[y][x] = pid;
    room.players[pid].armies = 10;
    room.players[pid].score = 1;
  });

  broadcast(room, getState(room));
  broadcast(room, { type: "message", text: "Game started! Claim territory by attacking adjacent tiles." });
}

wss.on("connection", (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      roomId = msg.room || "default";
      if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
      const room = rooms[roomId];

      if (Object.keys(room.players).length >= MAX_PLAYERS || room.started) {
        ws.send(JSON.stringify({ type: "error", text: "Room full or game already started." }));
        return;
      }

      playerId = `p${Date.now()}`;
      const idx = Object.keys(room.players).length;
      room.players[playerId] = {
        ws,
        name: msg.name || `Player ${idx + 1}`,
        color: COLORS[idx],
        score: 0,
        armies: 0,
      };

      ws.send(JSON.stringify({ type: "joined", playerId, color: COLORS[idx] }));
      broadcast(room, getState(room));
      broadcast(room, { type: "message", text: `${room.players[playerId].name} joined!` });
    }

    if (msg.type === "start") {
      const room = rooms[roomId];
      if (!room || room.started || Object.keys(room.players).length < 2) return;
      startGame(room);
    }

    if (msg.type === "attack") {
      const room = rooms[roomId];
      if (!room || !room.started || room.turn !== playerId) return;
      const { x, y } = msg;
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
      if (room.grid[y][x] === playerId) return;

      const player = room.players[playerId];
      if (!canAttack(room, playerId, x, y)) {
        ws.send(JSON.stringify({ type: "error", text: "You can only attack tiles adjacent to your territory!" }));
        return;
      }

      const targetOwner = room.grid[y][x];
      const cost = targetOwner ? 2 : 1;

      if (player.armies < cost) {
        ws.send(JSON.stringify({ type: "error", text: "Not enough armies!" }));
        return;
      }

      player.armies -= cost;
      room.grid[y][x] = playerId;

      broadcast(room, getState(room));

      // Check win condition
      const scores = room.turnOrder.map((pid) => countTiles(room.grid, pid));
      const total = GRID * GRID;
      const maxScore = Math.max(...scores);
      const winner = room.turnOrder[scores.indexOf(maxScore)];

      if (maxScore > total * 0.6) {
        broadcast(room, { type: "gameover", winner, name: room.players[winner].name });
        rooms[roomId] = createRoom(roomId);
        return;
      }

      // End turn if out of armies
      if (player.armies <= 0) {
        nextTurn(room);
      }
    }

    if (msg.type === "endturn") {
      const room = rooms[roomId];
      if (!room || !room.started || room.turn !== playerId) return;
      nextTurn(room);
    }
  });

  ws.on("close", () => {
    if (!roomId || !playerId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const name = room.players[playerId]?.name;
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      delete rooms[roomId];
    } else {
      broadcast(room, { type: "message", text: `${name} left the game.` });
      if (room.turn === playerId) nextTurn(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
