// `[haggle` — attempt to negotiate a discount with a nearby vendor.
//
// Mechanic: skill check on Begging (skill id 7). Success grants a
// percent-off coupon on the next buy session with that vendor (single
// transaction). Failure earns a snide remark and a 5-minute cooldown.
//
// Skill scaling (UO-feel):
//   skill   0..30   → 0..3% discount, 30% chance to succeed
//   skill  30..70   → 3..10% discount, 60% chance
//   skill  70..100  → 10..15% discount, 90% chance
//
// Coupons live on the vendor under `_haggledBy: Map<playerSerial,
// {pct, expiresAt}>`. The vendor's `onBuy` consumes them.

import { normalizeSkillValue } from '../../_rules.js';
import { allMobiles } from '../../_spatial.js';

const SKILL_BEGGING = 7;
const HAGGLE_RANGE = 4;
const COUPON_TTL_MS = 5 * 60_000;
const COOLDOWN_MS  = 5 * 60_000;

function findNearbyVendor(world, mob) {
  let best = null;
  let bestD = HAGGLE_RANGE + 1;
  for (const m of allMobiles({ world })) {
    if (!m.vendorKind) continue;
    if (m.map !== mob.map) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}

function effectiveBeggingSkill(mob) {
  const raw = mob.skills?.[SKILL_BEGGING] ?? mob.skills?.['7'] ?? 0;
  return normalizeSkillValue(raw);
}

function rollHaggle(skill, rng = Math.random) {
  // Tiered: see header. successChance is the gate; on success, pct
  // is uniform in the tier band so even high skill occasionally caps
  // out lower than the maximum.
  let band, chance;
  if (skill < 30)      { band = [0.00, 0.03]; chance = 0.30; }
  else if (skill < 70) { band = [0.03, 0.10]; chance = 0.60; }
  else                 { band = [0.10, 0.15]; chance = 0.90; }
  if (rng() > chance) return { pct: 0, ok: false };
  const pct = band[0] + rng() * (band[1] - band[0]);
  return { pct, ok: true };
}

/**
 * Wave 12: targeted haggle — player names a specific discount %, the
 * chance to succeed degrades when the ask exceeds their skill band's
 * natural maximum. Failing here is more punitive than the unguided
 * rollHaggle (cooldown-wise the same, but the vendor's snide response
 * mocks the asking %).
 *
 * Curve:
 *   target ≤ band.max         → uniform skill chance (same as untargeted)
 *   target ≤ band.max + 5%    → chance × 0.5
 *   target ≤ band.max + 10%   → chance × 0.2
 *   beyond                    → cap at 5% chance
 *
 * On success the granted pct equals the requested target (clamped 0..15).
 */
function rollTargetedHaggle(skill, targetPct, rng = Math.random) {
  let band, chance;
  if (skill < 30)      { band = [0.00, 0.03]; chance = 0.30; }
  else if (skill < 70) { band = [0.03, 0.10]; chance = 0.60; }
  else                 { band = [0.10, 0.15]; chance = 0.90; }
  const tgt = Math.max(0, Math.min(0.15, targetPct));
  if (tgt <= band[1])           chance *= 1;
  else if (tgt <= band[1] + 0.05) chance *= 0.5;
  else if (tgt <= band[1] + 0.10) chance *= 0.2;
  else chance = Math.min(chance, 0.05);
  if (rng() > chance) return { pct: 0, ok: false };
  return { pct: tgt, ok: true };
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  // Per-player cooldown per vendor — a hashmap of `${vendorSerial}-${playerSerial}` → expiry.
  const cooldowns = new Map();

  commands.register({
    name: 'haggle',
    help: '[haggle [pct] — talk a nearby vendor down on price (Begging skill). pct = 1..15 to demand exact %.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const vendor = findNearbyVendor(world, mob);
      if (!vendor) {
        ctx.state.sendSystemMessage('No vendor is within earshot.');
        return;
      }
      const cdKey = `${vendor.serial}-${mob.serial}`;
      const now = Date.now();
      const cd = cooldowns.get(cdKey) ?? 0;
      if (now < cd) {
        const remaining = Math.ceil((cd - now) / 1000);
        ctx.state.sendSystemMessage(`The vendor is still annoyed. Try again in ${remaining}s.`);
        return;
      }
      cooldowns.set(cdKey, now + COOLDOWN_MS);

      const skill = effectiveBeggingSkill(mob);
      // Wave 12: optional target percent. `[haggle 12` asks for 12%
      // off — risky if your skill band's natural max is 10%.
      const targetArg = parseInt(ctx.args[0], 10);
      const targeted = Number.isFinite(targetArg) && targetArg > 0;
      const { pct, ok } = targeted
        ? rollTargetedHaggle(skill, targetArg / 100)
        : rollHaggle(skill);
      // Wave 13: bump session history so the vendor remembers haggle
      // outcomes across visits. The greeter uses this to switch tone.
      vendor._customerHistory ??= new Map();
      const h = vendor._customerHistory.get(mob.serial) ?? {};
      h[ok ? 'haggleWins' : 'haggleFails'] = (h[ok ? 'haggleWins' : 'haggleFails'] ?? 0) + 1;
      h.lastSeen = Date.now();
      vendor._customerHistory.set(mob.serial, h);
      if (!ok) {
        ctx.state.sendSystemMessage(
          'The vendor scoffs. Your bargaining attempt fell flat.',
        );
        // Visible NPC reply via broadcast speech.
        if (api.protocol?.unicodeMessage) {
          const pkt = api.protocol.unicodeMessage({
            serial: vendor.serial, graphic: vendor.body, type: 0,
            hue: 0x0026, font: 3, language: 'ENU',
            name: vendor.name, text: 'Bah. Pay full price or be gone.',
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m.map !== vendor.map) continue;
            if (Math.abs(m.x - vendor.x) > 12 || Math.abs(m.y - vendor.y) > 12) continue;
            m.client.send(pkt);
          }
        }
        return;
      }
      // Stamp the coupon on the vendor. Sweep expired entries on the
      // way in — bug-hunt #2 A9: previously the map only grew.
      vendor._haggledBy ??= new Map();
      for (const [k, c] of vendor._haggledBy) {
        if ((Number(c?.expiresAt) || 0) > 0 && now > c.expiresAt) vendor._haggledBy.delete(k);
      }
      vendor._haggledBy.set(mob.serial, { pct, expiresAt: now + COUPON_TTL_MS });
      ctx.state.sendSystemMessage(
        `${vendor.name} agrees to ${Math.round(pct * 100)}% off your next purchase here.`,
      );
      // Skill gain pulse — reuse existing skill-gain helper if present.
      api.skillGain?.tick?.(mob, SKILL_BEGGING);
    },
  });

  return () => commands.unregister('haggle');
}
