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

async function buildJoinOptions(roomCode) {
  const addrs = getLanAddresses();
  const candidates = addrs.length ? addrs : ['localhost'];
  return Promise.all(candidates.map(async (ip) => {
    const joinUrl = `http://${ip}:${PORT}/player.html?room=${roomCode}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 280 });
    return { ip, joinUrl, qrDataUrl };
  }));
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

function sendRoleAssignTo(player, players, room) {
  const r = ROLES[player.role];
  const extra = buildExtraFor(player, players, room);
  player.lastExtra = extra;
  send(player.ws, {
    type: 'role:assign',
    role: player.role,
    name: r.name,
    team: r.team,
    desc: r.desc,
    extra
  });
}

function sendPrivateRoles(room) {
  const players = Array.from(room.players.values());
  players.forEach(p => sendRoleAssignTo(p, players, room));
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
    createdAt: Date.now(),
    // Cached copies of the last broadcast for each phase, so a host that
    // reattaches (tab reload, phone lock) can be resynced to exactly what
    // they were last looking at instead of losing the game's current state.
    lastMorningReport: null,
    // The day-discussion timer is tracked as an absolute deadline rather
    // than a fixed duration, so a resync (reload/reconnect) reports the
    // actual time left instead of restarting the countdown from the top.
    dayBeginStatic: null,
    dayDiscussionDeadline: null,
    lastDayResult: null,
    lastGameOver: null
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

      const options = await buildJoinOptions(room.code);
      send(ws, { type: 'room:created', code: room.code, options });
      break;
    }

    case 'host:reattach': {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'room:error', message: 'Room not found.' });
      room.hostWs = ws;
      ws.roomCode = room.code;
      ws.isHost = true;
      send(ws, { type: 'room:created', code: room.code, options: await buildJoinOptions(room.code) });
      broadcastRoster(room);
      sendHostCurrentState(room);
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
      room.players.set(id, {
        id, name, token, ws, role: null, lastExtra: null,
        pendingNightFields: null, pendingVoteOptions: null,
        lastNightRecap: null, lastVoteRecap: null,
        pendingInspectRecap: []
      });
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
      sendPlayerCurrentState(room, player);
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

    case 'host:end-session': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost) return;
      const payload = { type: 'room:kicked', reason: 'host-ended-session' };
      room.players.forEach(p => send(p.ws, payload));
      rooms.delete(room.code);
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
        passiveTimerToggle: !!msg.settings?.passiveTimerToggle,
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
      if (result) {
        // Inspect fields never leave a trace in the submission itself (the
        // result was already shown live), so without this the end-of-night
        // recap would wrongly say "you didn't use an action tonight" even
        // though inspecting IS the action for a Seer/Detective/etc.
        const field = (player.pendingNightFields || []).find(f => f.id === msg.fieldId || (f.ids && f.ids[0] === msg.fieldId));
        const label = field ? field.label : 'Inspected a player';
        const targetName = result.name || [result.name1, result.name2].filter(Boolean).join(' & ');
        player.pendingInspectRecap.push(targetName ? `${label}: ${targetName}` : label);
      }
      break;
    }

    case 'night:submit': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game || room.phase !== 'night') return;
      const player = room.players.get(ws.playerId);
      if (!player || !player.alive) return;
      if (room.game.submitted[player.id]) return; // already submitted this night

      const players = Array.from(room.players.values());
      const submission = msg.submission || {};
      engine.applyNightSubmission(room.game, players, player, submission);
      room.game.submitted[player.id] = true;

      player.lastNightRecap = [...player.pendingInspectRecap, ...engine.summarizeSubmission(player.pendingNightFields, submission)];
      send(ws, { type: 'night:ack', recapLines: player.lastNightRecap });

      if (engine.isWolf(player.role) && submission.wolfIndividualVote) {
        broadcastWolfVoteUpdate(room);
      }

      broadcastNightProgress(room);
      maybeResolveNight(room);
      break;
    }

    case 'host:begin-day': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.isHost || !room.game || room.phase !== 'morning') return;
      room.phase = 'day-discussion';
      const votingCancelled = !!room.game.pacifistRevealTarget || room.game.votingDisabledThisRound;
      room.dayBeginStatic = {
        round: room.game.round,
        silencedName: room.game.silencedId ? (room.players.get(room.game.silencedId) || {}).name || null : null,
        votingCancelled,
        cancelReason: room.game.pacifistRevealTarget ? 'pacifist' : (room.game.votingDisabledThisRound ? 'vigilante' : null)
      };
      room.dayDiscussionDeadline = room.game.settings.dayTimer > 0 ? Date.now() + room.game.settings.dayTimer * 1000 : null;
      const payload = buildDayBeginPayload(room);
      send(room.hostWs, payload);
      // Eliminated players don't get another go at the discussion screen -
      // they already got their player:eliminated notice and stay parked on
      // it until the game ends.
      room.players.forEach(p => { if (p.alive) send(p.ws, payload); });
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

      const players = Array.from(room.players.values());
      const targetId = msg.targetId || null;
      const wasSilenced = room.game.silencedId === player.id;
      engine.applyVoteSubmission(room.game, players, player, targetId);
      room.game.submitted[player.id] = true;

      let recapLine;
      if (wasSilenced) {
        recapLine = 'You were silenced and could not vote.';
      } else if (!targetId || targetId === 'abstain') {
        recapLine = 'You chose to abstain.';
      } else {
        const opt = (player.pendingVoteOptions || []).find(o => o.value === targetId);
        recapLine = `You voted for: ${opt ? opt.label : 'Unknown'}`;
      }
      player.lastVoteRecap = recapLine;
      send(ws, { type: 'vote:ack', recapLine });

      if (!wasSilenced && targetId && targetId !== 'abstain') {
        broadcastDayVoteUpdate(room);
      }

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
  const players = Array.from(room.players.values());
  const { swappedPlayerIds } = engine.beginNight(room.game, players);
  if (swappedPlayerIds) {
    // A Naughty Boy swap just resolved - the affected players' own
    // role:assign (name/team/desc, shown on their waiting/recap screens)
    // would otherwise go stale until the game ends, since only the night
    // prompt itself gets fresh role data on its own.
    swappedPlayerIds.forEach(id => {
      const p = room.players.get(id);
      if (p) sendRoleAssignTo(p, players, room);
    });
  }
  const living = players.filter(p => p.alive);
  room.game.pendingSubmitters = living.map(p => p.id);
  room.phase = 'night';

  living.forEach(player => {
    const prompt = engine.buildNightPrompt(room.game, players, room.headhunterTargets, player);
    player.pendingNightFields = prompt.fields;
    player.lastNightRecap = null;
    player.pendingInspectRecap = [];
    const passiveTimerSeconds = passiveTimerSecondsFor(room, prompt);
    // Tracked as an absolute deadline (not just the flat duration below) so
    // a reconnect mid-countdown reports the actual time left instead of
    // handing back a fresh 7 seconds every time the prompt resends.
    player.passiveTimerDeadline = passiveTimerSeconds > 0 ? Date.now() + passiveTimerSeconds * 1000 : null;
    send(player.ws, {
      type: 'night:prompt',
      round: room.game.round,
      role: player.role,
      roleName: ROLES[player.role].name,
      team: ROLES[player.role].team,
      roleDesc: ROLES[player.role].desc,
      passiveTimerSeconds,
      ...prompt
    });
  });

  broadcastNightProgress(room);
  maybeResolveNight(room);
}

// A passive player (nothing to do this night) would otherwise submit
// instantly, and since night:progress broadcasts who's submitted to every
// player in real time, that speed alone can tip others off that they're
// passive - the "Passive Role Buffer Timer" setting enforces a short wait
// before the client will let them confirm, so a quick pass isn't a tell.
function passiveTimerSecondsFor(room, prompt) {
  return (prompt.passive && room.game.settings.passiveTimerToggle) ? 7 : 0;
}

// Remaining time on a player's passive-buffer countdown, computed from the
// deadline startNight() set - used when RESENDING the prompt (reconnect)
// so the wait doesn't restart from 7s every time.
function remainingPassiveTimerSeconds(player) {
  if (!player.passiveTimerDeadline) return 0;
  return Math.max(0, Math.round((player.passiveTimerDeadline - Date.now()) / 1000));
}

// Same idea for the day-discussion timer - recomputes remaining seconds
// from the room's absolute deadline every time it's sent (initial
// broadcast or a later resync), instead of replaying the original duration.
function buildDayBeginPayload(room) {
  const dayTimerSeconds = room.dayDiscussionDeadline
    ? Math.max(0, Math.round((room.dayDiscussionDeadline - Date.now()) / 1000))
    : 0;
  return { type: 'day:begin', ...room.dayBeginStatic, dayTimerSeconds };
}

function buildProgressPayload(room) {
  const pending = room.phase === 'day-vote' ? room.game.pendingVoters : room.game.pendingSubmitters;
  const players = Array.from(room.players.values());
  return {
    type: room.phase === 'day-vote' ? 'vote:progress' : 'night:progress',
    round: room.game.round,
    players: (pending || []).map(id => {
      const p = players.find(x => x.id === id);
      return { name: p ? p.name : 'Unknown', submitted: !!room.game.submitted[id] };
    })
  };
}

function broadcastNightProgress(room) {
  if (!room.game) return;
  const payload = buildProgressPayload(room);
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
}

// Sends the live "who's voting for whom" panel to wolves who haven't
// submitted their kill vote yet, so the pack can coordinate in real time -
// mirrors the single-device app's wolfVoteHistory panel, made live since
// prompts now all go out simultaneously instead of turn by turn.
function broadcastWolfVoteUpdate(room) {
  const players = Array.from(room.players.values());
  const pendingWolves = players.filter(p => p.alive && engine.isWolf(p.role) && !room.game.submitted[p.id]);
  pendingWolves.forEach(w => {
    send(w.ws, { type: 'night:wolf-vote-update', wolfVoteHistory: room.game.wolfVoteHistory });
  });
}

// Same idea for the day vote - villagers should see who's voting for whom
// as it happens, not just after everyone's locked in - unless the host has
// the "Hide Live Vote Numbers" setting on for this game, or a Shadow
// Werewolf obscured today's vote specifically, in which case the running
// tally stays concealed until the host reveals the result.
function broadcastDayVoteUpdate(room) {
  if (room.game.settings.hideVoteCounts || room.game.dayVoteObscured) return;
  const players = Array.from(room.players.values());
  const pending = players.filter(p => p.alive && !room.game.submitted[p.id]);
  pending.forEach(p => {
    send(p.ws, { type: 'vote:tally-update', dayVoteHistory: room.game.dayVoteHistory });
  });
}

// Tells a player the moment they die (night kill, lynch, or any chained
// death) so their client leaves whatever screen it was on for a dedicated
// "you're out" screen, instead of sitting on a stale prompt/waiting screen
// that still implies they have something left to do once the host advances.
function notifyEliminated(room, killedPlayers) {
  killedPlayers.forEach(p => {
    const r = ROLES[p.role];
    send(p.ws, { type: 'player:eliminated', reason: p.deathReason, roleName: r.name, team: r.team });
  });
}

function maybeResolveNight(room) {
  const pending = room.game.pendingSubmitters || [];
  if (!pending.every(id => room.game.submitted[id])) return;

  const players = Array.from(room.players.values());
  const { killed, gameOverMsg } = engine.resolveNight(room.game, players, room.headhunterTargets);
  notifyEliminated(room, killed);

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
  // Host-only: results are narrated by the game master, not broadcast to
  // every phone. Players stay on their own recap/waiting screen.
  room.lastMorningReport = payload;
  send(room.hostWs, payload);
}

function startVote(room) {
  room.phase = 'day-vote';
  room.game.dayVotes = {};
  room.game.dayVoteHistory = [];
  room.game.submitted = {};
  // Consume a Shadow Werewolf's obscure-tomorrow's-vote power, if used the
  // night before - applies to exactly this one day-vote, then clears.
  room.game.dayVoteObscured = !!room.game.dayVoteObscuredNextRound;
  room.game.dayVoteObscuredNextRound = false;
  const players = Array.from(room.players.values());
  const living = players.filter(p => p.alive);
  room.game.pendingVoters = living.map(p => p.id);

  living.forEach(player => {
    const prompt = engine.buildVotePrompt(room.game, players, player);
    player.pendingVoteOptions = prompt.options;
    player.lastVoteRecap = null;
    send(player.ws, { type: 'vote:prompt', round: room.game.round, ...prompt });
  });

  broadcastNightProgress(room);
  maybeResolveVotes(room);
}

function maybeResolveVotes(room) {
  const pending = room.game.pendingVoters || [];
  if (!pending.every(id => room.game.submitted[id])) return;

  const players = Array.from(room.players.values());
  const result = engine.resolveVotes(room.game, players, room.headhunterTargets);
  notifyEliminated(room, result.killed);

  if (result.gameOverMsg) {
    endGame(room, result.gameOverMsg);
    return;
  }

  room.phase = 'day-results';
  const payload = { type: 'day:result', round: room.game.round, ...result };
  // Host-only, same reasoning as the morning report.
  room.lastDayResult = payload;
  send(room.hostWs, payload);
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
  room.lastGameOver = payload;
  send(room.hostWs, payload);
  room.players.forEach(p => send(p.ws, payload));
}

// Resyncs a reconnecting player to wherever the game currently is, instead
// of leaving their client stuck on whatever screen it last rendered.
function sendPlayerCurrentState(room, player) {
  if (!player.role) return; // game hasn't started yet - the lobby screen is already correct

  const r = ROLES[player.role];
  send(player.ws, {
    type: 'role:assign',
    role: player.role, name: r.name, team: r.team, desc: r.desc,
    extra: player.lastExtra || null
  });

  if (!room.game) return;

  if (!player.alive) {
    // A reconnecting dead player should land back on the eliminated screen,
    // not be left on whatever they were looking at when they died.
    send(player.ws, { type: 'player:eliminated', reason: player.deathReason, roleName: r.name, team: r.team });
    return;
  }

  if (room.phase === 'night') {
    if (room.game.submitted[player.id]) {
      send(player.ws, { type: 'night:ack', recapLines: player.lastNightRecap || [], resync: true });
    } else {
      const players = Array.from(room.players.values());
      const prompt = engine.buildNightPrompt(room.game, players, room.headhunterTargets, player);
      player.pendingNightFields = prompt.fields;
      send(player.ws, {
        type: 'night:prompt', round: room.game.round,
        role: player.role, roleName: r.name, team: r.team, roleDesc: r.desc,
        passiveTimerSeconds: remainingPassiveTimerSeconds(player),
        ...prompt
      });
    }
  } else if (room.phase === 'morning') {
    send(player.ws, { type: 'night:ack', recapLines: player.lastNightRecap || [], resync: true });
  } else if (room.phase === 'day-discussion') {
    if (room.dayBeginStatic) send(player.ws, buildDayBeginPayload(room));
  } else if (room.phase === 'day-vote') {
    if (room.game.submitted[player.id]) {
      send(player.ws, { type: 'vote:ack', recapLine: player.lastVoteRecap || '', resync: true });
    } else {
      const players = Array.from(room.players.values());
      const prompt = engine.buildVotePrompt(room.game, players, player);
      player.pendingVoteOptions = prompt.options;
      send(player.ws, { type: 'vote:prompt', round: room.game.round, ...prompt });
    }
  } else if (room.phase === 'day-results') {
    send(player.ws, { type: 'vote:ack', recapLine: player.lastVoteRecap || '', resync: true });
  } else if (room.phase === 'game-over') {
    if (room.lastGameOver) send(player.ws, room.lastGameOver);
  }
}

// Same idea for a reattaching host - restores whichever screen matches the
// room's current phase instead of dumping them back to a blank lobby.
function sendHostCurrentState(room) {
  if (!room.game) {
    if (room.phase === 'roles-assigned') send(room.hostWs, { type: 'host:started' });
    return;
  }

  if (room.phase === 'roles-assigned') {
    send(room.hostWs, { type: 'host:started' });
  } else if (room.phase === 'night' || room.phase === 'day-vote') {
    send(room.hostWs, buildProgressPayload(room));
  } else if (room.phase === 'morning') {
    if (room.lastMorningReport) send(room.hostWs, room.lastMorningReport);
  } else if (room.phase === 'day-discussion') {
    if (room.dayBeginStatic) send(room.hostWs, buildDayBeginPayload(room));
  } else if (room.phase === 'day-results') {
    if (room.lastDayResult) send(room.hostWs, room.lastDayResult);
  } else if (room.phase === 'game-over') {
    if (room.lastGameOver) send(room.hostWs, room.lastGameOver);
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
