const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const ROLES = require('./public/shared/roles.js');

const PORT = process.env.PORT || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid mis-scans/typos
const MIN_PLAYERS = 4;
const STALE_ROOM_MS = 6 * 60 * 60 * 1000; // reap abandoned rooms after 6h

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// The single-device pass-and-play game stays untouched at the repo root and
// is also served here so the whole app can run from one process.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = app.listen(PORT, () => {
  const addrs = getLanAddresses();
  console.log('Werewolf server running.');
  console.log(`  Single-device game: http://localhost:${PORT}/`);
  console.log('  Multi-device host screen:');
  addrs.forEach(ip => console.log(`    http://${ip}:${PORT}/host.html`));
  if (!addrs.length) console.log(`    http://localhost:${PORT}/host.html`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Room>} */
const rooms = new Map();

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // Skip link-local (169.254.x.x) addresses - they show up when an
      // interface has no real network yet and aren't reachable by other
      // devices. Phones in particular can report several live interfaces
      // at once (e.g. Wi-Fi client + a personal hotspot), so every
      // remaining candidate is kept rather than guessing which is "the"
      // one - the host picks whichever actually works for their players.
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeToken() {
  return crypto.randomBytes(18).toString('hex');
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function isWolf(role) {
  return !!(ROLES[role] && ROLES[role].team === 'wolf');
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Mirrors sanitizeRoleDependencies() in index.html so the two role-assignment
// paths (single-device and multi-device) stay behaviorally identical.
function sanitizeRoleDependencies(rolesList, total) {
  let roles = [...rolesList];

  if (roles.includes('seer_apprentice') && !roles.includes('seer')) {
    const idx = roles.indexOf('seer_apprentice');
    if (roles.length < total) roles.push('seer');
    else roles[idx] = 'seer';
  }

  if (roles.includes('sect_hunter') && !roles.includes('sect_leader')) {
    const idx = roles.indexOf('sect_hunter');
    roles[idx] = 'villager';
  }

  const sibCount = roles.filter(r => r === 'sibling').length;
  if (sibCount === 1) {
    if (roles.length < total) roles.push('sibling');
    else {
      const idx = roles.indexOf('sibling');
      roles[idx] = 'villager';
    }
  }

  return roles;
}

// Mirrors startGame()'s role-assignment logic in index.html.
function computeRoles(total, config) {
  const { assignmentMode, roleToggles, customRoleCounts } = config;
  let roles = [];

  if (assignmentMode === 'custom') {
    Object.keys(ROLES).forEach(key => {
      const count = (customRoleCounts && customRoleCounts[key]) || 0;
      for (let i = 0; i < count; i++) roles.push(key);
    });
    if (roles.length > total) {
      throw new Error('Assigned roles exceed total players.');
    }
  } else if (assignmentMode === 'full_random') {
    const wolfCount = Math.max(1, Math.floor(total / 3.5));
    roles.push('werewolf');
    const wolfKeys = Object.keys(ROLES).filter(k => ROLES[k].team === 'wolf' && k !== 'werewolf');
    shuffle(wolfKeys);
    for (let i = 1; i < wolfCount; i++) roles.push(wolfKeys[i % wolfKeys.length]);

    const specialKeys = Object.keys(ROLES).filter(k => ROLES[k].team !== 'wolf' && k !== 'villager');
    shuffle(specialKeys);
    for (let i = 0; i < total - wolfCount && i < specialKeys.length; i++) {
      if (Math.random() > 0.3) roles.push(specialKeys[i]);
    }
    roles = sanitizeRoleDependencies(roles, total);
  } else {
    // selected_random (default)
    const enabledKeys = Object.keys(ROLES).filter(k => roleToggles && roleToggles[k]);
    if (!enabledKeys.length) throw new Error('No roles are enabled.');

    const enabledWolves = enabledKeys.filter(k => ROLES[k].team === 'wolf');
    const enabledNonWolves = enabledKeys.filter(k => ROLES[k].team !== 'wolf' && k !== 'villager');

    const targetWolves = Math.max(1, Math.floor(total / 3.5));
    for (let i = 0; i < targetWolves; i++) {
      if (enabledWolves.length > 0) {
        roles.push(enabledWolves[Math.floor(Math.random() * enabledWolves.length)]);
      } else {
        roles.push('werewolf');
      }
    }

    shuffle(enabledNonWolves);
    enabledNonWolves.forEach(k => {
      if (roles.length >= total) return;
      if (k === 'seer_apprentice' && !roleToggles['seer']) return;
      if (k === 'sect_hunter' && !roleToggles['sect_leader']) return;

      if (Math.random() < 0.65) {
        const r = ROLES[k];
        let qty = r.stackable ? Math.min(total - roles.length, Math.floor(Math.random() * 2) + 1) : 1;
        if (k === 'sibling') qty = Math.max(2, qty);
        for (let q = 0; q < qty && roles.length < total; q++) roles.push(k);
      }
    });

    roles = sanitizeRoleDependencies(roles, total);
  }

  while (roles.length < total) roles.push('villager');
  return shuffle(roles);
}

function publicRoster(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    connected: !!(p.ws && p.ws.readyState === 1)
  }));
}

function broadcastRoster(room) {
  const payload = { type: 'room:roster', phase: room.phase, code: room.code, players: publicRoster(room) };
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
}

function assignRoles(room) {
  const players = Array.from(room.players.values());
  const total = players.length;
  const roles = computeRoles(total, room.config);

  players.forEach((p, i) => { p.role = roles[i]; });

  room.headhunterTargets = {};
  players.filter(p => p.role === 'headhunter').forEach(hh => {
    const targets = players.filter(p => p.id !== hh.id && p.role !== 'headhunter');
    if (targets.length) {
      room.headhunterTargets[hh.id] = targets[Math.floor(Math.random() * targets.length)].id;
    }
  });
}

// Builds the same "extra" private info showNightPlayerTurn() computes in
// index.html (fellow wolves, siblings, headhunter target) - each piece is
// only ever attached to the specific player's own payload, never broadcast.
function buildExtraFor(player, players, room) {
  if (isWolf(player.role)) {
    const others = players.filter(x => isWolf(x.role) && x.id !== player.id).map(x => x.name);
    return { kind: 'wolfpack', names: others };
  }
  if (player.role === 'sibling') {
    const others = players.filter(x => x.role === 'sibling' && x.id !== player.id).map(x => x.name);
    return { kind: 'siblings', names: others };
  }
  if (player.role === 'headhunter' && room.headhunterTargets[player.id]) {
    const tgt = players.find(x => x.id === room.headhunterTargets[player.id]);
    return { kind: 'headhunter_target', name: tgt ? tgt.name : null };
  }
  return null;
}

function sendPrivateRoles(room) {
  const players = Array.from(room.players.values());
  players.forEach(p => {
    const r = ROLES[p.role];
    const extra = buildExtraFor(p, players, room);
    p.lastExtra = extra;
    send(p.ws, {
      type: 'role:assign',
      role: p.role,
      name: r.name,
      team: r.team,
      desc: r.desc,
      extra
    });
  });
}

function makeRoom(hostWs) {
  const code = makeRoomCode();
  const room = {
    code,
    hostWs,
    players: new Map(),
    phase: 'lobby',
    config: null,
    headhunterTargets: {},
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      await handleMessage(ws, msg);
    } catch (e) {
      send(ws, { type: 'room:error', message: e.message || 'Something went wrong.' });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (ws.isHost && room.hostWs === ws) {
      room.hostWs = null;
    }
    if (ws.playerId) {
      const player = room.players.get(ws.playerId);
      if (player && player.ws === ws) {
        player.ws = null;
        broadcastRoster(room);
      }
    }
  });
});

async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'host:create': {
      const room = makeRoom(ws);
      ws.roomCode = room.code;
      ws.isHost = true;

      const addrs = getLanAddresses();
      const candidates = addrs.length ? addrs : ['localhost'];
      const options = await Promise.all(candidates.map(async (ip) => {
        const joinUrl = `http://${ip}:${PORT}/player.html?room=${room.code}`;
        const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 280 });
        return { ip, joinUrl, qrDataUrl };
      }));

      send(ws, { type: 'room:created', code: room.code, options });
      break;
    }

    case 'host:reattach': {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'room:error', message: 'Room not found.' });
      room.hostWs = ws;
      ws.roomCode = room.code;
      ws.isHost = true;
      broadcastRoster(room);
      break;
    }

    case 'player:join': {
      const room = rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'room:error', message: 'Room code not found.' });
      if (room.phase !== 'lobby') return send(ws, { type: 'room:error', message: 'This game has already started.' });

      const name = (msg.name || '').trim().slice(0, 24);
      if (!name) return send(ws, { type: 'room:error', message: 'Name is required.' });
      const taken = Array.from(room.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase());
      if (taken) return send(ws, { type: 'room:error', message: 'That name is already taken in this room.' });

      const id = crypto.randomUUID();
      const token = makeToken();
      room.players.set(id, { id, name, token, ws, role: null, lastExtra: null });
      ws.roomCode = room.code;
      ws.playerId = id;

      send(ws, { type: 'player:joined', playerId: id, token, roomCode: room.code, name });
      broadcastRoster(room);
      break;
    }

    case 'player:rejoin': {
      const room = rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'room:error', message: 'Room not found.' });
      const player = room.players.get(msg.playerId);
      if (!player || player.token !== msg.token) {
        return send(ws, { type: 'room:error', message: 'Could not reconnect you to that seat.' });
      }

      player.ws = ws;
      ws.roomCode = room.code;
      ws.playerId = player.id;

      send(ws, { type: 'player:joined', playerId: player.id, token: player.token, roomCode: room.code, name: player.name });
      if (player.role) {
        const r = ROLES[player.role];
        send(ws, {
          type: 'role:assign',
          role: player.role,
          name: r.name,
          team: r.team,
          desc: r.desc,
          extra: player.lastExtra || null
        });
      }
      broadcastRoster(room);
      break;
    }

    case 'host:kick': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost) return;
      const player = room.players.get(msg.playerId);
      if (player) {
        send(player.ws, { type: 'room:kicked' });
        room.players.delete(msg.playerId);
        broadcastRoster(room);
      }
      break;
    }

    case 'host:start': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost) return;
      if (room.players.size < MIN_PLAYERS) {
        return send(ws, { type: 'room:error', message: `Need at least ${MIN_PLAYERS} players.` });
      }

      room.config = {
        assignmentMode: msg.assignmentMode,
        roleToggles: msg.roleToggles || {},
        customRoleCounts: msg.customRoleCounts || {}
      };

      assignRoles(room);
      room.phase = 'roles-assigned';
      sendPrivateRoles(room);
      broadcastRoster(room);
      send(ws, { type: 'host:started' });
      break;
    }

    default:
      break;
  }
}

// Periodically reap abandoned rooms (no host, no connected players, old).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.hostWs || Array.from(room.players.values()).some(p => p.ws);
    if (!anyConnected && now - room.createdAt > STALE_ROOM_MS) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000).unref();
