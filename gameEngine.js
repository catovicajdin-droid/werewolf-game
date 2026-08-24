// Pure game-logic engine for the networked multi-device mode. No networking,
// no DOM - just plain data in, plain data out, so it can be unit tested in
// isolation and so server.js stays focused on transport/wiring.
//
// This is a faithful line-by-line port of the single-device game's logic in
// index.html (ROLES night-action building, commitPlayerTurn,
// resolveNightPhase/processCasualties, resolveDayVotes, checkWin) - ported
// to run server-side (since client-side game state would let any player
// read everyone's role via devtools) and re-expressed as data descriptors
// instead of HTML strings (so ONE generic renderer on the client can handle
// all 46 roles instead of 46 bespoke UI branches).
'use strict';

const crypto = require('crypto');
const ROLES = require('./public/shared/roles.js');

function isWolf(role) {
  return !!(ROLES[role] && ROLES[role].team === 'wolf');
}

function isEvil(role) {
  return isWolf(role) || role === 'serial_killer' || role === 'arsonist';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Mirrors sanitizeRoleDependencies() in index.html.
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

function alivePlayers(players) {
  return players.filter(p => p.alive);
}

function initPlayerRuntime(p) {
  p.alive = true;
  p.deathReason = null;
  p.usedOneTime = false;
  p.bullets = 2;
  p.arrows = 2;
  p.sleepCharges = 2;
}

function freshNightActions() {
  return {
    protectId: null,
    bodyguardId: null,
    serialKillId: null,
    witchHealUsedTurn: false,
    witchPoisonId: null,
    arsonistAction: null,
    sectHunterTarget: null,
    priestTarget: null,
    asleepTarget: null,
    silencedTarget: null,
    redLadyStay: null,
    kittenBiteId: null,
    reviveId: null,
    marksmanExecute: null,
    gunnerShot: null,
    vigilanteAction: null,
    mayorRevealedThisTurn: false
  };
}

function freshGameState(settings) {
  return {
    round: 1,
    settings,
    nightWolfVotes: {},
    wolfVoteHistory: [],
    nightActions: freshNightActions(),
    dayVotes: {},
    lovers: null,
    sect: [],
    doused: [],
    beastTrapped: null,
    activeTrap: null,
    asleepId: null,
    silencedId: null,
    pacifistRevealTarget: null,
    mayorRevealed: false,
    votingDisabledThisRound: false,
    witchHealUsed: false,
    witchPoisonUsed: false,
    seenBySeer: {},
    graveRobberTargets: {},
    avengerTargets: {},
    juniorTargets: {},
    toughGuyAttacked: false,
    marksmanTargets: {},
    submitted: {},
    dayVoteHistory: [],
    doctorUsedTargets: []
  };
}

// Builds a plain-language recap of what a player just submitted, from the
// same field descriptors the client rendered - so the two never drift.
// Inspect-type fields are skipped since their result was already shown
// live during the player's own turn.
function summarizeSubmission(fields, submission) {
  const lines = [];
  (fields || []).forEach(f => {
    if (f.type === 'select') {
      const val = submission[f.id];
      if (val) {
        const o = f.options.find(x => x.value === val);
        const label = o ? o.label.replace(/\s*\[.*?\]\s*$/, '') : val;
        lines.push(`${f.label}: ${label}`);
      }
    } else if (f.type === 'checkbox') {
      if (submission[f.id]) lines.push(f.label);
    } else if (f.type === 'select-pair') {
      const v1 = submission[f.ids[0]], v2 = submission[f.ids[1]];
      if (v1 && v2) {
        const l1 = (f.options.find(x => x.value === v1) || {}).label || v1;
        const l2 = (f.options.find(x => x.value === v2) || {}).label || v2;
        lines.push(`${f.label}: ${l1} & ${l2}`);
      }
    }
  });
  return lines;
}

function beginNight(game) {
  game.nightWolfVotes = {};
  game.wolfVoteHistory = [];
  game.pacifistRevealTarget = null;
  game.asleepId = null;
  game.votingDisabledThisRound = false;
  game.nightActions = freshNightActions();
  game.submitted = {};
}

// ---- Night prompt building (mirrors showNightPlayerTurn's action HTML) ----

function opt(p) { return { value: p.id, label: p.name }; }

function buildExtraInfo(player, players, headhunterTargets, game) {
  if (isWolf(player.role)) {
    const others = players.filter(p => isWolf(p.role) && p.id !== player.id);
    return { kind: 'wolfpack', wolves: others.map(w => ({ name: w.name, alive: w.alive })) };
  }
  if (player.role === 'sibling') {
    const others = players.filter(p => p.role === 'sibling' && p.id !== player.id);
    return { kind: 'siblings', names: others.map(s => s.name) };
  }
  if (player.role === 'headhunter' && headhunterTargets[player.id]) {
    const tgt = players.find(p => p.id === headhunterTargets[player.id]);
    return { kind: 'headhunter_target', name: tgt ? tgt.name : null };
  }
  if (game.lovers && game.lovers.includes(player.id)) {
    const partnerId = game.lovers.find(id => id !== player.id);
    const partner = players.find(p => p.id === partnerId);
    return { kind: 'lover', name: partner ? partner.name : null };
  }
  return null;
}

function buildNightPrompt(game, players, headhunterTargets, player) {
  const extra = buildExtraInfo(player, players, headhunterTargets, game);

  if (game.asleepId === player.id) {
    return { passive: true, message: 'You were put to sleep by the Nightmare Werewolf! You cannot perform actions tonight.', extra, fields: [] };
  }

  const living = alivePlayers(players);
  const otherLiving = living.filter(p => p.id !== player.id);
  const deadPlayers = players.filter(p => !p.alive);
  const fields = [];
  let passive = false;
  let message = null;

  if (isWolf(player.role)) {
    const nonWolves = living.filter(p => !isWolf(p.role));

    if (game.round === 1 && game.settings.firstNightImmunity) {
      fields.push({ type: 'info', text: 'First Night Kill Protection is ON. Werewolves cannot eliminate tonight.' });
    } else {
      // Always included (not just once someone's voted) - since votes are
      // simultaneous rather than turn-based, this panel is the live target
      // the client updates in place as teammates submit their kill vote,
      // so it needs a stable anchor even while empty.
      fields.push({
        type: 'info',
        id: 'wolfVoteHistoryPanel',
        label: '🐺 Pack Votes So Far',
        list: game.wolfVoteHistory.length ? game.wolfVoteHistory.map(v => `${v.voterName} voted for ${v.targetName}`) : ['No votes cast yet.']
      });
      const voteCounts = {};
      game.wolfVoteHistory.forEach(v => { voteCounts[v.targetId] = (voteCounts[v.targetId] || 0) + 1; });
      fields.push({
        type: 'select',
        id: 'wolfIndividualVote',
        label: 'Cast Your Individual Kill Vote',
        placeholder: 'Select player to eliminate...',
        options: nonWolves.map(p => ({
          value: p.id,
          label: p.name + (voteCounts[p.id] ? ` [🐺 ${voteCounts[p.id]} vote${voteCounts[p.id] > 1 ? 's' : ''}]` : '')
        }))
      });
    }

    let hasWolfSpecialAction = false;
    if (player.role === 'kitten_wolf' && !player.usedOneTime) {
      fields.push({ type: 'select', id: 'kittenBiteSelect', label: 'Kitten Wolf: Bite & Convert to Werewolf instead', placeholder: 'Do not bite tonight', options: nonWolves.map(opt) });
      hasWolfSpecialAction = true;
    } else if (player.role === 'nightmare_werewolf' && player.sleepCharges > 0) {
      fields.push({ type: 'select', id: 'nightmareTarget', label: `Nightmare Werewolf: Put a player to sleep tonight (${player.sleepCharges} use${player.sleepCharges !== 1 ? 's' : ''} left)`, placeholder: 'None (skip)', options: otherLiving.map(opt) });
      hasWolfSpecialAction = true;
    } else if (player.role === 'wolf_seer') {
      fields.push({ type: 'inspect', id: 'wolfSeerTarget', inspectKind: 'wolfseer', label: 'Wolf Seer: Uncover Exact Role', placeholder: 'Select player to uncover...', options: otherLiving.map(opt) });
      hasWolfSpecialAction = true;
    } else if (player.role === 'sorcerer') {
      fields.push({ type: 'inspect', id: 'sorcererTarget', inspectKind: 'sorcerer', label: 'Sorcerer: Check if Seer or Werewolf', placeholder: 'Select player to check...', options: otherLiving.map(opt) });
      hasWolfSpecialAction = true;
    } else if (player.role === 'junior_werewolf') {
      fields.push({ type: 'select', id: 'juniorSelect', label: 'Junior Werewolf: Choose Revenge Target', placeholder: 'Select target to drag down if you die...', options: otherLiving.map(opt) });
      hasWolfSpecialAction = true;
    }

    // With first-night immunity on, the pack has no kill vote to cast - if
    // this wolf also has no other independent action available (a plain
    // Werewolf, or a special role whose own action is already exhausted),
    // there is genuinely nothing to do, so mark them passive instead of
    // leaving them wrongly asked "are you sure you want to skip?" over an
    // action that was never on offer in the first place.
    if (game.round === 1 && game.settings.firstNightImmunity && !hasWolfSpecialAction) {
      passive = true;
    }
  } else if (player.role === 'pacifist' && !player.usedOneTime) {
    fields.push({ type: 'select', id: 'pacifistTargetSelect', label: 'Pacifist: Public Revelation & Peace (Once per game)', description: 'Select a player to publicly reveal their exact role to the town tomorrow morning and cancel daytime voting.', placeholder: 'Do not use tonight', options: otherLiving.map(opt) });
  } else if (player.role === 'avenger') {
    const curTarget = game.avengerTargets[player.id];
    const curName = curTarget ? (players.find(p => p.id === curTarget) || {}).name : null;
    fields.push({ type: 'info', text: `Current revenge target: ${curName || 'None'}` });
    fields.push({ type: 'select', id: 'avengerSelect', label: 'Select/Update who you drag down with you if you die', placeholder: 'Select player...', options: otherLiving.map(opt) });
  } else if (player.role === 'seer' || (player.role === 'seer_apprentice' && !players.some(x => x.role === 'seer' && x.alive))) {
    if (player.role === 'seer_apprentice') {
      fields.push({ type: 'info', text: '🔮 The true Seer has fallen! You have taken the mantle of the Seer.' });
    }
    const seen = game.seenBySeer[player.id] || [];
    const eligible = otherLiving.filter(p => !seen.includes(p.id));
    if (eligible.length > 0) {
      fields.push({ type: 'inspect', id: 'seerSelect', inspectKind: 'seer', label: "Investigate a Player's Exact Secret Role", placeholder: 'Select player...', options: eligible.map(opt) });
    } else {
      message = 'You have already investigated all living players.';
      passive = true;
    }
  } else if (player.role === 'seer_apprentice') {
    const livingSeer = players.find(x => x.role === 'seer' && x.alive);
    message = `🔮 You are apprenticing under the Seer${livingSeer ? ` (${livingSeer.name})` : ''}. You will awaken and inherit divination powers once the true Seer falls.`;
    passive = true;
  } else if (player.role === 'aura_seer') {
    fields.push({ type: 'inspect', id: 'auraSelect', inspectKind: 'aura', label: 'Inspect Player Aura (Good vs Evil)', placeholder: 'Select player...', options: otherLiving.map(opt) });
  } else if (player.role === 'detective') {
    fields.push({ type: 'inspect-pair', ids: ['det1', 'det2'], inspectKind: 'detective', label: 'Compare Team of Two Players', placeholders: ['Player 1...', 'Player 2...'], options: otherLiving.map(opt) });
  } else if (player.role === 'doctor') {
    const eligible = living.filter(p => !game.doctorUsedTargets.includes(p.id));
    if (eligible.length > 0) {
      fields.push({ type: 'select', id: 'doctorProtectSelect', label: 'Select a Player to Protect Tonight (each player can only be protected once per game)', placeholder: 'Select player...', options: eligible.map(opt) });
    } else {
      message = 'You have already protected every living player once - no new targets remain.';
      passive = true;
    }
  } else if (player.role === 'bodyguard') {
    fields.push({ type: 'select', id: 'bodyguardProtectSelect', label: 'Select a Player to Bodyguard (You die in their place if attacked)', placeholder: 'Select player...', options: otherLiving.map(opt) });
  } else if (player.role === 'witch') {
    fields.push({ type: 'info', text: `Potions - Heal: ${game.witchHealUsed ? 'Used' : 'Available'} | Poison: ${game.witchPoisonUsed ? 'Used' : 'Available'}` });
    if (!game.witchHealUsed) {
      fields.push({ type: 'checkbox', id: 'witchHealVillageCheck', label: 'Use Heal Potion tonight', description: 'Shield the entire village from werewolf attacks for this turn.' });
    }
    if (!game.witchPoisonUsed) {
      fields.push({ type: 'select', id: 'witchPoisonSelect', label: 'Poison a Player (Optional)', placeholder: 'Do not poison anyone', options: otherLiving.map(opt) });
    }
    if (game.witchHealUsed && game.witchPoisonUsed) {
      message = 'No potions remaining.';
      passive = true;
    }
  } else if (player.role === 'priest' && !player.usedOneTime) {
    fields.push({ type: 'select', id: 'priestSelect', label: 'Throw Holy Water (Once per game)', placeholder: 'Skip for tonight', options: otherLiving.map(opt) });
  } else if (player.role === 'medium' && !player.usedOneTime) {
    if (deadPlayers.length > 0) {
      fields.push({ type: 'select', id: 'mediumReviveSelect', label: 'Medium: Revive One Dead Player (Once per game)', placeholder: 'Do not revive anyone tonight', options: deadPlayers.map(p => ({ value: p.id, label: `${p.name} (${ROLES[p.role].name})` })) });
    } else {
      message = 'No dead players to revive currently.';
      passive = true;
    }
  } else if (player.role === 'serial_killer') {
    fields.push({ type: 'select', id: 'serialKillSelect', label: 'Choose Night Victim', placeholder: 'Select target...', options: otherLiving.map(opt) });
  } else if (player.role === 'arsonist') {
    fields.push({ type: 'info', text: `Currently Doused: ${game.doused.length ? players.filter(p => game.doused.includes(p.id)).map(p => p.name).join(', ') : 'None'}` });
    fields.push({ type: 'select', id: 'arsonistMode', label: 'Arsonist Action', options: [{ value: 'douse', label: 'Douse 2 Players with Gasoline' }, { value: 'ignite', label: 'Ignite All Doused Players' }], noEmpty: true, defaultValue: 'douse' });
    fields.push({ type: 'select', id: 'douse1', label: 'Target 1', placeholder: 'Target 1...', options: otherLiving.map(opt), dependsOn: { id: 'arsonistMode', equals: 'douse' } });
    fields.push({ type: 'select', id: 'douse2', label: 'Target 2', placeholder: 'Target 2...', options: otherLiving.map(opt), dependsOn: { id: 'arsonistMode', equals: 'douse' } });
  } else if (player.role === 'sect_leader') {
    const sectNames = players.filter(p => game.sect.includes(p.id)).map(p => p.name);
    fields.push({ type: 'info', text: `Current Sect: ${sectNames.length ? sectNames.join(', ') : 'Just you'}` });
    fields.push({ type: 'select', id: 'sectConvertSelect', label: 'Convert a Player to your Sect', placeholder: 'Select target...', options: otherLiving.filter(p => !game.sect.includes(p.id)).map(opt) });
  } else if (player.role === 'sect_hunter') {
    fields.push({ type: 'select', id: 'sectHuntSelect', label: 'Hunt Sect Member', placeholder: 'Select player to check & hunt...', options: otherLiving.map(opt) });
  } else if (player.role === 'grave_robber' && game.round === 1) {
    fields.push({ type: 'select', id: 'graveRobberSelect', label: 'Choose Target (Inherit their role if they die)', placeholder: 'Select player...', options: otherLiving.map(opt) });
  } else if (player.role === 'cupid' && game.round === 1 && !game.lovers) {
    fields.push({ type: 'select-pair', ids: ['cupidLover1', 'cupidLover2'], label: 'Bind Two Lovers for the Match', placeholders: ['Lover 1...', 'Lover 2...'], options: otherLiving.map(opt) });
  } else if (player.role === 'grumpy_grandma') {
    fields.push({ type: 'select', id: 'grandmaSilenceSelect', label: 'Silence a Player for Tomorrow', placeholder: 'Select player...', options: otherLiving.map(opt) });
  } else if (player.role === 'red_lady') {
    fields.push({ type: 'select', id: 'redLadySelect', label: "Visit a Player's House Tonight", placeholder: 'Stay at home', options: otherLiving.map(opt) });
  } else if (player.role === 'naughty_boy' && !player.usedOneTime) {
    fields.push({ type: 'select-pair', ids: ['swap1', 'swap2'], label: 'Swap Roles of Two Players (Once per game)', placeholders: ['Player 1...', 'Player 2...'], options: otherLiving.map(opt) });
  } else if (player.role === 'beast_hunter') {
    fields.push({ type: 'select', id: 'beastTrapSelect', label: 'Set Delayed Beast Trap', placeholder: 'Select player to trap...', options: otherLiving.map(opt) });
  } else if (player.role === 'marksman' && player.arrows > 0) {
    const curTarget = game.marksmanTargets[player.id];
    const curName = curTarget ? (players.find(p => p.id === curTarget) || {}).name : null;
    fields.push({ type: 'info', text: `Arrows: ${player.arrows} | Current Marked Target: ${curName || 'None'}` });
    if (curTarget) {
      fields.push({ type: 'checkbox', id: 'marksmanExecuteCheck', label: `Execute your marked target (${curName}) tonight`, description: "If they're innocent, you die instead." });
    }
    fields.push({ type: 'select', id: 'marksmanSelect', label: 'Mark a Different Target (executable on a future night)', placeholder: 'Keep current target', options: otherLiving.map(opt) });
  } else if (player.role === 'gunner' && player.bullets > 0) {
    fields.push({ type: 'info', text: `Bullets remaining: ${player.bullets}` });
    fields.push({ type: 'select', id: 'gunnerShootSelect', label: 'Fire at a Player Tonight (Optional)', placeholder: 'Do not shoot tonight', options: otherLiving.map(opt) });
  } else if (player.role === 'vigilante' && !player.usedOneTime) {
    fields.push({ type: 'select', id: 'vigilanteMode', label: 'Vigilante: Use your bullet to eliminate, or inspect a role instead (cancels voting tomorrow). Pick at most one', options: [{ value: '', label: 'Do nothing tonight' }, { value: 'kill', label: 'Eliminate a target' }, { value: 'inspect', label: 'Inspect a role (cancels voting)' }] });
    fields.push({ type: 'select', id: 'vigilanteTargetSelect', label: 'Target', placeholder: 'Select player...', options: otherLiving.map(opt) });
  } else if (player.role === 'mayor' && !game.mayorRevealed) {
    fields.push({ type: 'checkbox', id: 'mayorRevealCheck', label: 'Reveal yourself as Mayor', description: 'Your vote counts as 2 starting tomorrow.' });
  } else {
    message = 'You sleep peacefully through the night. No active night decisions needed.';
    passive = true;
  }

  return { passive, message, extra, fields };
}

// ---- Inspect (Seer/Aura Seer/Detective/Wolf Seer/Sorcerer) ----

function applyInspect(game, players, player, inspectKind, targetId, targetId2) {
  if (inspectKind === 'seer') {
    const tgt = players.find(p => p.id === targetId);
    if (!tgt) return null;
    if (!game.seenBySeer[player.id]) game.seenBySeer[player.id] = [];
    game.seenBySeer[player.id].push(targetId);
    const r = ROLES[tgt.role];
    return { name: tgt.name, roleName: r.name, team: r.team, desc: r.desc };
  }
  if (inspectKind === 'wolfseer') {
    const tgt = players.find(p => p.id === targetId);
    if (!tgt) return null;
    const r = ROLES[tgt.role];
    return { name: tgt.name, roleName: r.name, team: r.team, desc: r.desc };
  }
  if (inspectKind === 'aura') {
    const tgt = players.find(p => p.id === targetId);
    if (!tgt) return null;
    return { name: tgt.name, evil: isEvil(tgt.role) };
  }
  if (inspectKind === 'sorcerer') {
    const tgt = players.find(p => p.id === targetId);
    if (!tgt) return null;
    return { name: tgt.name, match: isWolf(tgt.role) || tgt.role === 'seer' };
  }
  if (inspectKind === 'detective') {
    const t1 = players.find(p => p.id === targetId);
    const t2 = players.find(p => p.id === targetId2);
    if (!t1 || !t2 || t1.id === t2.id) return null;
    const team1 = ROLES[t1.role].team, team2 = ROLES[t2.role].team;
    const same = team1 === team2 && (team1 !== 'solo' || t1.role === t2.role);
    return { name1: t1.name, name2: t2.name, same };
  }
  return null;
}

// ---- Submission (mirrors commitPlayerTurn) ----

function applyNightSubmission(game, players, player, submission) {
  const v = (id) => submission[id] || null;

  if (isWolf(player.role)) {
    const voteVal = v('wolfIndividualVote');
    if (voteVal) {
      const weight = player.role === 'alpha_werewolf' ? 2 : 1;
      game.nightWolfVotes[voteVal] = (game.nightWolfVotes[voteVal] || 0) + weight;
      const tgt = players.find(p => p.id === voteVal);
      game.wolfVoteHistory.push({ voterId: player.id, voterName: player.name, targetId: voteVal, targetName: tgt ? tgt.name : 'Unknown' });
    }
    if (v('kittenBiteSelect')) {
      game.nightActions.kittenBiteId = v('kittenBiteSelect');
      player.usedOneTime = true;
    }
    if (v('nightmareTarget')) {
      game.nightActions.asleepTarget = v('nightmareTarget');
      game.asleepId = game.nightActions.asleepTarget;
      player.sleepCharges--;
    }
    if (v('juniorSelect')) {
      game.juniorTargets[player.id] = v('juniorSelect');
    }
  }
  if (v('pacifistTargetSelect')) {
    game.pacifistRevealTarget = v('pacifistTargetSelect');
    player.usedOneTime = true;
  }
  if (v('avengerSelect')) {
    game.avengerTargets[player.id] = v('avengerSelect');
  }
  if (v('doctorProtectSelect')) {
    game.nightActions.protectId = v('doctorProtectSelect');
    if (!game.doctorUsedTargets.includes(game.nightActions.protectId)) {
      game.doctorUsedTargets.push(game.nightActions.protectId);
    }
  }
  if (v('bodyguardProtectSelect')) {
    game.nightActions.bodyguardId = { guardId: player.id, targetId: v('bodyguardProtectSelect') };
  }
  if (submission.witchHealVillageCheck) {
    game.nightActions.witchHealUsedTurn = true;
    game.witchHealUsed = true;
  }
  if (v('witchPoisonSelect')) {
    game.nightActions.witchPoisonId = v('witchPoisonSelect');
    game.witchPoisonUsed = true;
  }
  if (v('priestSelect')) {
    game.nightActions.priestTarget = { priestId: player.id, targetId: v('priestSelect') };
    player.usedOneTime = true;
  }
  if (v('mediumReviveSelect')) {
    game.nightActions.reviveId = v('mediumReviveSelect');
    player.usedOneTime = true;
  }
  if (v('serialKillSelect')) {
    game.nightActions.serialKillId = v('serialKillSelect');
  }
  if (submission.arsonistMode) {
    if (submission.arsonistMode === 'ignite') {
      game.nightActions.arsonistAction = 'ignite';
    } else {
      const d1 = v('douse1');
      const d2 = v('douse2');
      if (d1 && !game.doused.includes(d1)) game.doused.push(d1);
      if (d2 && !game.doused.includes(d2)) game.doused.push(d2);
    }
  }
  if (v('sectConvertSelect')) {
    const cid = v('sectConvertSelect');
    if (!game.sect.includes(cid)) game.sect.push(cid);
  }
  if (v('sectHuntSelect')) {
    game.nightActions.sectHunterTarget = v('sectHuntSelect');
  }
  if (v('graveRobberSelect')) {
    game.graveRobberTargets[player.id] = v('graveRobberSelect');
  }
  if (v('cupidLover1') && v('cupidLover2')) {
    const l1 = v('cupidLover1'), l2 = v('cupidLover2');
    if (l1 && l2 && l1 !== l2) game.lovers = [l1, l2];
  }
  if (v('grandmaSilenceSelect')) {
    game.nightActions.silencedTarget = v('grandmaSilenceSelect');
  }
  if (v('redLadySelect')) {
    game.nightActions.redLadyStay = { ladyId: player.id, targetId: v('redLadySelect') };
  }
  if (v('swap1') && v('swap2') && v('swap1') !== v('swap2')) {
    const p1 = players.find(p => p.id === v('swap1'));
    const p2 = players.find(p => p.id === v('swap2'));
    if (p1 && p2) {
      const tmp = p1.role;
      p1.role = p2.role;
      p2.role = tmp;
      player.usedOneTime = true;
    }
  }
  if (v('beastTrapSelect')) {
    game.beastTrapped = v('beastTrapSelect');
  }
  if (submission.marksmanExecuteCheck) {
    game.nightActions.marksmanExecute = { marksmanId: player.id, targetId: game.marksmanTargets[player.id] };
    player.arrows--;
  }
  if (v('marksmanSelect')) {
    game.marksmanTargets[player.id] = v('marksmanSelect');
  }
  if (v('gunnerShootSelect')) {
    game.nightActions.gunnerShot = { gunnerId: player.id, targetId: v('gunnerShootSelect') };
    player.bullets--;
  }
  if (submission.vigilanteMode && v('vigilanteTargetSelect')) {
    game.nightActions.vigilanteAction = { vigId: player.id, targetId: v('vigilanteTargetSelect'), mode: submission.vigilanteMode };
    player.usedOneTime = true;
  }
  if (submission.mayorRevealCheck) {
    game.mayorRevealed = true;
    game.nightActions.mayorRevealedThisTurn = true;
  }
}

// ---- Night resolution (mirrors resolveNightPhase + processCasualties) ----

function processCasualties(game, players, headhunterTargets, deathList) {
  const queue = [...deathList];
  const dead = [];
  let gameOverMsg = null;

  while (queue.length) {
    const item = queue.shift();
    const p = players.find(x => x.id === item.id);
    if (!p || !p.alive) continue;
    p.alive = false;
    p.deathReason = item.reason;
    dead.push(p);

    if (p.role === 'avenger' && game.avengerTargets[p.id]) {
      queue.push({ id: game.avengerTargets[p.id], reason: `Dragged down by Avenger (${p.name})` });
    }
    if (p.role === 'junior_werewolf' && game.juniorTargets[p.id]) {
      queue.push({ id: game.juniorTargets[p.id], reason: `Dragged down by Junior Werewolf (${p.name})` });
    }
    if (p.role === 'mad_scientist') {
      const pIndex = players.findIndex(x => x.id === p.id);
      const living = players.filter(x => x.alive && x.id !== p.id);
      if (living.length > 0) {
        for (let i = 1; i < players.length; i++) {
          const left = players[(pIndex - i + players.length) % players.length];
          if (left.alive) { queue.push({ id: left.id, reason: `Explosion cloud from Mad Scientist (${p.name})` }); break; }
        }
        for (let i = 1; i < players.length; i++) {
          const right = players[(pIndex + i) % players.length];
          if (right.alive && !queue.some(q => q.id === right.id)) { queue.push({ id: right.id, reason: `Explosion cloud from Mad Scientist (${p.name})` }); break; }
        }
      }
    }
    Object.entries(game.graveRobberTargets).forEach(([grId, tgtId]) => {
      if (tgtId === p.id) {
        const gr = players.find(x => x.id === grId && x.alive);
        if (gr) gr.role = p.role;
      }
    });
    if (game.lovers && game.lovers.includes(p.id)) {
      const partnerId = game.lovers.find(x => x !== p.id);
      if (partnerId) queue.push({ id: partnerId, reason: `Heartbreak from Lover's death (${p.name})` });
    }
    Object.entries(headhunterTargets).forEach(([hhId, tgtId]) => {
      if (tgtId === p.id) {
        const hh = players.find(x => x.id === hhId);
        if (hh && hh.alive) hh.role = 'villager';
      }
    });
    if (p.role === 'president') {
      gameOverMsg = 'The President died! Werewolves Win.';
      return { killed: dead, gameOverMsg };
    }
  }
  return { killed: dead, gameOverMsg };
}

function checkWin(game, players) {
  const alive = alivePlayers(players);
  const wolves = alive.filter(p => isWolf(p.role)).length;
  const village = alive.filter(p => ROLES[p.role].team === 'village').length;
  const solos = alive.filter(p => ROLES[p.role].team === 'solo').length;

  if (game.lovers && alive.length === 2 && alive.every(p => game.lovers.includes(p.id))) {
    return '❤️ The Lovers survived to the end and win together!';
  }
  if (game.sect.length && alive.every(p => game.sect.includes(p.id) || p.role === 'sect_leader')) {
    return 'The Sect Leader and their Sect have converted everyone and win!';
  }
  if (alive.length === 1 && solos === 1) {
    return `${alive[0].name} (${ROLES[alive[0].role].name}) is the last survivor and wins!`;
  }
  if (wolves === 0 && solos === 0) return 'Villagers Win! All threats eliminated.';
  if (wolves >= (village + solos)) return 'Werewolves Win! The village has fallen.';
  return null;
}

function resolveNight(game, players, headhunterTargets) {
  const deaths = [];
  const activeTrap = game.activeTrap;
  game.activeTrap = game.beastTrapped;
  game.beastTrapped = null;

  if (game.nightActions.reviveId) {
    const rev = players.find(p => p.id === game.nightActions.reviveId);
    if (rev) { rev.alive = true; rev.deathReason = null; }
  }

  if (game.nightActions.kittenBiteId) {
    const b = players.find(p => p.id === game.nightActions.kittenBiteId);
    if (b) b.role = 'werewolf';
  }

  let maxVotes = 0, wolfVictims = [];
  Object.entries(game.nightWolfVotes).forEach(([id, count]) => {
    if (count > maxVotes) { maxVotes = count; wolfVictims = [id]; }
    else if (count === maxVotes) wolfVictims.push(id);
  });

  if (wolfVictims.length > 0 && !game.nightActions.kittenBiteId) {
    const wolfKilledId = wolfVictims[Math.floor(Math.random() * wolfVictims.length)];
    const victim = players.find(p => p.id === wolfKilledId);
    if (victim) {
      if (victim.role === 'cursed_human') {
        victim.role = 'werewolf';
      } else if (victim.id === activeTrap) {
        const livingWolves = players.filter(p => p.alive && isWolf(p.role) && p.id !== victim.id);
        if (livingWolves.length) {
          const weakest = livingWolves.find(w => w.role === 'werewolf') || livingWolves[Math.floor(Math.random() * livingWolves.length)];
          deaths.push({ id: weakest.id, reason: "Killed by Beast Hunter's trap (weakest wolf)" });
        }
      } else if (victim.role === 'tough_guy') {
        game.toughGuyAttacked = victim.id;
      } else if (game.nightActions.witchHealUsedTurn) {
        // Shielded
      } else if (game.nightActions.bodyguardId && game.nightActions.bodyguardId.targetId === victim.id) {
        deaths.push({ id: game.nightActions.bodyguardId.guardId, reason: 'Killed protecting target as Bodyguard' });
      } else if (victim.role !== 'wise_man' && victim.id !== game.nightActions.protectId) {
        deaths.push({ id: victim.id, reason: 'Eliminated by Werewolves' });
      }
    }
  }

  if (game.nightActions.marksmanExecute && game.nightActions.marksmanExecute.targetId) {
    const { marksmanId, targetId } = game.nightActions.marksmanExecute;
    const m = players.find(p => p.id === marksmanId);
    const tgt = players.find(p => p.id === targetId);
    if (m && tgt) {
      if (isEvil(tgt.role)) deaths.push({ id: tgt.id, reason: `Shot by Marksman (${m.name})` });
      else deaths.push({ id: m.id, reason: `Misfired upon innocent player (${tgt.name})` });
      game.marksmanTargets[marksmanId] = null;
    }
  }

  if (game.nightActions.gunnerShot) {
    const { gunnerId, targetId } = game.nightActions.gunnerShot;
    const g = players.find(p => p.id === gunnerId);
    const tgt = players.find(p => p.id === targetId);
    if (g && tgt) deaths.push({ id: tgt.id, reason: `Shot by Gunner (${g.name})` });
  }

  if (game.nightActions.vigilanteAction) {
    const { vigId, targetId, mode } = game.nightActions.vigilanteAction;
    const v = players.find(p => p.id === vigId);
    const tgt = players.find(p => p.id === targetId);
    if (v && tgt) {
      if (mode === 'kill') deaths.push({ id: tgt.id, reason: `Eliminated by Vigilante (${v.name})` });
      else if (mode === 'inspect') game.votingDisabledThisRound = true;
    }
  }

  if (game.nightActions.serialKillId) {
    deaths.push({ id: game.nightActions.serialKillId, reason: 'Eliminated by Serial Killer' });
  }

  if (game.nightActions.witchPoisonId) {
    deaths.push({ id: game.nightActions.witchPoisonId, reason: 'Poisoned by Witch' });
  }

  if (game.nightActions.priestTarget) {
    const { priestId, targetId } = game.nightActions.priestTarget;
    const tgt = players.find(p => p.id === targetId);
    if (tgt && isWolf(tgt.role)) deaths.push({ id: tgt.id, reason: 'Eliminated by Priest holy water' });
    else deaths.push({ id: priestId, reason: 'Failed Holy Water splash on innocent player' });
  }

  if (game.nightActions.arsonistAction === 'ignite') {
    game.doused.forEach(id => deaths.push({ id, reason: 'Incinerated by Arsonist' }));
    game.doused = [];
  }

  if (game.nightActions.sectHunterTarget) {
    const tgt = players.find(p => p.id === game.nightActions.sectHunterTarget);
    if (tgt && (tgt.role === 'sect_leader' || game.sect.includes(tgt.id))) {
      deaths.push({ id: tgt.id, reason: 'Eliminated by Sect Hunter' });
    }
  }

  if (game.nightActions.redLadyStay) {
    const { ladyId, targetId } = game.nightActions.redLadyStay;
    const tgt = players.find(p => p.id === targetId);
    if (tgt && (isWolf(tgt.role) || deaths.some(d => d.id === tgt.id))) {
      deaths.push({ id: ladyId, reason: 'Visited an evil player or home attacked by wolves' });
    }
  }

  const { killed, gameOverMsg: casualtyGameOver } = processCasualties(game, players, headhunterTargets, deaths);
  game.silencedId = game.nightActions.silencedTarget;

  const gameOverMsg = casualtyGameOver || checkWin(game, players);
  return { killed, gameOverMsg };
}

// ---- Day vote (mirrors showDayVotePlayerTurn + resolveDayVotes) ----

function buildVotePrompt(game, players, player) {
  if (game.silencedId === player.id) {
    return { silenced: true, options: [] };
  }
  const living = alivePlayers(players);
  const eligible = living.filter(p => p.id !== player.id);
  const options = eligible.map(opt);
  if (game.settings.allowSkipVotes) options.push({ value: 'abstain', label: 'Abstain / Skip' });
  return { silenced: false, options };
}

function applyVoteSubmission(game, players, player, targetId) {
  if (game.silencedId === player.id) return;
  if (!targetId || targetId === 'abstain') return;
  const weight = (player.role === 'mayor' && game.mayorRevealed) ? 2 : 1;
  game.dayVotes[player.id] = { targetId, weight };
  const tgt = players.find(p => p.id === targetId);
  game.dayVoteHistory.push({ voterId: player.id, voterName: player.name, targetId, targetName: tgt ? tgt.name : 'Unknown' });
}

// Does NOT call checkWin() itself (except the two immediate-win special
// cases below) - mirrors resolveDayVotes()/index.html, where the general
// win check only happens when the host advances to the next night, so the
// vote result stays on screen for everyone to read first.
function resolveVotes(game, players, headhunterTargets) {
  const tally = {};
  Object.values(game.dayVotes).forEach(v => {
    tally[v.targetId] = (tally[v.targetId] || 0) + v.weight;
  });

  let max = 0, tied = [];
  Object.entries(tally).forEach(([id, count]) => {
    if (count > max) { max = count; tied = [id]; }
    else if (count === max) tied.push(id);
  });

  const result = { eliminatedName: null, outcome: null, gameOverMsg: null, extraNotes: [], killed: [] };

  if (tied.length === 1 && max > 0) {
    const elim = players.find(p => p.id === tied[0]);
    const hhWinner = players.find(p => p.alive && p.role === 'headhunter' && headhunterTargets[p.id] === elim.id);
    if (hhWinner) {
      result.gameOverMsg = `🎯 Headhunter (${hhWinner.name}) successfully got their target (${elim.name}) lynched and wins!`;
      return result;
    }
    if (elim.role === 'fool') {
      result.gameOverMsg = `🎉 The Fool (${elim.name}) was lynched by the village and wins the game!`;
      return result;
    }
    if (elim.role === 'idiot' && !elim.usedOneTime) {
      elim.usedOneTime = true;
      result.outcome = 'idiot-survived';
      result.eliminatedName = elim.name;
    } else if (elim.role === 'handsome_prince' && !elim.usedOneTime) {
      elim.usedOneTime = true;
      result.outcome = 'prince-survived';
      result.eliminatedName = elim.name;
    } else {
      const { killed, gameOverMsg } = processCasualties(game, players, headhunterTargets, [{ id: elim.id, reason: 'Lynched by Village Majority Vote' }]);
      result.killed.push(...killed);
      if (gameOverMsg) result.gameOverMsg = gameOverMsg;
      result.outcome = 'lynched';
      result.eliminatedName = elim.name;
    }
  } else {
    result.outcome = 'no-majority';
  }

  if (game.toughGuyAttacked) {
    const tg = players.find(p => p.id === game.toughGuyAttacked);
    if (tg && tg.alive) {
      const { killed, gameOverMsg } = processCasualties(game, players, headhunterTargets, [{ id: tg.id, reason: "Succumbed to previous night's wounds (Tough Guy)" }]);
      result.killed.push(...killed);
      if (gameOverMsg) result.gameOverMsg = gameOverMsg;
      result.extraNotes.push({ kind: 'tough-guy-died', name: tg.name });
    }
    game.toughGuyAttacked = false;
  }

  return result;
}

function buildFinalRoles(players) {
  return players.map(p => ({
    name: p.name,
    roleName: ROLES[p.role].name,
    team: ROLES[p.role].team,
    alive: p.alive,
    deathReason: p.deathReason
  }));
}

module.exports = {
  ROLES,
  isWolf,
  isEvil,
  shuffle,
  sanitizeRoleDependencies,
  computeRoles,
  alivePlayers,
  initPlayerRuntime,
  freshGameState,
  summarizeSubmission,
  beginNight,
  buildNightPrompt,
  applyInspect,
  applyNightSubmission,
  resolveNight,
  checkWin,
  buildVotePrompt,
  applyVoteSubmission,
  resolveVotes,
  buildFinalRoles
};
