export function system(api, name) {
  return api?.systems?.[name] ?? api?.[name] ?? null;
}

export function requireSystem(api, name) {
  const value = system(api, name);
  if (!value) throw new Error(`${name} system unavailable`);
  return value;
}
