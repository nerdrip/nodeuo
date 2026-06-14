// Stygian Abyss Artifacts — ServUO `Engines/SAArtifacts/`.
//
// Drop pool from SA / abyss-tier bosses (Stygian Dragon, Primeval Lich,
// Slasher of Veils, Medusa, etc.). 15-ish items with strong stats —
// usually drop from peerless / boss timer encounters.
//
// Like Tokuno, we register via the content registry; `saArtifact: true`
// flag drives OPL "Stygian Abyss Artifact" suffix.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

const SA = [
  { tagId: 'sa-slither',           itemId: 0x1711, hue: 0x21B, name: 'slither' },
  { tagId: 'sa-petrified-snake',   itemId: 0x1086, hue: 0x52D, name: 'petrified snake' },
  { tagId: 'sa-crimson-cincture',  itemId: 0x1086, hue: 0x0485, name: 'crimson cincture' },
  { tagId: 'sa-hawkwinds-robe',    itemId: 0x1F03, hue: 0x4F4, name: "Hawkwind's robe" },
  { tagId: 'sa-mace-shield-glasses', itemId: 0x2FB7, hue: 0x973, name: 'mace and shield glasses' },
  { tagId: 'sa-tangle',            itemId: 0x108A, hue: 0x489, name: 'tangle' },
  { tagId: 'sa-boomstick',         itemId: 0x27A2, hue: 0x49D, name: 'Boomstick' },
  { tagId: 'sa-shroud-of-condemned', itemId: 0x1F03, hue: 0x455, name: 'shroud of the condemned' },
  { tagId: 'sa-jumus-sacred-hide', itemId: 0x13EE, hue: 0x4FD, name: "Jumu's sacred hide" },
  { tagId: 'sa-pacific-wand',      itemId: 0x0DF5, hue: 0x47E, name: 'pacific wand' },
  { tagId: 'sa-summoners-kilt',    itemId: 0x1539, hue: 0x21A, name: "summoner's kilt" },
  { tagId: 'sa-ancient-shield',    itemId: 0x1B76, hue: 0x504, name: 'ancient shield' },
  { tagId: 'sa-staff-of-the-magi', itemId: 0x13F8, hue: 0x47F, name: 'staff of the magi' },
  { tagId: 'sa-tongue-of-the-beast', itemId: 0x27A4, hue: 0x488, name: 'tongue of the beast' },
  { tagId: 'sa-mantle-of-the-fallen', itemId: 0x1F00, hue: 0x44E, name: 'mantle of the fallen' },
];

for (const def of SA) {
  __PENDING__.push({
    kind: 'artifact',
    category: 'sa',
    layer: 0,
    weight: 6,
    saArtifact: true,
    ...def,
  });
}

export const SA_ARTIFACT_TAGS = SA.map((s) => s.tagId);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('sa-artifacts: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('sa-artifacts: ' + e.message); } }
  api.log?.('sa-artifacts: registered ' + count + ' items');
  return () => {};
}