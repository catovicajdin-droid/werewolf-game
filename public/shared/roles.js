(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ROLES = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    // VILLAGE ALIGNED
    villager: { name: 'Villager', team: 'village', stackable: true, desc: 'Standard villager with no special night abilities.' },
    seer: { name: 'Seer', team: 'village', stackable: false, desc: 'Each night, investigate a player to uncover their exact secret role.' },
    doctor: { name: 'Doctor', team: 'village', stackable: false, desc: 'Each night, protect a player from werewolf elimination.' },
    witch: { name: 'Witch', team: 'village', stackable: false, desc: 'Has 1 heal potion (shields entire village for the turn) and 1 poison potion for the game.' },
    avenger: { name: 'Avenger', team: 'village', stackable: false, desc: 'Each night, choose who you drag down with you if you are eliminated.' },
    seer_apprentice: { name: 'Seer apprentice', team: 'village', stackable: false, desc: 'Takes over as active Seer only after the original Seer dies.' },
    pacifist: { name: 'Pacifist', team: 'village', stackable: false, desc: 'Once per game at night, choose a player to reveal their role to the town and cancel daytime voting for tomorrow.' },
    priest: { name: 'Priest', team: 'village', stackable: false, desc: 'Once per game, splash holy water: if target is werewolf they die, otherwise you die.' },
    mayor: { name: 'Mayor', team: 'village', stackable: false, desc: 'Once revealed, your daytime vote counts as 2.' },
    bodyguard: { name: 'Bodyguard', team: 'village', stackable: false, desc: 'Protect one player each night. If attacked by wolves, you die in their place.' },
    detective: { name: 'Detective', team: 'village', stackable: false, desc: 'Each night, pick two players to see if they belong to the same team.' },
    wise_man: { name: 'Wise man', team: 'village', stackable: false, desc: 'Cannot be killed by werewolves during the night.' },
    aura_seer: { name: 'Aura seer', team: 'village', stackable: false, desc: 'Each night, inspect a player to see if they have a Good or Evil aura.' },
    handsome_prince: { name: 'Handsome prince', team: 'village', stackable: false, desc: 'The first time the village attempts to lynch you, you reveal your role and survive.' },
    sibling: { name: 'Sibling', team: 'village', stackable: true, desc: 'Knows the identities of other living Siblings.' },
    naughty_boy: { name: 'Naughty boy', team: 'village', stackable: false, desc: 'Once per game, swap the roles of two living players at night.' },
    red_lady: { name: 'Red lady', team: 'village', stackable: false, desc: 'Visit a player at night. If they are a werewolf or killed by one, you die. If wolves attack your empty bed, you survive.' },
    grumpy_grandma: { name: 'Grumpy grandma', team: 'village', stackable: false, desc: 'Each night, silence one player from voting during the following day.' },
    drunk: { name: 'Drunk', team: 'village', stackable: false, desc: 'Constantly drunk and may not speak during discussions.' },
    idiot: { name: 'Idiot', team: 'village', stackable: false, desc: 'If lynched by the village, you survive but permanently lose voting rights.' },
    gunner: { name: 'Gunner', team: 'village', stackable: false, desc: 'Holds 2 bullets. Can shoot someone by day; role is revealed upon first shot.' },
    vigilante: { name: 'Vigilante', team: 'village', stackable: false, desc: 'Has 1 bullet to kill, or can choose to inspect a role which disables voting that round.' },
    marksman: { name: 'Marksman', team: 'village', stackable: false, desc: 'Marks target at night; next day can execute. If target is innocent villager, marksman dies.' },
    beast_hunter: { name: 'Beast Hunter', team: 'village', stackable: false, desc: 'Places a delayed trap. If attacked by wolves the next night, the weakest wolf dies instead.' },
    tough_guy: { name: 'Tough guy', team: 'village', stackable: false, desc: 'If attacked at night, survives the night and dies at the end of the next day.' },
    mad_scientist: { name: 'Mad scientist', team: 'village', stackable: false, desc: 'When you die, your chemical explosion eliminates the adjacent seated players.' },
    medium: { name: 'Medium', team: 'village', stackable: false, desc: 'Once per game, revive one eliminated player back to life.' },
    president: { name: 'President', team: 'village', stackable: false, desc: 'Publicly known president. If the president dies, the entire village immediately loses.' },

    // WEREWOLF ALIGNED
    werewolf: { name: 'Werewolf', team: 'wolf', stackable: true, desc: 'Picks a victim together with fellow wolves each night.' },
    junior_werewolf: { name: 'Junior werewolf', team: 'wolf', stackable: false, desc: 'Selects a player at night to drag down if you are killed.' },
    lone_wolf: { name: 'Lone wolf', team: 'wolf', stackable: false, desc: 'Regular werewolf, but only wins if they are the last surviving werewolf.' },
    cursed_human: { name: 'Cursed Human', team: 'wolf', stackable: false, desc: 'Villager until attacked by werewolves, then converts into a full werewolf.' },
    kitten_wolf: { name: 'Kitten wolf', team: 'wolf', stackable: false, desc: 'Once per game, can bite a player to convert them into a werewolf instead of killing.' },
    sorcerer: { name: 'Sorcerer', team: 'wolf', stackable: false, desc: 'Each night, checks one player to see if they are the Seer or a Werewolf.' },
    wolf_seer: { name: 'Wolf seer', team: 'wolf', stackable: false, desc: 'Each night discovers exact role of a player. Becomes regular wolf if last wolf alive.' },
    alpha_werewolf: { name: 'Alpha Werewolf', team: 'wolf', stackable: false, desc: 'Regular werewolf whose vote counts as 2 during night selection.' },
    shadow_werewolf: { name: 'Shadow Werewolf', team: 'wolf', stackable: false, desc: 'Once per game, doubles wolf votes and obscures votes during daytime.' },
    nightmare_werewolf: { name: 'Nightmare Werewolf', team: 'wolf', stackable: false, desc: 'Twice per game, puts a player to sleep, disabling their abilities for the night.' },

    // SOLO / NEUTRAL
    fool: { name: 'Fool', team: 'solo', stackable: false, desc: 'Wins solely by getting lynched by the village during the day.' },
    headhunter: { name: 'Headhunter', team: 'solo', stackable: false, desc: 'Assigned a secret target. Wins if target gets lynched by the village.' },
    serial_killer: { name: 'Serial killer', team: 'solo', stackable: false, desc: 'Kills one player each night. Wins if last person standing.' },
    arsonist: { name: 'Arsonist', team: 'solo', stackable: false, desc: 'Douses 2 players per night or ignites all doused. Immune to wolf attacks. Wins if last alive.' },
    sect_leader: { name: 'Sect leader', team: 'solo', stackable: false, desc: 'Converts one player each night. Wins when all living players are in the sect.' },
    sect_hunter: { name: 'Sect hunter', team: 'village', stackable: false, desc: 'Selects a player each night; if they are Sect Leader or in the sect, they die.' },
    grave_robber: { name: 'Grave robber', team: 'solo', stackable: false, desc: 'Selects target on Night 1. If target dies, takes their role.' },
    cupid: { name: 'Cupid', team: 'solo', stackable: false, desc: 'On Night 1 binds two lovers. Lovers win if they are the final couple standing.' }
  };
});
