// PHASE HE — `[give <itemIdOrTemplate> [amount] [hue]` GM quick-spawn.
//
// ServUO `Scripts/Commands/Add.cs` lets staff drop any item directly
// into the target's pack. We expose the same as a fast text command:
//
//   [give 0x0EED 100      → 100 gold pile in self pack
//   [give longsword       → spawn longsword by item template
//   [give 0x1F4D 3 0x47   → 3 hued scrolls of magic (hue 0x47)

export default function register(api) {
  if (!api.commands || !api.game?.mobile?.giveItem) return () => {};

  const TEMPLATE_RUNTIME_KEYS = [
    'servuoClass', 'servuoClasses', 'servuoPath',
    'container', 'capacity', 'maxWeight', 'stackable', 'labelNumber',
    'weapon', 'shield', 'ar', 'strReq', 'twoHanded', 'skill', 'minDamage', 'maxDamage', 'speed', 'range', 'ammoId',
    'bandageHealingBonus',
    'firstAidBelt', 'firstAidMaxBandages', 'firstAidHealingBonus', 'firstAidWeightReduction',
    'fountainCharges', 'fountainMaxCharges', 'fountainNextRechargeAt',
    'boatDeed', 'boatPlank', 'boatKey',
    'addonName', 'addonNames',
    '_deedMulti', '_deedOffset', '_contestHouse', '_previewHouse',
    'secureLevel',
    'args', 'displayName', 'anniversaryChoice', '_timepiece', '_dailyRare', '_ancientWall',
    '_sphynxFortune',
  ];
  const copyTemplateRuntime = (tpl) => {
    const out = {};
    for (const key of TEMPLATE_RUNTIME_KEYS) {
      if (tpl?.[key] !== undefined) out[key] = tpl[key];
    }
    return out;
  };

  // `[create` owns the visual creation hub (admin/create.js). Keep this
  // command focused on direct item creation and expose `createitem` as the
  // explicit compatibility alias.
  const runGive = (ctx) => {
      const arg = ctx.args[0];
      if (!arg) {
        ctx.state.sendSystemMessage('Usage: [give <itemId|template> [amount] [hue]');
        return;
      }
      const amount = Math.max(1, Number(ctx.args[1] ?? 1) | 0);
      let hue = ctx.args[2] != null ? parseInt(ctx.args[2], 0) | 0 : 0;
      // Try numeric itemId first.
      const numeric = parseInt(arg, 0);
      let itemId = Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      let name = null;
      let tpl = null;
      if (itemId == null) {
        // Template lookup.
        tpl = api.templates?.get?.(arg) ?? api.itemTypes?.resolve?.(arg);
        if (!tpl) {
          ctx.state.sendSystemMessage(`Unknown item definition: ${arg}.`);
          return;
        }
        itemId = tpl.artId ?? tpl.itemId;
        name = tpl.label ?? tpl.name ?? arg;
        if (ctx.args[2] == null) hue = tpl.hue ?? 0;
      }
      const item = api.game.mobile.giveItem(ctx.sender, {
        itemId, hue, amount,
        name,
        ...(tpl?.definitionId ? { definitionId: tpl.definitionId } : {}),
        ...copyTemplateRuntime(tpl),
        ...(tpl?.script ? { script: tpl.script } : {}),
      }, { requireBackpack: false, randomGrid: true });
      if (!item) {
        ctx.state.sendSystemMessage('Item creation failed.');
        return;
      }
      if (tpl?.weight != null) item.weight = tpl.weight;
      if (tpl?.dyeHues) item.dyeHues = tpl.dyeHues;
      ctx.state.sendSystemMessage(
        `Gave ${amount}× 0x${itemId.toString(16)}${hue ? ` (hue 0x${hue.toString(16)})` : ''}${name ? ` — ${name}` : ''}.`,
      );
  };

  api.commands.register({
    name: 'give',
    aliases: ['createitem'],
    help: '[give <itemId|template> [amount] [hue] — drop the item in your pack.',
    access: 'GM',
    run: runGive,
  });
  return () => {
    api.commands.unregister('give');
  };
}
