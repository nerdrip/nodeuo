export function questsSystem(api) {
  return api?.systems?.quests ?? api?.quests ?? null;
}

export function requireQuests(api) {
  const quests = questsSystem(api);
  if (!quests) throw new Error('quests system unavailable');
  return quests;
}
