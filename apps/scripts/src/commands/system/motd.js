// [motd — set or print the message-of-the-day. Pushed to every player
// at login (via the welcome path) so players see fresh announcements.
// Persisted to saves/motd.txt so a restart preserves the message.
//
// Usage:
//   [motd                   print current MOTD
//   [motd <text>            set new MOTD
//   [motd clear             remove

import fs from 'node:fs';
import path from 'node:path';

let cachedText = null;

function motdPath(api) {
  const dir = api.persistence?.saveDir;
  if (!dir) return null;
  return path.join(dir, 'motd.txt');
}

export function readMotd(api) {
  if (cachedText !== null) return cachedText;
  const p = motdPath(api);
  if (!p || !fs.existsSync(p)) { cachedText = ''; return ''; }
  try { cachedText = fs.readFileSync(p, 'utf8'); }
  catch { cachedText = ''; }
  return cachedText;
}

function writeMotd(api, text) {
  const p = motdPath(api);
  if (!p) return false;
  cachedText = text;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return true;
  } catch (e) { console.error('[motd] write', e); return false; }
}

export default function (api) {
  const { commands } = api;

  commands.register({
    name: 'motd',
    help: 'Set or print the message of the day. "clear" removes it.',
    access: 'Admin',
    run: (ctx) => {
      const args = ctx.args ?? [];
      if (args.length === 0) {
        const text = readMotd(api);
        if (!text) ctx.state.sendSystemMessage('MOTD is empty.');
        else for (const ln of text.split(/\r?\n/)) ctx.state.sendSystemMessage(ln);
        return;
      }
      if (args.length === 1 && /^clear$/i.test(args[0])) {
        writeMotd(api, '');
        ctx.state.sendSystemMessage('MOTD cleared.');
        return;
      }
      const text = args.join(' ');
      if (writeMotd(api, text)) ctx.state.sendSystemMessage(`MOTD set: ${text}`);
      else ctx.state.sendSystemMessage('Failed to write MOTD.');
    },
  });

  return () => commands.unregister('motd');
}
