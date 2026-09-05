// Admin commands for tweaking notoriety state.
//
//   [karma <delta>            adjust own karma; pass negative to drop into
//                              the murderer band (-10000 = always red)
//   [murdercount <n>           set kill counter — used by playtests to
//                              recreate the "5 kills = red" transition
//   [pardon                    clear murder count + criminal flag

import { adjustFame, adjustKarma, recomputeNotoriety } from '../../_notoriety.js';
import { allMobiles } from '../../_spatial.js';

export default function register(api) {
  if (!api.protocol) return () => {};

  function rebroadcast(mob) {
    const moving = api.protocol.mobileMoving({
      serial: mob.serial, body: mob.body,
      x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue,
      flags: mob.flags, notoriety: mob.notoriety,
    });
    // BUGFIX #80 (PHASE DL): visibility-gate. The previous global loop
    // shipped 0x77 mobileMoving with the new hue/notoriety to every
    // connected client whenever an admin tweaked their own karma —
    // same bug class as #65/#78. Filter by map + 18 tiles.
    for (const other of allMobiles(api)) {
      if (!other.client) continue;
      if (other.map !== mob.map) continue;
      if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
      other.client.send(moving);
    }
  }

  api.commands.register({
    name: 'karma',
    help: '[karma <delta> — adjust own karma. Negative shifts you toward Murderer.',
    access: 'Admin',
    run(ctx) {
      const delta = Number(ctx.args[0] ?? 0) | 0;
      const old = ctx.sender.notoriety;
      adjustKarma(api, ctx.sender, delta);   // title-cross announcement + recomputeNotoriety
      if (ctx.sender.notoriety !== old) rebroadcast(ctx.sender);
      ctx.state.sendSystemMessage(`Karma now ${ctx.sender.karma} (notoriety ${ctx.sender.notoriety}).`);
    },
  });

  api.commands.register({
    name: 'fame',
    help: '[fame <delta> — adjust own fame. Crossing 1250/2500/5000/10000 announces a new title.',
    access: 'Admin',
    run(ctx) {
      const delta = Number(ctx.args[0] ?? 0) | 0;
      adjustFame(api, ctx.sender, delta);
      ctx.state.sendSystemMessage(`Fame now ${ctx.sender.fame ?? 0}.`);
    },
  });

  api.commands.register({
    name: 'murdercount',
    help: '[murdercount <n> — set own kill counter (0..N).',
    access: 'Admin',
    run(ctx) {
      const n = Math.max(0, Number(ctx.args[0] ?? 0) | 0);
      ctx.sender.kills = n;
      const old = ctx.sender.notoriety;
      recomputeNotoriety(api, ctx.sender);
      if (ctx.sender.notoriety !== old) rebroadcast(ctx.sender);
      ctx.state.sendSystemMessage(`Kill counter now ${n} (notoriety ${ctx.sender.notoriety}).`);
    },
  });

  api.commands.register({
    name: 'pardon',
    help: '[pardon — clear own murder count + criminal flag.',
    access: 'Admin',
    run(ctx) {
      ctx.sender.kills = 0;
      ctx.sender.criminalUntil = 0;
      const old = ctx.sender.notoriety;
      recomputeNotoriety(api, ctx.sender);
      if (ctx.sender.notoriety !== old) rebroadcast(ctx.sender);
      ctx.state.sendSystemMessage(`You are pardoned (notoriety ${ctx.sender.notoriety}).`);
    },
  });

  return () => {
    api.commands.unregister('karma');
    api.commands.unregister('fame');
    api.commands.unregister('murdercount');
    api.commands.unregister('pardon');
  };
}
