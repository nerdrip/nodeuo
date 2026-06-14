import { allMobiles } from '../../_spatial.js';
// `[vendortitle <kind> <title>` — GM bulk-set custom title across all
// vendors of a given vendorKind. Empty title clears (auto-tier
// resumes). Use case: shard event "All blacksmiths now title:
// 'the Saturnalia Smith'" for a one-week promotion.
//
// `[vendortitle <kind>` (no title) prints the current title status
// for vendors of that kind.

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'vendortitle',
    help: '[vendortitle <kind> [title] [#hue] — GM bulk-set; trailing #hue (e.g. #0x47E) stamps title body hue.',
    access: 'GM',
    run(ctx) {
      const kind = String(ctx.args[0] ?? '').toLowerCase();
      if (!kind) {
        ctx.state.sendSystemMessage('Usage: [vendortitle <kind> [title] [#hue]');
        return;
      }
      // Wave 28: optional trailing #hue token sets the body hue
      // independently from auto-tier color. `#0` = clear override.
      const tail = ctx.args.slice(1);
      let titleHue = null;
      let hueProvided = false;
      if (tail.length && tail[tail.length - 1].startsWith('#')) {
        const hueTok = tail.pop().slice(1);
        const v = /^0x/i.test(hueTok) ? parseInt(hueTok, 16) : parseInt(hueTok, 10);
        if (!Number.isFinite(v) || v < 0 || v > 0xFFFF) {
          ctx.state.sendSystemMessage('Title hue must be 0..0xFFFF.');
          return;
        }
        titleHue = v;
        hueProvided = true;
      }
      const title = tail.join(' ').trim();
      if (title.length > 60) {
        ctx.state.sendSystemMessage('Custom title too long (max 60 chars).');
        return;
      }
      let touched = 0;
      let already = 0;
      for (const mob of allMobiles({ world })) {
        if (!mob.vendorKind) continue;
        if (String(mob.vendorKind).toLowerCase() !== kind) continue;
        // No title arg: report only.
        if (ctx.args.length === 1) {
          touched++;
          continue;
        }
        // Wave 28: per-mob hue stamp / clear (independent of title).
        if (hueProvided) {
          if (titleHue === 0) {
            // Revert hue: drop custom override; vendor.js will pick
            // back up tier hue or _originalHue on next refresh.
            delete mob._customTitleHue;
            if (mob._originalHue != null) mob.hue = mob._originalHue;
          } else {
            mob._customTitleHue = titleHue;
            // Snapshot baseline before overriding (refreshVendorTitle
            // also does this on first promotion, but we guard for the
            // case where prestige never kicked in).
            if (mob._originalHue == null) mob._originalHue = mob.hue ?? 0;
            mob.hue = titleHue;
          }
        }
        if (!title) {
          if (mob._customTitle == null && !mob.title) {
            if (!hueProvided) { already++; continue; }
          } else {
            delete mob._customTitle;
            mob.title = null;
          }
        } else {
          if (mob._customTitle === title) {
            if (!hueProvided) { already++; continue; }
          } else {
            mob._customTitle = title;
            mob.title = title;
          }
        }
        touched++;
      }
      if (ctx.args.length === 1) {
        ctx.state.sendSystemMessage(`Found ${touched} vendor(s) with kind "${kind}".`);
      } else if (!title) {
        ctx.state.sendSystemMessage(`Cleared title on ${touched} "${kind}" vendor(s) (${already} already cleared).`);
      } else {
        ctx.state.sendSystemMessage(`Set title "${title}" on ${touched} "${kind}" vendor(s) (${already} already set).`);
      }
    },
  });

  return () => commands.unregister('vendortitle');
}
