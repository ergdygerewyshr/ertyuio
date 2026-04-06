const http = require("http");
const { WebSocketServer } = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Territory Conquest Server Running");
});

const wss = new WebSocketServer({ server });

const GRID = 20;
const MAX_PLAYERS = 4;
const TURN_TIME = 30; // seconds per turn

const COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12"];
const STARTS = [
  { x: 1, y: 1 },
  { x: GRID - 2, y: GRID - 2 },
  { x: GRID - 2, y: 1 },
  { x: 1, y: GRID - 2 },
];

// Power-up types
const POWERUP_TYPES = ["blitz", "shield", "airstrike", "reinforcement"];

let rooms = {};

// ── HELPERS ───────────────────────────────────────────────────────────────────

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
    owner: null,           // first player to join is owner
    powerups: {},          // {playerId: [powerupType, ...]}
    shields: {},           // {tileKey: ownerId} — shielded tiles
    timerInterval: null,
    timeLeft: TURN_TIME,
    turnCount: 0,
    scores: {},            // cumulative score history
    settings: {
      turnTime: TURN_TIME,
      allowBots: true,
      maxPlayers: MAX_PLAYERS,
    },
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  Object.values(room.players).forEach((p) => {
    if (!p.isBot && p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

function sendTo(room, playerId, msg) {
  const p = room.players[playerId];
  if (p && !p.isBot && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function getState(room) {
  return {
    type: "state",
    grid: room.grid,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [
        id,
        {
          name: p.name,
          color: p.color,
          score: p.score,
          armies: p.armies,
          powerups: room.powerups[id] || [],
          isBot: p.isBot || false,
        },
      ])
    ),
    turn: room.turn,
    started: room.started,
    turnOrder: room.turnOrder,
    owner: room.owner,
    timeLeft: room.timeLeft,
    shields: room.shields,
    settings: room.settings,
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
  return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
    .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < GRID && ny < GRID);
}

function canAttack(room, playerId, tx, ty) {
  return getNeighbors(tx, ty).some(([nx, ny]) => room.grid[ny][nx] === playerId);
}

function spawnPowerup(room, playerId) {
  if (Math.random() < 0.4) { // 40% chance per turn
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    if (!room.powerups[playerId]) room.powerups[playerId] = [];
    if (room.powerups[playerId].length < 3) {
      room.powerups[playerId].push(type);
      broadcast(room, { type: "message", text: `${room.players[playerId]?.name} received a ${type} power-up!` });
    }
  }
}

function checkWin(room) {
  const total = GRID * GRID;
  for (const pid of room.turnOrder) {
    const tiles = countTiles(room.grid, pid);
    if (tiles > total * 0.6) {
      // Build final scores
      const finalScores = room.turnOrder.map(p => ({
        id: p,
        name: room.players[p]?.name || "?",
        color: room.players[p]?.color || "#fff",
        tiles: countTiles(room.grid, p),
        isBot: room.players[p]?.isBot || false,
      })).sort((a, b) => b.tiles - a.tiles);

      broadcast(room, {
        type: "gameover",
        winner: pid,
        name: room.players[pid]?.name,
        finalScores,
      });
      clearTurnTimer(room);
      setTimeout(() => { rooms[room.id] = createRoom(room.id); }, 5000);
      return true;
    }
  }
  return false;
}

function clearTurnTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.timeLeft = room.settings.turnTime;
  broadcast(room, { type: "timer", timeLeft: room.timeLeft });

  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    broadcast(room, { type: "timer", timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      broadcast(room, { type: "message", text: `${room.players[room.turn]?.name || "?"}'s turn timed out!` });
      nextTurn(room);
    }
  }, 1000);
}

function nextTurn(room) {
  // Skip dead players (0 tiles after game started)
  let attempts = 0;
  do {
    room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
    room.turn = room.turnOrder[room.turnIndex];
    attempts++;
  } while (
    attempts < room.turnOrder.length &&
    room.started &&
    countTiles(room.grid, room.turn) === 0 &&
    room.turnCount > 1
  );

  room.turnCount++;
  const p = room.players[room.turn];
  if (p) {
    const gained = 3 + Math.floor(countTiles(room.grid, room.turn) / 5);
    p.armies += gained;
    spawnPowerup(room, room.turn);
  }

  broadcast(room, getState(room));
  broadcast(room, { type: "message", text: `${p?.name || "?"}'s turn!` });
  startTurnTimer(room);

  // If it's a bot's turn, run bot logic
  if (p && p.isBot) {
    setTimeout(() => runBotTurn(room, room.turn), 1200);
  }
}

function startGame(room) {
  room.started = true;
  room.turnOrder = Object.keys(room.players);
  room.turnIndex = 0;
  room.turn = room.turnOrder[0];
  room.turnCount = 1;

  room.turnOrder.forEach((pid, i) => {
    const { x, y } = STARTS[i];
    room.grid[y][x] = pid;
    room.players[pid].armies = 10;
    room.players[pid].score = 1;
    room.powerups[pid] = [];
  });

  broadcast(room, getState(room));
  broadcast(room, { type: "message", text: "⚔ Game started! Conquer the realm." });
  startTurnTimer(room);

  // If first player is a bot
  const first = room.players[room.turn];
  if (first && first.isBot) {
    setTimeout(() => runBotTurn(room, room.turn), 1500);
  }
}

// ── BOT AI ────────────────────────────────────────────────────────────────────

function runBotTurn(room, botId) {
  if (!room.started || room.turn !== botId) return;
  const bot = room.players[botId];
  if (!bot || !bot.isBot) return;

  // Find all attackable tiles
  const attackable = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (room.grid[y][x] !== botId && canAttack(room, botId, x, y)) {
        const owner = room.grid[y][x];
        const cost = owner ? 2 : 1;
        attackable.push({ x, y, owner, cost });
      }
    }
  }

  function doAttack() {
    if (!room.started || room.turn !== botId) return;
    const bot = room.players[botId];
    if (!bot) return;

    // Refresh attackable list
    const available = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (room.grid[y][x] !== botId && canAttack(room, botId, x, y)) {
          const owner = room.grid[y][x];
          const cost = owner ? 2 : 1;
          if (bot.armies >= cost) available.push({ x, y, owner, cost });
        }
      }
    }

    if (available.length === 0 || bot.armies <= 0) {
      nextTurn(room);
      return;
    }

    // Prefer empty tiles, then enemy tiles
    available.sort((a, b) => (a.owner ? 1 : 0) - (b.owner ? 1 : 0));
    const pick = available[Math.floor(Math.random() * Math.min(3, available.length))];

    bot.armies -= pick.cost;
    room.grid[pick.y][pick.x] = botId;
    broadcast(room, getState(room));

    if (checkWin(room)) return;
    if (bot.armies <= 0) { nextTurn(room); return; }

    setTimeout(doAttack, 600);
  }

  doAttack();
}

// ── POWERUP LOGIC ─────────────────────────────────────────────────────────────

function usePowerup(room, playerId, powerupType) {
  const pups = room.powerups[playerId] || [];
  const idx = pups.indexOf(powerupType);
  if (idx === -1) return false;
  pups.splice(idx, 1);

  const p = room.players[playerId];

  switch (powerupType) {
    case "blitz":
      // Double armies for this turn
      p.armies += p.armies;
      broadcast(room, { type: "message", text: `⚡ ${p.name} used BLITZ — armies doubled!` });
      break;

    case "reinforcement":
      // +15 armies
      p.armies += 15;
      broadcast(room, { type: "message", text: `🛡 ${p.name} used REINFORCEMENT — +15 armies!` });
      break;

    case "shield": {
      // Shield all owned tiles for 1 turn (they cost 3 to capture instead of 2)
      let shielded = 0;
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          if (room.grid[y][x] === playerId) {
            room.shields[`${x},${y}`] = playerId;
            shielded++;
          }
        }
      }
      broadcast(room, { type: "message", text: `🔰 ${p.name} used SHIELD — ${shielded} tiles protected!` });
      // Remove shields after 2 turns
      setTimeout(() => {
        for (const key of Object.keys(room.shields)) {
          if (room.shields[key] === playerId) delete room.shields[key];
        }
        broadcast(room, getState(room));
      }, room.settings.turnTime * 2 * 1000);
      break;
    }

    case "airstrike": {
      // Remove 5 random enemy tiles
      const enemyTiles = [];
      for (let y = 0; y < GRID; y++)
        for (let x = 0; x < GRID; x++)
          if (room.grid[y][x] && room.grid[y][x] !== playerId)
            enemyTiles.push({ x, y });

      const hits = enemyTiles.sort(() => Math.random() - 0.5).slice(0, 5);
      hits.forEach(({ x, y }) => { room.grid[y][x] = null; });
      broadcast(room, { type: "message", text: `💥 ${p.name} used AIRSTRIKE — destroyed ${hits.length} enemy tiles!` });
      break;
    }
  }

  broadcast(room, getState(room));
  return true;
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (msg.type === "join") {
      roomId = msg.room || "default";
      if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
      const room = rooms[roomId];

      const playerCount = Object.keys(room.players).length;
      if (playerCount >= room.settings.maxPlayers || room.started) {
        ws.send(JSON.stringify({ type: "error", text: "Room full or game already started." }));
        return;
      }

      playerId = `p${Date.now()}${Math.random().toString(36).slice(2,6)}`;
      const idx = playerCount;
      const isOwner = idx === 0;

      room.players[playerId] = {
        ws,
        name: msg.name || `Player ${idx + 1}`,
        color: COLORS[idx],
        score: 0,
        armies: 0,
        skin: msg.skin || "default",
        isBot: false,
      };
      room.powerups[playerId] = [];
      if (isOwner) room.owner = playerId;

      ws.send(JSON.stringify({ type: "joined", playerId, color: COLORS[idx], isOwner }));
      broadcast(room, getState(room));
      broadcast(room, { type: "message", text: `${room.players[playerId].name} joined!` });
    }

    // ── OWNER PANEL ACTIONS ───────────────────────────────────────────────────
    if (msg.type === "owner_action") {
      const room = rooms[roomId];
      if (!room || room.owner !== playerId) {
        ws.send(JSON.stringify({ type: "error", text: "Only the room owner can do that." }));
        return;
      }

      if (msg.action === "kick" && msg.targetId && room.players[msg.targetId]) {
        const name = room.players[msg.targetId].name;
        sendTo(room, msg.targetId, { type: "kicked", reason: "You were kicked by the room owner." });
        delete room.players[msg.targetId];
        broadcast(room, { type: "message", text: `${name} was kicked by the owner.` });
        broadcast(room, getState(room));
      }

      if (msg.action === "add_bot") {
        const botCount = Object.values(room.players).filter(p => p.isBot).length;
        const total = Object.keys(room.players).length;
        if (total >= room.settings.maxPlayers) {
          ws.send(JSON.stringify({ type: "error", text: "Room is full." }));
          return;
        }
        const botId = `bot_${Date.now()}`;
        const idx = total;
        room.players[botId] = {
          ws: null, isBot: true,
          name: `Bot ${botCount + 1}`,
          color: COLORS[idx],
          score: 0, armies: 0, skin: "default",
        };
        room.powerups[botId] = [];
        broadcast(room, getState(room));
        broadcast(room, { type: "message", text: `🤖 Bot ${botCount + 1} added to the room.` });
      }

      if (msg.action === "remove_bot") {
        const botId = Object.keys(room.players).find(id => room.players[id].isBot);
        if (botId) {
          const name = room.players[botId].name;
          delete room.players[botId];
          broadcast(room, getState(room));
          broadcast(room, { type: "message", text: `${name} removed.` });
        }
      }

      if (msg.action === "update_settings") {
        if (msg.turnTime && msg.turnTime >= 10 && msg.turnTime <= 120) {
          room.settings.turnTime = msg.turnTime;
        }
        if (typeof msg.maxPlayers === "number" && msg.maxPlayers >= 2 && msg.maxPlayers <= 4) {
          room.settings.maxPlayers = msg.maxPlayers;
        }
        broadcast(room, getState(room));
        broadcast(room, { type: "message", text: "⚙ Room settings updated." });
      }
    }

    // ── START ─────────────────────────────────────────────────────────────────
    if (msg.type === "start") {
      const room = rooms[roomId];
      if (!room || room.started) return;
      if (room.owner !== playerId) {
        ws.send(JSON.stringify({ type: "error", text: "Only the room owner can start the game." }));
        return;
      }
      if (Object.keys(room.players).length < 2) {
        ws.send(JSON.stringify({ type: "error", text: "Need at least 2 players to start." }));
        return;
      }
      startGame(room);
    }

    // ── ATTACK ────────────────────────────────────────────────────────────────
    if (msg.type === "attack") {
      const room = rooms[roomId];
      if (!room || !room.started || room.turn !== playerId) return;
      const { x, y } = msg;
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
      if (room.grid[y][x] === playerId) return;

      const player = room.players[playerId];
      if (!canAttack(room, playerId, x, y)) {
        ws.send(JSON.stringify({ type: "error", text: "You can only attack adjacent tiles!" }));
        return;
      }

      const tileKey = `${x},${y}`;
      const isShielded = room.shields[tileKey];
      const targetOwner = room.grid[y][x];
      let cost = targetOwner ? (isShielded ? 3 : 2) : 1;

      if (player.armies < cost) {
        ws.send(JSON.stringify({ type: "error", text: `Not enough armies! This tile costs ${cost}.` }));
        return;
      }

      player.armies -= cost;
      room.grid[y][x] = playerId;
      if (isShielded) delete room.shields[tileKey];

      broadcast(room, getState(room));
      if (checkWin(room)) return;
      if (player.armies <= 0) nextTurn(room);
    }

    // ── END TURN / SKIP ───────────────────────────────────────────────────────
    if (msg.type === "endturn") {
      const room = rooms[roomId];
      if (!room || !room.started || room.turn !== playerId) return;
      nextTurn(room);
    }

    // ── USE POWERUP ───────────────────────────────────────────────────────────
    if (msg.type === "powerup") {
      const room = rooms[roomId];
      if (!room || !room.started || room.turn !== playerId) return;
      const success = usePowerup(room, playerId, msg.powerup);
      if (!success) ws.send(JSON.stringify({ type: "error", text: "You don't have that power-up." }));
    }

    // ── CHAT ──────────────────────────────────────────────────────────────────
    if (msg.type === "chat") {
      const room = rooms[roomId];
      if (!room || !playerId) return;
      const name = room.players[playerId]?.name || "Unknown";
      const color = room.players[playerId]?.color || "#fff";
      const text = String(msg.text || "").trim().slice(0, 200);
      if (!text) return;
      broadcast(room, { type: "chat", name, color, text, id: playerId });
    }

    // ── SKIN CHANGE ───────────────────────────────────────────────────────────
    if (msg.type === "skin") {
      const room = rooms[roomId];
      if (!room || !room.players[playerId]) return;
      room.players[playerId].skin = msg.skin || "default";
      broadcast(room, getState(room));
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  ws.on("close", () => {
    if (!roomId || !playerId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const name = room.players[playerId]?.name;
    const wasOwner = room.owner === playerId;

    delete room.players[playerId];
    delete room.powerups[playerId];

    if (Object.keys(room.players).filter(id => !room.players[id]?.isBot).length === 0) {
      clearTurnTimer(room);
      delete rooms[roomId];
      return;
    }

    // Transfer ownership
    if (wasOwner) {
      const newOwner = Object.keys(room.players).find(id => !room.players[id].isBot);
      if (newOwner) {
        room.owner = newOwner;
        sendTo(room, newOwner, { type: "owner_granted" });
        broadcast(room, { type: "message", text: `${room.players[newOwner]?.name} is now the room owner.` });
      }
    }

    broadcast(room, { type: "message", text: `${name} left the game.` });
    broadcast(room, getState(room));
    if (room.started && room.turn === playerId) nextTurn(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Territory Conquest server running on port ${PORT}`));
