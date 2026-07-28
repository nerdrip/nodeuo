// Item catalogue registry — kept separate from the loader to avoid a
// circular dependency with `./index.js`.
//
// Canonical identity model:
//   definitionId  stable gameplay/content identity (string)
//   artId          UO static-art graphic sent to the client (number)
//   serial         runtime instance identity (allocated by World)
//
// Legacy content used numeric `id` as the graphic and optional `tagId` as
// the real identity. registerItem() normalises both formats, so old scripts
// keep working while new definitions cannot confuse identity with artwork.

/** Latest definition per stable gameplay identity. */
const byDefinition = new Map();
/** Last registered definition per UO art id (legacy numeric lookup). */
const byArt = new Map();
/** Optional legacy/content aliases. */
const byTag = new Map();
/** Every distinct gameplay definition sharing an art id. */
const byArtAll = new Map();

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function artIdOf(def) {
  const value = def?.artId ?? def?.itemId ?? (typeof def?.id === 'number' ? def.id : undefined);
  const artId = Number(value);
  if (!Number.isInteger(artId) || artId < 0 || artId > 0xFFFF) {
    throw new Error(`item definition ${def?.definitionId ?? def?.tagId ?? def?.id ?? def?.name ?? '<unknown>'} missing valid artId`);
  }
  return artId;
}

function definitionIdOf(def, artId) {
  const explicit = def?.definitionId
    ?? (typeof def?.id === 'string' ? def.id : null)
    ?? def?.tagId
    ?? def?.servuoClass;
  if (explicit != null && String(explicit).trim()) return String(explicit).trim();
  const label = slug(def?.name ?? def?.title ?? def?.label);
  return label ? `${label}@${artId.toString(16)}` : `art:${artId.toString(16)}`;
}

/**
 * Register either a canonical `{ definitionId, artId, name, hue, script }`
 * row or a legacy `{ id:<art>, tagId, name }` row. Returns the normalised
 * definition so loaders and tests can inspect the unambiguous shape.
 */
export function registerItem(def) {
  if (!def || typeof def !== 'object') throw new Error('item definition must be an object');
  const artId = artIdOf(def);
  const definitionId = definitionIdOf(def, artId);
  const normalized = {
    ...def,
    id: definitionId,
    definitionId,
    artId,
    // itemId remains a read-only-by-convention compatibility alias for code
    // that deals with the UO wire graphic. New content should use artId.
    itemId: artId,
  };

  const previous = byDefinition.get(definitionId);
  if (previous) {
    const oldList = byArtAll.get(previous.artId);
    if (oldList) {
      const next = oldList.filter((entry) => entry.definitionId !== definitionId);
      if (next.length) byArtAll.set(previous.artId, next);
      else byArtAll.delete(previous.artId);
      if (byArt.get(previous.artId)?.definitionId === definitionId) {
        if (next.length) byArt.set(previous.artId, next.at(-1));
        else byArt.delete(previous.artId);
      }
    }
  }

  byDefinition.set(definitionId, normalized);
  byArt.set(artId, normalized);
  if (def.tagId) byTag.set(String(def.tagId), normalized);
  byTag.set(definitionId, normalized);
  const list = byArtAll.get(artId) ?? [];
  list.push(normalized);
  byArtAll.set(artId, list);
  return normalized;
}

/** String lookup means definition identity; numeric lookup means legacy art. */
export function getItem(id) {
  return typeof id === 'string' ? (byDefinition.get(id) ?? byTag.get(id)) : byArt.get(Number(id));
}
export function getItemByDefinition(id) { return byDefinition.get(String(id)); }
export function getItemByTag(tag) { return byTag.get(String(tag)); }
export function itemVariants(artId) { return byArtAll.get(Number(artId)) ?? []; }
export function itemsOfKind(kind) {
  return Array.from(byDefinition.values()).filter((item) => item.kind === kind);
}
