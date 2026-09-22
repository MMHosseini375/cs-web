import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- Config ----------------
const CONFIG = {
  maxTeam: 5,
  freezeTime: 10,
  roundTime: 120,
  bombFuse: 40,
  defuseTime: 5,
  plantTime: 3,
  spawnT:  { x: -30, z:  30 },
  spawnCT: { x:  30, z: -30 },
  bombSite: { x: 0, z: -15, r: 5 },
};

// ---------------- State ----------------
let players = new Map(); // ws -> playerState
let state = 'waiting';   // waiting | freeze | live | planted | ended
let stateEndsAt = 0;
let scores = { t: 0, ct: 0 };
let bomb = null;
let plantingId = null;
let plantStart = 0;

// ---------------- Helpers ----------------
function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of players.keys()) {
    if (ws.readyState === 1) ws.send(json);
  }
}

function countTeam(team) {
  let n = 0;
  for (const p of players.values()) if (p.team === team) n++;
  return n;
}

function countAlive(team) {
  let n = 0;
  for (const p of players.values()) if (p.team === team && p.alive) n++;
  return n;
}

function getPlayerByWs(ws) {
  return players.get(ws);
}

function broadcastLobby() {
  broadcast({
    type: 'lobby',
    t: countTeam('t'),
    ct: countTeam('ct'),
    max: CONFIG.maxTeam,
  });
}

function broadcastState() {
  const list = [];
  for (const p of players.values()) {
    if (!p.team) continue;
    list.push({
      id: p.id, name: p.name, team: p.team,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      rx: +p.rx.toFixed(2), ry: +p.ry.toFixed(2),
      hp: p.hp, alive: p.alive, hasBomb: p.hasBomb,
    });
  }
  broadcast({
    type: 'snapshot',
    players: list,
    state, endsAt: stateEndsAt, scores,
    bomb: bomb ? {
      x: bomb.x, z: bomb.z,
      endsAt: bomb.endsAt,
      defusing: bomb.defusingId !== null,
      defuseProgress: bomb.defusingId !== null
        ? (Date.now() - bomb.defuseStart) / (CONFIG.defuseTime * 1000)
        : 0,
    } : null,
    planting: plantingId !== null ? {
      by: plantingId,
      progress: (Date.now() - plantStart) / (CONFIG.plantTime * 1000),
    } : null,
  });
}

// ---------------- Round management ----------------
function startRound() {
  if (countTeam('t') < 1 || countTeam('ct') < 1) {
    state = 'waiting';
    broadcast({ type: 'state', state: 'waiting' });
    return;
  }

  let tHasBomb = false;
  for (const p of players.values()) {
    if (!p.team) continue;
    const spawn = p.team === 't' ? CONFIG.spawnT : CONFIG.spawnCT;
    p.x = spawn.x + (Math.random() * 6 - 3);
    p.z = spawn.z + (Math.random() * 6 - 3);
    p.y = 1.7;
    p.hp = 100;
    p.alive = true;
    p.hasBomb = false;
    if (p.team === 't' && !tHasBomb) {
      p.hasBomb = true;
      tHasBomb = true;
    }
  }

  bomb = null;
  plantingId = null;
  state = 'freeze';
  stateEndsAt = Date.now() + CONFIG.freezeTime * 1000;
  broadcast({ type: 'round_start', freezeEndsAt: stateEndsAt });
  broadcastState();
}

function endRound(winner, reason) {
  state = 'ended';
  scores[winner]++;
  bomb = null;
  plantingId = null;
  stateEndsAt = Date.now() + 5000;
  broadcast({ type: 'round_end', winner, reason, scores });
}

function onDeath(deadId, killerId) {
  const dead = [...players.values()].find(p => p.id === deadId);
  if (!dead) return;
  broadcast({ type: 'death', id: deadId, by: killerId });

  if (dead.hasBomb) {
    dead.hasBomb = false;
    redistributeBomb(deadId);
  }

  if (state === 'live' || state === 'freeze') {
    if (countAlive('t') === 0) endRound('ct', 'elimination');
    else if (countAlive('ct') === 0) endRound('t', 'elimination');
  }
}

function redistributeBomb(exceptId) {
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.team === 't' && p.alive) {
      p.hasBomb = true;
      return;
    }
  }
}

// ---------------- WebSocket handlers ----------------
let nextId = 1;

wss.on('connection', (ws) => {
  const id = nextId++;
  const player = {
    id, name: 'Guest' + id, team: null,
    x: 0, y: 1.7, z: 0, rx: 0, ry: 0,
    hp: 100, alive: false, hasBomb: false,
  };
  players.set(ws, player);

  ws.send(JSON.stringify({ type: 'welcome', id, state }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || !data.type) return;
    const p = players.get(ws);
    if (!p) return;

    switch (data.type) {
      case 'join': {
        const team = data.team === 't' ? 't' : 'ct';
        if (countTeam(team) >= CONFIG.maxTeam) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Team full' }));
          return;
        }
        p.team = team;
        p.name = (data.name || 'Player').slice(0, 16);
        const spawn = team === 't' ? CONFIG.spawnT : CONFIG.spawnCT;
        p.x = spawn.x + (Math.random() * 6 - 3);
        p.z = spawn.z + (Math.random() * 6 - 3);

        if (team === 't' && state === 'waiting') {
          const hasAny = [...players.values()].some(x => x.team === 't' && x.hasBomb);
          if (!hasAny) p.hasBomb = true;
        }

        ws.send(JSON.stringify({
          type: 'joined', id, team,
          spawn: { x: p.x, z: p.z }, name: p.name,
        }));
        broadcastLobby();

        if ((state === 'waiting' || state === 'ended') &&
            countTeam('t') >= 1 && countTeam('ct') >= 1) {
          startRound();
        }
        break;
      }
      case 'state': {
        if (!p.alive) return;
        const dx = (data.x ?? 0) - p.x;
        const dz = (data.z ?? 0) - p.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const maxDist = 20 * 0.05 * 3; // 3x tolerance
        if (dist > maxDist) {
          ws.send(JSON.stringify({ type: 'correction', x: p.x, z: p.z }));
          return;
        }
        p.x = +data.x || 0;
        p.y = +(data.y ?? 1.7);
        p.z = +data.z || 0;
        p.rx = +data.rx || 0;
        p.ry = +data.ry || 0;
        break;
      }
      case 'shoot': {
        if (!p.alive) return;
        if (state !== 'live' && state !== 'planted') return;
        const dir = {
          x: +data.dx || 0, y: +data.dy || 0, z: +data.dz || 0,
        };
        const len = Math.sqrt(dir.x ** 2 + dir.y ** 2 + dir.z ** 2);
        if (len < 0.001) return;
        dir.x /= len; dir.y /= len; dir.z /= len;

        const origin = { x: p.x, y: p.y, z: p.z };
        let hitPlayer = null;
        let hitDist = 200;

        for (const other of players.values()) {
          if (other.id === id || !other.alive) continue;
          if (other.team === p.team) continue;

          const cx = other.x - origin.x;
          const cy = 1.0 - origin.y;
          const cz = other.z - origin.z;
          const t = cx * dir.x + cy * dir.y + cz * dir.z;
          if (t < 0 || t > hitDist) continue;

          const px = origin.x + dir.x * t;
          const py = origin.y + dir.y * t;
          const pz = origin.z + dir.z * t;
          const d = Math.sqrt(
            (px - other.x) ** 2 + (py - 1.0) ** 2 + (pz - other.z) ** 2
          );
          if (d < 0.9) { hitDist = t; hitPlayer = other; }
        }

        broadcast({
          type: 'shoot', id,
          ox: origin.x, oy: origin.y, oz: origin.z,
          dx: dir.x, dy: dir.y, dz: dir.z,
        });

        if (hitPlayer) {
          hitPlayer.hp -= 25;
          if (hitPlayer.hp <= 0) {
            hitPlayer.hp = 0;
            hitPlayer.alive = false;
            onDeath(hitPlayer.id, id);
          }
          broadcast({ type: 'hit', id: hitPlayer.id, hp: hitPlayer.hp, by: id });
        }
        break;
      }
      case 'plant_start': {
        if (state !== 'live') return;
        if (p.team !== 't' || !p.alive || !p.hasBomb) return;
        const dx = p.x - CONFIG.bombSite.x;
        const dz = p.z - CONFIG.bombSite.z;
        if (Math.sqrt(dx * dx + dz * dz) > CONFIG.bombSite.r) return;
        plantingId = id;
        plantStart = Date.now();
        broadcast({ type: 'plant_started', by: id });
        break;
      }
      case 'plant_cancel': {
        plantingId = null;
        break;
      }
      case 'defuse_start': {
        if (state !== 'planted' || !bomb) return;
        if (p.team !== 'ct' || !p.alive) return;
        const dx = p.x - bomb.x;
        const dz = p.z - bomb.z;
        if (Math.sqrt(dx * dx + dz * dz) > 1.5) return;
        bomb.defusingId = id;
        bomb.defuseStart = Date.now();
        broadcast({ type: 'defuse_started', by: id });
        break;
      }
      case 'defuse_cancel': {
        if (bomb) {
          bomb.defusingId = null;
          bomb.defuseStart = null;
        }
        break;
      }
      case 'chat': {
        broadcast({
          type: 'chat', from: p.name, team: p.team,
          msg: String(data.msg ?? '').slice(0, 200),
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p && p.hasBomb) redistributeBomb(p.id);
    players.delete(ws);
    broadcastLobby();

    if ((state === 'waiting' || state === 'ended') &&
        countTeam('t') >= 1 && countTeam('ct') >= 1) {
      startRound();
    }
  });
});

// ---------------- Game loop (20 Hz) ----------------
setInterval(() => {
  const now = Date.now();

  if (state === 'freeze' && now >= stateEndsAt) {
    state = 'live';
    stateEndsAt = now + CONFIG.roundTime * 1000;
    broadcast({ type: 'state', state: 'live', endsAt: stateEndsAt });
  }

  if (state === 'ended' && now >= stateEndsAt) {
    startRound();
    return;
  }

  if ((state === 'live' || state === 'planted') && now >= stateEndsAt) {
    if (state === 'planted') endRound('t', 'bomb_exploded');
    else endRound('ct', 'time');
    return;
  }

  if (state === 'planted' && bomb) {
    if (now >= bomb.endsAt) {
      endRound('t', 'bomb_exploded');
      return;
    }
    if (bomb.defusingId !== null) {
      const dfn = [...players.values()].find(p => p.id === bomb.defusingId);
      if (!dfn || !dfn.alive) {
        bomb.defusingId = null;
        bomb.defuseStart = null;
      } else if (now - bomb.defuseStart >= CONFIG.defuseTime * 1000) {
        endRound('ct', 'defused');
        return;
      }
    }
  }

  if (plantingId !== null) {
    const pn = [...players.values()].find(p => p.id === plantingId);
    if (!pn || !pn.alive || state !== 'live') {
      plantingId = null;
      broadcast({ type: 'plant_cancelled' });
    } else if (now - plantStart >= CONFIG.plantTime * 1000) {
      // plant bomb
      bomb = {
        x: pn.x, z: pn.z,
        endsAt: now + CONFIG.bombFuse * 1000,
        defusingId: null, defuseStart: null,
      };
      pn.hasBomb = false;
      plantingId = null;
      state = 'planted';
      stateEndsAt = bomb.endsAt;
      broadcast({
        type: 'bomb_planted',
        x: pn.x, z: pn.z, endsAt: bomb.endsAt,
      });
    }
  }

  broadcastState();
}, 50);

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WS] Server running on port ${PORT}`);
});