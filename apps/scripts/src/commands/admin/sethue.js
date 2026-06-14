// `[sethue <hue>` — recolor your own mobile.
// Inspired by ServUO's SetHue Properties command (Scripts/Commands/Properties.cs).

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  api.commands.register({
    name: 'sethue',
    help: 'sethue <hue> — change your own hue (0..0xFFFF)',
    run(ctx, args) {
      if (!args.length) { ctx.state.sendSystemMessage('Usage: [sethue <hue>'); return; }
      const hue = parseInt(args[0], 0);
      if (!Number.isFinite(hue) || hue < 0 || hue > 0xFFFF) {
        ctx.state.sendSystemMessage('Invalid hue.');
        return;
      }
      ctx.sender.hue = hue;
      ctx.state.send(api.protocol.mobileUpdate({
        serial: ctx.sender.serial, body: ctx.sender.body, hue,
        flags: ctx.sender.flags,
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z,
        direction: ctx.sender.direction,
      }));
      ctx.state.sendSystemMessage(`Hue set to 0x${hue.toString(16)}.`);
    },
  });
}
