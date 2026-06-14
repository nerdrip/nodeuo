// Event Log Scroll — double-click pops the last 10 shard events to
// the player as a chat-style summary. ServUO equivalent: NewsBoard /
// TownCryer scroll. Provides a player-facing "what happened recently"
// without requiring chat history scroll-back.

export default function buildEventLogScrollScript(api) {
  return {
    name: 'event-log-scroll',
    onUse(world, item, user) {
      const recent = api?.systems?.shardEvents?.recent?.(10) ?? null;

      if (!recent || recent.length === 0) {
        user?.client?.sendSystemMessage?.('The scroll is blank — no recent shard events.');
        return true;
      }
      user?.client?.sendSystemMessage?.('=== Recent Shard Events ===');
      for (const ev of recent) {
        const ts = new Date(ev.ts).toISOString().slice(11, 19);
        user.client.sendSystemMessage(`  [${ts}] ${ev.message}`);
      }
      return true;
    },
  };
}
