import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
// `[insure` flag a worn item + `[insure list` summary + `[insure clear`.
// Cost ramps with recent deaths (1h window): 600 → 900 → 1200 → 1800 → 2400.
// Charged in corpse.killMobile via insurance.chargeInsurance.
//
// `[insurance` opens an itemised gump listing every insured worn piece
// with a per-row Cancel button + a master Clear All — mirrors ServUO's
// `InsuranceGump` (`InsuranceGump.cs`). No separate Insurance Broker
// NPC: every Banker also acts as a broker (matches ServUO `Banker.cs`
// which inherits `InsuranceBroker` hooks).

// Ramp ServUO uses for per-death insurance cost. Mirrors the 5-step
// table at the top of insurance.js. Centralised here so the gump can
// preview the cost without importing the chargeInsurance helper
// (which is also responsible for actually charging the bank).
const INSURANCE_COST_RAMP = [600, 900, 1200, 1800, 2400];

/** Estimate the per-item cost on next death given the player's recent
 *  death count. `recent` is read from `mob._recentDeaths` (set by
 *  chargeInsurance on every kill) and clamped to the ramp range. */
function previewInsuranceCost(mob) {
  const recent = Math.max(0, Math.min(INSURANCE_COST_RAMP.length - 1, (mob._recentDeaths | 0)));
  return INSURANCE_COST_RAMP[recent];
}

const LAYER_BACKPACK = 21;

function listInsured(world, mob) {
  const out = [];
  for (const it of allItems({ world })) {
    if (it.parent !== mob.serial) continue;
    if ((it.layer ?? 0) === 0 || it.layer === LAYER_BACKPACK) continue;
    if (!it.insured) continue;
    out.push(it);
  }
  return out;
}

function openInsuranceGump(api, state, mob, insurance = api.systems?.insurance) {
  const items = listInsured(api.world, mob);
  const perItem = previewInsuranceCost(mob);
  const cost = perItem * items.length;
  if (!api.gumps?.send) {
    state.sendSystemMessage(`Insured: ${items.length} item(s) · estimated death cost ${cost} gp.`);
    for (const it of items) state.sendSystemMessage(`  • ${it.name ?? 'item'} (layer ${it.layer})`);
    state.sendSystemMessage('Type [insure clear to drop all insurance.');
    return;
  }
  const W = 460;
  const headerH = 56;
  const rowH = 22;
  const footerH = 46;
  const H = headerH + Math.max(items.length, 1) * rowH + footerH;
  const lines = [`{ resizepic 0 0 5054 ${W} ${H} }`];
  const texts = [];
  texts.push('── Insurance ──');
  lines.push(`{ text 20 14 1153 ${texts.length - 1} }`);
  texts.push(items.length === 0
    ? 'No items insured.'
    : `${items.length} item${items.length === 1 ? '' : 's'} · estimated cost on death: ${cost} gp`);
  lines.push(`{ text 20 32 70 ${texts.length - 1} }`);
  items.forEach((it, i) => {
    const y = headerH + i * rowH;
    // Per-row Cancel button — buttonId 100 + index.
    lines.push(`{ button 20 ${y} 4017 4018 1 0 ${100 + i} }`);
    texts.push(`Cancel · ${it.name ?? 'item'} (layer ${it.layer})`);
    lines.push(`{ text 52 ${y + 4} 70 ${texts.length - 1} }`);
  });
  const footerY = headerH + Math.max(items.length, 1) * rowH + 6;
  // Master "Clear All" — buttonId 200.
  if (items.length > 0) {
    lines.push(`{ button 20 ${footerY} 4017 4018 1 0 200 }`);
    texts.push('Cancel ALL insurance');
    lines.push(`{ text 52 ${footerY + 4} 33 ${texts.length - 1} }`);
  }
  // Close (X) at top-right.
  lines.push(`{ button ${W - 32} 8 4017 4018 1 0 0 }`);
  api.gumps.send(state, { definitionId: 'server:commands-economy-insure:open-insurance-gump', x: 100, y: 100, layout: lines.join(''), texts }, (resp) => {
    const btn = resp.buttonId | 0;
    if (btn === 0) return;
    if (btn === 200) {
      for (const it of items) insurance.uninsureItem(it);
      state.sendSystemMessage(`Cleared insurance on ${items.length} item${items.length === 1 ? '' : 's'}.`);
      return;
    }
    if (btn >= 100 && btn < 100 + items.length) {
      const target = items[btn - 100];
      if (target) {
        insurance.uninsureItem(target);
        state.sendSystemMessage(`Insurance cleared on ${target.name ?? 'item'}.`);
        // Re-open so the operator can prune more entries in one session.
        openInsuranceGump(api, state, mob);
      }
    }
  });
}

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};
  const insurance = api.systems?.insurance;
  if (!insurance) {
    api.log?.('insure: insurance system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'insure',
    help: '[insure [all|clear|list] — toggle item insurance. No args targets a single item; `all` insures every worn piece, `clear` drops all, `list` opens a manage gump.',
    access: 'Player',
    run(ctx) {
      const rest = String(ctx.args[0] ?? '').toLowerCase();
      if (rest === 'all') {
        const r = insurance.insureAll(api.world, ctx.sender);
        ctx.state.sendSystemMessage(`Insured ${r.insured} worn item(s).`);
        return;
      }
      if (rest === 'clear') {
        // Drop insurance on every currently-insured worn item. Cheaper
        // than re-targeting each piece when you want a clean slate
        // before a risky run.
        let n = 0;
        for (const it of listInsured(api.world, ctx.sender)) {
          insurance.uninsureItem(it); n++;
        }
        ctx.state.sendSystemMessage(`Cleared insurance on ${n} item(s).`);
        return;
      }
      if (rest === 'list' || rest === 'gump' || rest === '') {
        // Default to the gump path — `[insure` with no args is the
        // common "what's my insurance situation" check. The target
        // flow is reachable via `[insure target` for the old behaviour.
        if (rest === '') {
          // No-arg: keep legacy targeting behaviour for users muscle-
          // memoried on `[insure → pick`. Send a hint then drop into
          // the target prompt.
          ctx.state.sendSystemMessage('Insure which item? Or run `[insure list` for the manage gump.');
        } else {
          openInsuranceGump(api, ctx.state, ctx.sender, insurance);
          return;
        }
      }
      // Fall-through: target prompt path.
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) {
          ctx.state.sendSystemMessage('Not an item.');
          return;
        }
        if (item.parent !== ctx.sender.serial || (item.layer ?? 0) === 0) {
          ctx.state.sendSystemMessage('You can only insure equipped items.');
          return;
        }
        if (item.insured) {
          insurance.uninsureItem(item);
          ctx.state.sendSystemMessage('Insurance cleared.');
        } else {
          insurance.insureItem(ctx.sender, item);
          ctx.state.sendSystemMessage('Item insured. Cost on death scales 600-2400 gp based on recent deaths.');
        }
      }, { kind: 0 });
    },
  });

  // `[insurance` alias — ServUO calls the manage gump via the chat
  // keyword "insurance" said near a Banker. We expose it as a flat
  // command for muscle-memory parity with retail.
  api.commands.register({
    name: 'insurance',
    help: '[insurance — open the insurance manage gump.',
    access: 'Player',
    run(ctx) { openInsuranceGump(api, ctx.state, ctx.sender, insurance); },
  });

  return () => {
    api.commands.unregister('insure');
    api.commands.unregister('insurance');
  };
}
