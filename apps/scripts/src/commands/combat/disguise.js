// FAZA EO — `[disguise` Disguise Kit (Thieves Guild reward).
//
// ServUO `Items/Tools/DisguiseKit.cs`: temporarily hides the player's
// name + applies a random alias. Useful for evading bounty hunters
// after a theft.
//
// We track via `mob._origDisplayName` swap + a status effect. The
// item-form script imports `applyDisguise` from this module so the
// command and double-click path share the same guardrails.

export const DISGUISE_COOLDOWN_MS = 60 * 60 * 1000;
export const DISGUISE_DURATION_MS = 30 * 60 * 1000;
const cooldown = new WeakMap();
const ALIASES = [
  'a hooded figure', 'a masked stranger', 'a cloaked traveler',
  'a shadowy individual', 'a veiled wayfarer',
];

export function applyDisguise(api, sender, tell, opts = {}) {
  if (!sender) return false;
  const say = typeof tell === 'function'
    ? tell
    : (msg) => sender.client?.sendSystemMessage?.(msg);
  if (opts.requireThievesGuild !== false && sender.npcGuild !== 'thieves') {
    say('Only members of the thieves guild are trained to use this item.');
    return false;
  }
  const last = cooldown.get(sender) ?? 0;
  const now = Date.now();
  if (now - last < DISGUISE_COOLDOWN_MS) {
    const left = Math.ceil((DISGUISE_COOLDOWN_MS - (now - last)) / 60_000);
    say(`The kit is exhausted (${left} min remaining).`);
    return false;
  }
  if (sender._origDisplayName || sender.disguised) {
    say('You are already disguised.');
    return false;
  }
  cooldown.set(sender, now);
  sender._origDisplayName = sender.name;
  sender.name = ALIASES[Math.floor(Math.random() * ALIASES.length)];
  api.statusEffects?.apply?.(sender, {
    name: 'disguised',
    durationMs: DISGUISE_DURATION_MS,
    onRemove(mob) {
      if (mob._origDisplayName) {
        mob.name = mob._origDisplayName;
        delete mob._origDisplayName;
      }
    },
  });
  say('Your features blur — you are disguised.');
  return true;
}

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'disguise',
    help: '[disguise — apply a disguise kit (Thieves Guild, 30 min, 1 hr cooldown).',
    access: 'Player',
    run(ctx) {
      applyDisguise(api, ctx.sender, (msg) => ctx.state.sendSystemMessage(msg));
    },
  });

  return () => api.commands.unregister('disguise');
}
