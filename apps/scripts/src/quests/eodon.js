// Eodon — Time of Legends quest chains.
// Port of ServUO `Scripts/Quests/Eodon/*` (TimeOfLegends ML expansion).
//
// Eodon was a 12-chain expansion covering tribes (Barako, Sakkhra,
// Urali, Kurak, Tiger Island, Kahn, Jukari) plus the central Myrmidex
// invasion. Each chain has 1-3 stages with kill/collect/escort
// objectives, gates the next chain via tribe-loyalty thresholds, and
// rewards minor artifacts (Tiger Pelt Headdress, Carved Tribal Spear,
// Lure of Vanquished Foes) and Time of Legends faction reputation.
//
// We seed ALL 12 chains as data-driven quest defs so the existing
// `quest-conversation` / `quests.js` runtime can resolve them by id.
// Tribe loyalty is a Map<tribe, points> on `mob._eodonLoyalty`.

const TRIBES = ['barako', 'sakkhra', 'urali', 'kurak', 'tiger-island',
                'kahn', 'jukari', 'myrmidex'];

const CHAINS = [
  // ----- Barako Tribe (intro) -----
  {
    id: 'eodon-barako-intro',
    tribe: 'barako',
    title: 'Tribute to the Chieftain',
    summary: 'Chief Maklak demands you prove worth: slay 6 Saurosaurus.',
    objectives: [{ kind: 'slay', target: 'saurosaurus', count: 6 }],
    reward: { gold: 1500, loyalty: 250, items: ['barako-feather-charm'] },
  },
  {
    id: 'eodon-barako-pelts',
    tribe: 'barako',
    title: 'Pelts of the Tiger',
    summary: 'Gather 5 Dimetrosaur pelts for the village shamans.',
    objectives: [{ kind: 'collect', resource: 'dimetrosaur-pelt', count: 5 }],
    reward: { gold: 2500, loyalty: 400 },
    prereq: 'eodon-barako-intro',
  },

  // ----- Sakkhra Tribe -----
  {
    id: 'eodon-sakkhra-purge',
    tribe: 'sakkhra',
    title: 'Cleansing the Hollow',
    summary: 'Drive 8 corrupted Wyrm-Spawn from the Sakkhra hollow.',
    objectives: [{ kind: 'slay', target: 'wyrm-spawn', count: 8 }],
    reward: { gold: 2000, loyalty: 350 },
  },

  // ----- Urali Tribe -----
  {
    id: 'eodon-urali-escort',
    tribe: 'urali',
    title: 'Escort the Surveyor',
    summary: 'Escort the Urali surveyor from the river to the high ridge.',
    objectives: [{ kind: 'escort', fromRegion: 'eodon-river', toRegion: 'eodon-ridge' }],
    reward: { gold: 1800, loyalty: 300, fame: 500 },
  },

  // ----- Kurak Tribe (combat focus) -----
  {
    id: 'eodon-kurak-warband',
    tribe: 'kurak',
    title: 'Break the Warband',
    summary: 'Defeat 10 Kotl War Sentinels at the western glade.',
    objectives: [{ kind: 'slay', target: 'kotl-sentinel', count: 10 }],
    reward: { gold: 3000, loyalty: 500, items: ['kurak-stone-club'] },
  },

  // ----- Tiger Island -----
  {
    id: 'eodon-tiger-feast',
    tribe: 'tiger-island',
    title: 'Feast of the Hunt',
    summary: 'Bring 4 fresh Infernal Boar carcasses to the village.',
    objectives: [{ kind: 'collect', resource: 'infernal-boar-meat', count: 4 }],
    reward: { gold: 1200, loyalty: 200 },
  },

  // ----- Kahn / Jukari -----
  {
    id: 'eodon-kahn-poison',
    tribe: 'kahn',
    title: 'The Antidote',
    summary: 'Gather 3 Khaldun Lotus blooms for the Kahn alchemist.',
    objectives: [{ kind: 'collect', resource: 'khaldun-lotus', count: 3 }],
    reward: { gold: 1500, loyalty: 250, items: ['lesser-cure-flask'] },
  },
  {
    id: 'eodon-jukari-rite',
    tribe: 'jukari',
    title: 'Rite of Endurance',
    summary: 'Survive 10 minutes within the Jukari trial circle.',
    objectives: [{ kind: 'visit', region: 'eodon-jukari-circle', durationMs: 600_000 }],
    reward: { gold: 2200, loyalty: 350, fame: 750 },
  },

  // ----- Myrmidex (capstone) -----
  {
    id: 'eodon-myrmidex-scouts',
    tribe: 'myrmidex',
    title: 'Scouts of the Hive',
    summary: 'Eliminate 15 Myrmidex Workers near the dig.',
    objectives: [{ kind: 'slay', target: 'myrmidex-worker', count: 15 }],
    reward: { gold: 3500, loyalty: 600, items: ['myrmidex-mandible'] },
  },
  {
    id: 'eodon-myrmidex-queen',
    tribe: 'myrmidex',
    title: 'The Buried Queen',
    summary: 'With all 7 tribes allied, slay the Myrmidex Queen.',
    objectives: [{ kind: 'slay', target: 'myrmidex-queen', count: 1 }],
    reward: { gold: 25_000, loyalty: 2000, items: ['queen-mandible-greater'], fame: 5000 },
    prereq: 'eodon-myrmidex-scouts',
    requiresAllTribes: true,
  },

  // ----- Cross-tribe minor -----
  {
    id: 'eodon-glade-cleanup',
    tribe: 'tiger-island',
    title: 'Glade Cleanup',
    summary: 'Burn 5 corrupted Eodon vines (use a torch).',
    objectives: [{ kind: 'use', target: 'eodon-corrupt-vine', count: 5 }],
    reward: { gold: 800, loyalty: 100 },
  },

  // ============================================================
  // Batch 2 — extended chains per tribe (3-5 each)
  // ============================================================

  // ----- Barako extended -----
  { id: 'eodon-barako-rite', tribe: 'barako', title: 'Rite of the Warrior',
    summary: 'Bring 3 wyvern feathers from the Barako cliffs.',
    objectives: [{ kind: 'collect', resource: 'wyvern-feather', count: 3 }],
    reward: { gold: 1800, loyalty: 300 }, prereq: 'eodon-barako-pelts' },
  { id: 'eodon-barako-shaman', tribe: 'barako', title: 'Shaman\'s Errand',
    summary: 'Speak to Shaman Ralka and slay 4 saurosaur shamans.',
    objectives: [{ kind: 'slay', target: 'saurosaur-shaman', count: 4 }],
    reward: { gold: 2000, loyalty: 350, items: ['barako-totem'] } },

  // ----- Sakkhra extended -----
  { id: 'eodon-sakkhra-coil', tribe: 'sakkhra', title: 'The Coiled Path',
    summary: 'Collect 4 Sakkhra scales from molting serpents.',
    objectives: [{ kind: 'collect', resource: 'sakkhra-scale', count: 4 }],
    reward: { gold: 1600, loyalty: 250, items: ['sakkhra-coil-ring'] } },
  { id: 'eodon-sakkhra-fang', tribe: 'sakkhra', title: 'Fang of the Serpent',
    summary: 'Slay the giant Sakkhra Matriarch.',
    objectives: [{ kind: 'slay', target: 'sakkhra-matriarch', count: 1 }],
    reward: { gold: 4500, loyalty: 600, items: ['sakkhra-fang-dagger'] },
    prereq: 'eodon-sakkhra-coil' },

  // ----- Urali extended -----
  { id: 'eodon-urali-survey', tribe: 'urali', title: 'The Long Survey',
    summary: 'Plant 5 survey rods at marked ridges across Eodon.',
    objectives: [{ kind: 'use', target: 'survey-rod', count: 5 }],
    reward: { gold: 1500, loyalty: 200, items: ['urali-survey-rod'] } },
  { id: 'eodon-urali-banishment', tribe: 'urali', title: 'Banishment of the Beast',
    summary: 'Defeat 3 Eodon Drakes terrorizing the Urali trade route.',
    objectives: [{ kind: 'slay', target: 'eodon-drake', count: 3 }],
    reward: { gold: 3000, loyalty: 450 }, prereq: 'eodon-urali-survey' },

  // ----- Kurak extended -----
  { id: 'eodon-kurak-icon', tribe: 'kurak', title: 'Icon of the Stone',
    summary: 'Retrieve the Stone Icon from the Kotl ruin.',
    objectives: [{ kind: 'collect', resource: 'stone-icon', count: 1 }],
    reward: { gold: 2500, loyalty: 400, items: ['kurak-warband-banner'] } },

  // ----- Tiger Island extended -----
  { id: 'eodon-tiger-pelt-master', tribe: 'tiger-island', title: 'Master of Pelts',
    summary: 'Skin 8 saber-toothed tigers and bring the pelts to the elder.',
    objectives: [{ kind: 'collect', resource: 'saber-tooth-pelt', count: 8 }],
    reward: { gold: 3200, loyalty: 500, items: ['tiger-pelt-headdress'] } },
  { id: 'eodon-tiger-spearmaster', tribe: 'tiger-island', title: 'The Spearmaster',
    summary: 'Craft a tribal spear at the tiger-island forge.',
    objectives: [{ kind: 'craft', target: 'tribal-spear', count: 1 }],
    reward: { gold: 1800, loyalty: 300, items: ['carved-tribal-spear'] } },

  // ----- Kahn extended -----
  { id: 'eodon-kahn-cure', tribe: 'kahn', title: 'The Universal Cure',
    summary: 'Distill 3 Lesser Cure Flasks from Khaldun Lotus.',
    objectives: [{ kind: 'craft', target: 'lesser-cure-flask', count: 3 }],
    reward: { gold: 2000, loyalty: 350, items: ['kahn-poison-vial'] } },

  // ----- Jukari extended -----
  { id: 'eodon-jukari-master', tribe: 'jukari', title: 'Master of Endurance',
    summary: 'Defeat 5 Jukari trial-warriors in single combat.',
    objectives: [{ kind: 'slay', target: 'jukari-warrior', count: 5 }],
    reward: { gold: 3500, loyalty: 500, items: ['jukari-endurance-band'] },
    prereq: 'eodon-jukari-rite' },

  // ----- Myrmidex extended -----
  { id: 'eodon-myrmidex-warriors', tribe: 'myrmidex', title: 'Warriors of the Hive',
    summary: 'Slay 8 Myrmidex Warriors and 4 Larvae.',
    objectives: [{ kind: 'slay', target: 'myrmidex-warrior', count: 8 }],
    reward: { gold: 4000, loyalty: 700 }, prereq: 'eodon-myrmidex-scouts' },
  { id: 'eodon-myrmidex-vault', tribe: 'myrmidex', title: 'Vault of the Hive',
    summary: 'Recover the Vault Key from the Myrmidex sub-queen.',
    objectives: [{ kind: 'collect', resource: 'myrmidex-vault-key', count: 1 }],
    reward: { gold: 6000, loyalty: 1000, items: ['lure-of-vanquished'] },
    prereq: 'eodon-myrmidex-warriors' },

  // ----- Cross-tribe meta -----
  { id: 'eodon-tribal-summit', tribe: 'barako', title: 'Tribal Summit',
    summary: 'Reach 300 loyalty with at least 4 different tribes.',
    objectives: [{ kind: 'special', target: 'tribal-summit', count: 1 }],
    reward: { gold: 5000, loyalty: 0, items: ['pillar-of-strength'], fame: 2500 } },
  { id: 'eodon-volcano', tribe: 'tiger-island', title: 'The Eodon Volcano',
    summary: 'Reach the Eodon Volcano caldera and slay the Lava Bird.',
    objectives: [{ kind: 'slay', target: 'eodon-lava-bird', count: 1 }],
    reward: { gold: 4000, loyalty: 600, items: ['barako-feather-charm'] } },
];

export default function register(api) {
  if (!api.commands) return () => {};

  function loyalty(mob, tribe = null) {
    if (!mob._eodonLoyalty) mob._eodonLoyalty = {};
    if (tribe == null) return mob._eodonLoyalty;
    return mob._eodonLoyalty[tribe] ?? 0;
  }
  function addLoyalty(mob, tribe, amt) {
    if (!mob._eodonLoyalty) mob._eodonLoyalty = {};
    mob._eodonLoyalty[tribe] = (mob._eodonLoyalty[tribe] ?? 0) + amt;
  }
  function activeChain(mob, id) {
    mob._eodonQuests ??= {};
    return mob._eodonQuests[id];
  }
  api.commands.register({
    name: 'eodon',
    help: '[eodon — list Eodon chains or progress.',
    access: 'Player',
    run(ctx) {
      const lines = ['Eodon Time of Legends:'];
      for (const t of TRIBES) {
        const lp = loyalty(ctx.sender, t);
        lines.push(`  ${t}: loyalty ${lp}`);
      }
      lines.push('Use [eodon-accept <id> and [eodon-status <id>.');
      for (const ln of lines) ctx.state.sendSystemMessage(ln);
    },
  });

  api.commands.register({
    name: 'eodon-accept',
    help: '[eodon-accept <chain-id>',
    access: 'Player',
    run(ctx, args) {
      const id = args?.[0];
      const def = CHAINS.find((c) => c.id === id);
      if (!def) { ctx.state.sendSystemMessage('Unknown Eodon chain id.'); return; }
      if (def.prereq && !ctx.sender._eodonQuests?.[def.prereq]?.completed) {
        ctx.state.sendSystemMessage(`Requires completion of: ${def.prereq}.`);
        return;
      }
      if (def.requiresAllTribes) {
        const all = TRIBES.filter((t) => t !== 'myrmidex')
          .every((t) => loyalty(ctx.sender, t) >= 500);
        if (!all) { ctx.state.sendSystemMessage('All 7 tribes must reach 500 loyalty.'); return; }
      }
      ctx.sender._eodonQuests ??= {};
      if (ctx.sender._eodonQuests[id]) {
        ctx.state.sendSystemMessage('Already active or completed.');
        return;
      }
      ctx.sender._eodonQuests[id] = {
        progress: 0, completed: false, startedAt: Date.now(),
      };
      ctx.state.sendSystemMessage(`Accepted: ${def.title}`);
      ctx.state.sendSystemMessage(def.summary);
    },
  });

  api.commands.register({
    name: 'eodon-status',
    help: '[eodon-status <chain-id>',
    access: 'Player',
    run(ctx, args) {
      const id = args?.[0];
      const def = CHAINS.find((c) => c.id === id);
      if (!def) { ctx.state.sendSystemMessage('Unknown chain.'); return; }
      const q = activeChain(ctx.sender, id);
      if (!q) { ctx.state.sendSystemMessage('Not accepted.'); return; }
      ctx.state.sendSystemMessage(`${def.title} — ${q.completed ? 'COMPLETED' : `progress ${q.progress}`}`);
    },
  });

  api.commands.register({
    name: 'eodon-turnin',
    help: '[eodon-turnin <chain-id> — claim reward for completed chain.',
    access: 'Player',
    run(ctx, args) {
      const id = args?.[0];
      const def = CHAINS.find((c) => c.id === id);
      if (!def) { ctx.state.sendSystemMessage('Unknown chain.'); return; }
      const q = activeChain(ctx.sender, id);
      if (!q?.completed) { ctx.state.sendSystemMessage('Objectives incomplete.'); return; }
      if (q.turnedIn) { ctx.state.sendSystemMessage('Already turned in.'); return; }
      const r = def.reward ?? {};
      if (r.gold) ctx.sender.gold = (ctx.sender.gold | 0) + r.gold;
      if (r.fame) ctx.sender.fame = (ctx.sender.fame | 0) + r.fame;
      if (r.loyalty) addLoyalty(ctx.sender, def.tribe, r.loyalty);
      if (Array.isArray(r.items) && api.game?.mobile?.giveItem) {
        if (!api.game.inventory?.findBackpack?.(ctx.sender)) {
          ctx.state.sendSystemMessage('You have no backpack for the reward.');
          return;
        }
        for (const tag of r.items) {
          try {
            // Prefer the real Eodon artifact template if registered.
            const tmpl = api.templates?.getTemplate?.(tag);
            const spawn = tmpl
              ? { itemId: tmpl.itemId, hue: tmpl.hue ?? 0, name: tmpl.label ?? tag }
              : { itemId: 0x1F1C, name: tag };
            api.game.mobile.giveItem(ctx.sender, spawn, { randomGrid: true });
          } catch { /* no pack */ }
        }
      }
      q.turnedIn = true;
      ctx.state.sendSystemMessage(`Reward granted: ${JSON.stringify(r)}`);
    },
  });

  // Admin: manual progress tick for testing.
  api.commands.register({
    name: 'eodon-tick',
    help: '[eodon-tick <chain-id> — admin advance.',
    access: 'Admin',
    run(ctx, args) {
      const id = args?.[0];
      const def = CHAINS.find((c) => c.id === id);
      if (!def) return;
      const q = activeChain(ctx.sender, id);
      if (!q) return;
      const target = def.objectives[0]?.count ?? 1;
      q.progress = Math.min(target, q.progress + 1);
      if (q.progress >= target) q.completed = true;
      ctx.state.sendSystemMessage(`progress=${q.progress}/${target}${q.completed ? ' DONE' : ''}`);
    },
  });

  // Hook the kill chain for slay-objectives. Mob kind comes from
  // either `victim.kind` or `victim.template`; tolerate both.
  api.lifecycle?.event?.(api.events, 'mobile:killed', (ev) => {
    const killer = ev.killer; const victim = ev.victim;
    if (!killer || !victim) return;
    const kind = victim.kind ?? victim.template ?? '';
    for (const def of CHAINS) {
      const q = killer._eodonQuests?.[def.id];
      if (!q || q.completed) continue;
      const obj = def.objectives[0];
      if (obj?.kind !== 'slay' || obj.target !== kind) continue;
      q.progress = Math.min(obj.count, (q.progress | 0) + 1);
      if (q.progress >= obj.count) {
        q.completed = true;
        killer.client?.sendSystemMessage?.(`Eodon: ${def.title} — objectives complete!`);
      }
    }
  });

  return () => {
    for (const n of ['eodon', 'eodon-accept', 'eodon-status', 'eodon-turnin', 'eodon-tick']) {
      api.commands.unregister(n);
    }
  };
}

export { CHAINS as EODON_CHAINS, TRIBES as EODON_TRIBES };
