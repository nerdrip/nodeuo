// Tokuno Minor Artifacts — ServUO `Engines/TreasuresOfTokuno`.
//
// Drop pool: 20+ named items, mostly cosmetic / minor-stat. Awarded
// as loot from Tokuno-tier mobs (Yomotsu, Lady of the Snow, Oni,
// Ronin captains). Each drop rolls 1-of-N from the table. The
// `tokunoArtifact` flag on the item signals to OPL renderers to
// add "Tokuno Minor Artifact" suffix.
//
// We register the items via the `registerItem` content registry so
// they show up in `[items add` admin command and the loot.js artifact
// pool can reference them by `kind`.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

const TOKUNO = [
  { tagId: 'tokuno-lesser-pigments',         itemId: 0x4007, hue: 0,      name: 'lesser pigments of Tokuno' },
  { tagId: 'tokuno-greater-pigments',        itemId: 0x4007, hue: 0x47E,  name: 'greater pigments of Tokuno' },
  { tagId: 'tokuno-daimyos-helm',            itemId: 0x2772, hue: 0x97B,  name: "Daimyo's helm" },
  { tagId: 'tokuno-arms-of-tactics',         itemId: 0x2776, hue: 0x963,  name: 'arms of tactics' },
  { tagId: 'tokuno-honored-blade',           itemId: 0x27A2, hue: 0x973,  name: 'honored blade' },
  { tagId: 'tokuno-blade-of-righteous',      itemId: 0x27A4, hue: 0x47E,  name: 'blade of the righteous' },
  { tagId: 'tokuno-tome-of-vengeance',       itemId: 0x14F0, hue: 0x033,  name: 'tome of lost wisdom' },
  { tagId: 'tokuno-ringmail-of-cosmic',      itemId: 0x13EE, hue: 0x481,  name: 'ringmail of the cosmic warrior' },
  { tagId: 'tokuno-sun-bracers',             itemId: 0x108A, hue: 0x554,  name: 'sun bracers' },
  { tagId: 'tokuno-spell-cycler',            itemId: 0x108A, hue: 0x489,  name: 'spell cycler' },
  { tagId: 'tokuno-darkened-sky',            itemId: 0x27A2, hue: 0x504,  name: 'darkened sky' },
  { tagId: 'tokuno-stormgale',               itemId: 0x27A2, hue: 0x47E,  name: 'stormgale' },
  { tagId: 'tokuno-pillar-of-strength',      itemId: 0x108A, hue: 0x4F4,  name: 'pillar of strength' },
  { tagId: 'tokuno-tome-of-enlightenment',   itemId: 0x14F0, hue: 0x481,  name: 'tome of enlightenment' },
  { tagId: 'tokuno-rune-beetle-carapace',    itemId: 0x1B72, hue: 0x489,  name: 'rune beetle carapace' },
  { tagId: 'tokuno-kasa-of-rajin',           itemId: 0x2772, hue: 0x4F2,  name: 'kasa of the rajin' },
  { tagId: 'tokuno-stormgrip',               itemId: 0x108A, hue: 0x554,  name: 'stormgrip' },
];

for (const def of TOKUNO) {
  __PENDING__.push({
    kind: 'artifact',
    category: 'tokuno-minor',
    layer: 0,
    weight: 5,
    tokunoArtifact: true,
    ...def,
  });
}

export const TOKUNO_ARTIFACT_TAGS = TOKUNO.map((t) => t.tagId);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('tokuno-artifacts: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('tokuno-artifacts: ' + e.message); } }
  api.log?.('tokuno-artifacts: registered ' + count + ' items');
  // Push tag list to the rotation system. ServUO `TreasuresOfTokunoEra`
  // shuffles the pool every 90 days; engine needs the tag array.
  try { api.systems?.treasuresOfTokuno?.setArtifactTags?.(TOKUNO_ARTIFACT_TAGS); }
  catch { /* engine optional */ }
  return () => {};
}