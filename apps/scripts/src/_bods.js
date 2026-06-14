export function bodsSystem(api) {
  return api?.systems?.bods ?? api?.bods ?? null;
}

export function requireBods(api) {
  const bods = bodsSystem(api);
  if (!bods) throw new Error('BOD system unavailable');
  return bods;
}
