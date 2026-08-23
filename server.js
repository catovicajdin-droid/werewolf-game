const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const engine = require('./gameEngine.js');
const ROLES = engine.ROLES;

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
  const roles = engine.computeRoles(total, room.config);

  players.forEach((p, i) => {
    p.role = roles[i];
    engine.initPlayerRuntime(p);
  });

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
  if (engine.isWolf(player.role)) {
    const others = players.filter(x => engine.isWolf(x.role) && x.id !== player.id).map(x => x.name);
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

      // If this seat already has a different live connection, that old one
      // is about to be orphaned (e.g. two tabs somehow ended up sharing the
      // same reconnect token). Tell it plainly instead of letting it just
      // silently stop receiving messages, which is much harder to notice.
      if (player.ws && player.ws !== ws && player.ws.readyState === player.ws.OPEN) {
        send(player.ws, { type: 'room:kicked', reason: 'seat-reclaimed' });
        player.ws.close();
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
      const settings = {
        firstNightImmunity: !!msg.settings?.firstNightImmunity,
        allowSkipVotes: !!msg.settings?.allowSkipVotes,
        hideVoteCounts: !!msg.settings?.hideVoteCounts,
        dayTimer: Number.isFinite(msg.settings?.dayTimer) ? Math.max(0, msg.settings.dayTimer) : 180
      };

      assignRoles(room);
      room.game = engine.freshGameState(settings);
      room.phase = 'roles-assigned';
      sendPrivateRoles(room);
      broadcastRoster(room);
      send(ws, { type: 'host:started' });
      break;
    }

    case 'host:begin-night': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost || !room.game) return;
      if (room.phase !== 'roles-assigned' && room.phase !== 'day-results') return;
      startNight(room);
      break;
    }

    case 'night:inspect': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game || room.phase !== 'night') return;
      const player = room.players.get(ws.playerId);
      if (!player || !player.alive) return;
      const players = Array.from(room.players.values());
      const result = engine.applyInspect(room.game, players, player, msg.inspectKind, msg.targetId, msg.targetId2);
      send(ws, { type: 'night:inspect-result', fieldId: msg.fieldId, result });
      break;
    }

    case 'night:submit': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game || room.phase !== 'night') return;
      const player = room.players.get(ws.playerId);
      if (!player || !player.alive) return;
      if (room.game.submitted[player.id]) return; // already submitted this night

      const players = Array.from(room.players.values());
      engine.applyNightSubmission(room.game, players, player, msg.submission || {});
      room.game.submitted[player.id] = true;

      broadcastNightProgress(room);
      maybeResolveNight(room);
      break;
    }

    case 'host:begin-day': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost || !room.game || room.phase !== 'morning') return;
      room.phase = 'day-discussion';
      const votingCancelled = !!room.game.pacifistRevealTarget || room.game.votingDisabledThisRound;
      const payload = {
        type: 'day:begin',
        round: room.game.round,
        silencedName: room.game.silencedId ? (room.players.get(room.game.silencedId) || {}).name || null : null,
        votingCancelled,
        cancelReason: room.game.pacifistRevealTarget ? 'pacifist' : (room.game.votingDisabledThisRound ? 'vigilante' : null),
        dayTimerSeconds: room.game.settings.dayTimer
      };
      send(room.hostWs, payload);
      room.players.forEach(p => send(p.ws, payload));
      break;
    }

    case 'host:skip-to-night': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost || !room.game || room.phase !== 'day-discussion') return;
      advanceRoundOrEnd(room);
      break;
    }

    case 'host:open-vote': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost || !room.game || room.phase !== 'day-discussion') return;
      startVote(room);
      break;
    }

    case 'vote:submit': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game || room.phase !== 'day-vote') return;
      const player = room.players.get(ws.playerId);
      if (!player || !player.alive) return;
      if (room.game.submitted[player.id]) return;

      engine.applyVoteSubmission(room.game, player, msg.targetId || null);
      room.game.submitted[player.id] = true;

      broadcastNightProgress(room);
      maybeResolveVotes(room);
      break;
    }

    case 'host:next-night': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost || !room.game || room.phase !== 'day-results') return;
      advanceRoundOrEnd(room);
      break;
    }

    default:
      break;
  }
}

function startNight(room) {
  engine.beginNight(room.game);
  const players = Array.from(room.players.values());
  const living = players.filter(p => p.alive);
  room.game.pendingSubmitters = living.map(p => p.id);
  room.phase = 'night';

  living.forEach(player => {
    const prompt = engine.buildNightPrompt(room.game, players, room.headhunterTargets, player);
    send(player.ws, {
      type: 'night:prompt',
      round: room.game.round,
      role: player.role,
      roleName: ROLES[player.role].name,
      team: ROLES[player.role].team,
      roleDesc: ROLES[player.role].desc,
      ...prompt
    });
  });

  broadcastNightProgress(room);
  maybeResolveNight(room);
}

function broadcastNightProgress(room) {
  if (!room.game) return;
  const pending = room.phase === 'day-vote' ? room.game.pendingVoters : room.game.pendingSubmitters;
  const players = Array.from(room.players.values());
  const payload = {
    type: room.phase === 'day-vote' ? 'vote:progress' : 'night:progress',
    round: room.game.round,
    players: (pending || []).map(id => {
      const p = players.find(x => x.id === id);
      return { name: p ? p.name : 'Unknown', submitted: !!room.game.submitted[id] };
    })
  };
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
}

function maybeResolveNight(room) {
  const pending = room.game.pendingSubmitters || [];
  if (!pending.every(id => room.game.submitted[id])) return;

  const players = Array.from(room.players.values());
  const { killed, gameOverMsg } = engine.resolveNight(room.game, players, room.headhunterTargets);

  if (gameOverMsg) {
    endGame(room, gameOverMsg);
    return;
  }

  room.phase = 'morning';
  const notes = [];
  if (room.game.pacifistRevealTarget) {
    const pt = players.find(p => p.id === room.game.pacifistRevealTarget);
    if (pt) notes.push({ kind: 'pacifist', name: pt.name, roleName: ROLES[pt.role].name, team: ROLES[pt.role].team });
  }
  if (room.game.nightActions.mayorRevealedThisTurn) {
    const mayor = players.find(p => p.role === 'mayor');
    if (mayor) notes.push({ kind: 'mayor-revealed', name: mayor.name });
  }
  if (room.game.nightActions.gunnerShot) {
    const g = players.find(p => p.id === room.game.nightActions.gunnerShot.gunnerId);
    if (g) notes.push({ kind: 'gunner-shot', name: g.name });
  }
  if (room.game.nightActions.marksmanExecute && room.game.nightActions.marksmanExecute.targetId) {
    const m = players.find(p => p.id === room.game.nightActions.marksmanExecute.marksmanId);
    if (m) notes.push({ kind: 'marksman-executed', name: m.name });
  }
  if (room.game.nightActions.vigilanteAction && room.game.nightActions.vigilanteAction.mode === 'inspect') {
    notes.push({ kind: 'vigilante-inspect' });
  }

  const payload = {
    type: 'morning:report',
    round: room.game.round,
    killedNames: killed.map(p => p.name),
    notes
  };
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
}

function startVote(room) {
  room.phase = 'day-vote';
  room.game.dayVotes = {};
  room.game.submitted = {};
  const players = Array.from(room.players.values());
  const living = players.filter(p => p.alive);
  room.game.pendingVoters = living.map(p => p.id);

  living.forEach(player => {
    const prompt = engine.buildVotePrompt(room.game, players, player);
    send(player.ws, { type: 'vote:prompt', round: room.game.round, ...prompt });
    if (prompt.silenced) room.game.submitted[player.id] = true;
  });

  broadcastNightProgress(room);
  maybeResolveVotes(room);
}

function maybeResolveVotes(room) {
  const pending = room.game.pendingVoters || [];
  if (!pending.every(id => room.game.submitted[id])) return;

  const players = Array.from(room.players.values());
  const result = engine.resolveVotes(room.game, players, room.headhunterTargets);

  if (result.gameOverMsg) {
    endGame(room, result.gameOverMsg);
    return;
  }

  room.phase = 'day-results';
  const payload = { type: 'day:result', round: room.game.round, ...result };
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
}

function advanceRoundOrEnd(room) {
  const players = Array.from(room.players.values());
  const winMsg = engine.checkWin(room.game, players);
  if (winMsg) {
    endGame(room, winMsg);
    return;
  }
  room.game.round++;
  startNight(room);
}

function endGame(room, message) {
  room.phase = 'game-over';
  const players = Array.from(room.players.values());
  const payload = { type: 'game:over', message, finalRoles: engine.buildFinalRoles(players) };
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
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
