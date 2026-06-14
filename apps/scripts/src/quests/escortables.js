// Escortables catalog — ServUO `Quests/Escortables.cs` + `EscortToDugan.cs`.
// Registers a default pool of escort quests that any matching NPC can offer.
// Faza F.1.4.
//
// Each escort:
//   • NPC asks to be taken from `fromRegion` to `toRegion`.
//   • Quest is registered via `api.mlQuests.registerEscort`.
//   • The `trackEscortArrive(mob, region)` hook in mlquests.js auto-
//     completes the quest when player + NPC are both in `toRegion`.
//
// Escortables here represent the standard ServUO mainland pool; servers
// can extend by importing the helper directly.

const ESCORTS = [
  // Stygian Abyss: Neville Brightwhistle must reach Elder Dugan's camp.
  {
    id: 'escort-to-dugan',
    title: 'The Lost Brightwhistle',
    npcKind: 'neville-brightwhistle',
    fromRegion: 'underworld-goblin-halls',
    toRegion: 'npc-encampment',
    rewards: [
      { type: 'fame', amount: 500 },
      { type: 'item', itemType: 'talisman-of-goblin-slaying', amount: 1 },
    ],
  },
  // Pilgrim from Yew → Britain (ServUO ALittleSomething/Escortables pool).
  { id: 'escort-yew-to-britain', npcKind: 'pilgrim', fromRegion: 'yew', toRegion: 'britain' },
  // Noble from Trinsic → Britain.
  { id: 'escort-trinsic-to-britain', npcKind: 'noble', fromRegion: 'trinsic', toRegion: 'britain' },
  // Sailor from Britain → Vesper.
  { id: 'escort-britain-to-vesper', npcKind: 'sailor', fromRegion: 'britain', toRegion: 'vesper' },
  // Merchant from Skara Brae → Britain.
  { id: 'escort-skara-to-britain', npcKind: 'merchant', fromRegion: 'skara-brae', toRegion: 'britain' },
  // Ranger from Minoc → Yew (forest path).
  { id: 'escort-minoc-to-yew', npcKind: 'ranger', fromRegion: 'minoc', toRegion: 'yew' },
];

export default function register(api) {
  const ml = api?.mlQuests ?? api?.systems?.mlQuests;
  const registerEscort = ml?.registerEscort;
  if (!registerEscort) {
    api?.log?.('quests/escortables: api.mlQuests.registerEscort unavailable; skipping');
    return () => {};
  }
  const registered = [];
  for (const e of ESCORTS) {
    try {
      registerEscort({
        id: e.id,
        title: e.title ?? `Escort ${e.npcKind} to ${e.toRegion}`,
        npcKind: e.npcKind,
        fromRegion: e.fromRegion,
        toRegion: e.toRegion,
        goldReward: e.goldReward ?? (e.rewards ? 0 : 500 + Math.round(Math.random() * 250)),
        fameReward: e.fameReward ?? (e.rewards ? 0 : 250),
        rewards: e.rewards,
      });
      registered.push(e.id);
    } catch (err) {
      api?.log?.(`quests/escortables: ${e.id} ${err.message}`);
    }
  }
  api?.log?.(`quests/escortables: registered ${registered.length}/${ESCORTS.length}`);
  // No teardown — quest registry is process-wide and idempotent.
  return () => {};
}
