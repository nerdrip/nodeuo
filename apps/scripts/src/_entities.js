function serialOf(value) {
  return typeof value === 'number' ? value >>> 0 : value?.serial >>> 0;
}

function worldOf(apiOrWorld) {
  if (apiOrWorld?.[Symbol.for('uo.world')]) return apiOrWorld;
  return apiOrWorld?.world ?? apiOrWorld;
}

function apiOf(apiOrWorld) {
  const world = worldOf(apiOrWorld);
  if (apiOrWorld?.world || apiOrWorld?.game || apiOrWorld?.query) {
    return {
      ...apiOrWorld,
      game: apiOrWorld.game ?? world?._scriptGame,
      query: apiOrWorld.query ?? world?._scriptQuery,
    };
  }
  if (world?._scriptGame || world?._scriptQuery) {
    return {
      world,
      game: world._scriptGame,
      query: world._scriptQuery,
    };
  }
  return null;
}

export function mobileBySerial(apiOrWorld, serialOrMobile) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.mobileBySerial) return api.game.mobileBySerial(serialOrMobile);
  if (api?.query?.mobileBySerial) return api.query.mobileBySerial(serialOrMobile);
  const serial = serialOf(serialOrMobile);
  return serial ? (world?.mobiles?.get?.(serial) ?? null) : null;
}

export function itemBySerial(apiOrWorld, serialOrItem) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.itemBySerial) return api.game.itemBySerial(serialOrItem);
  if (api?.query?.itemBySerial) return api.query.itemBySerial(serialOrItem);
  const serial = serialOf(serialOrItem);
  return serial ? (world?.items?.get?.(serial) ?? null) : null;
}

export function entityBySerial(apiOrWorld, serialOrEntity) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.entityBySerial) return api.game.entityBySerial(serialOrEntity);
  if (api?.query?.entityBySerial) return api.query.entityBySerial(serialOrEntity);
  const serial = serialOf(serialOrEntity);
  if (!serial) return null;
  return world?.mobiles?.get?.(serial) ?? world?.items?.get?.(serial) ?? null;
}
