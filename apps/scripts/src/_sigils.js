export function sigilsSystem(api) {
  return api?.systems?.sigils ?? api?.sigils ?? null;
}

export function isSigilCarrier(api, serial) {
  const fn = sigilsSystem(api)?.isSigilCarrier;
  return typeof fn === 'function' ? !!fn(serial >>> 0) : false;
}

export function pickupSigil(api, town, serial) {
  const fn = sigilsSystem(api)?.pickup;
  return typeof fn === 'function'
    ? fn(town, serial >>> 0)
    : { ok: false, reason: 'sigils system unavailable' };
}

export function dropSigil(api, town, serial) {
  const fn = sigilsSystem(api)?.drop;
  return typeof fn === 'function' ? fn(town, serial >>> 0) : null;
}

export function listSigils(api) {
  const fn = sigilsSystem(api)?.listSigils;
  return typeof fn === 'function' ? fn() : [];
}

export function registerSigil(api, town, x, y, map) {
  const fn = sigilsSystem(api)?.registerSigil;
  if (typeof fn !== 'function') throw new Error('sigils system unavailable');
  return fn(town, x, y, map);
}

export function getSigil(api, town) {
  const fn = sigilsSystem(api)?.getSigil;
  return typeof fn === 'function' ? fn(town) : null;
}

export function resetSigils(api) {
  const fn = sigilsSystem(api)?.resetSigils;
  return typeof fn === 'function' ? fn() : { removed: 0 };
}
