import { readHelpRequest, unicodeMessage } from '@uo/protocol';
import * as chatChannels from '../../chat-channels.js';
import * as helpQueue from '../../help-queue.js';
import { handleBulletinPacket } from '../../systems/bulletin-board.js';
import { Stage } from '../net-state.js';

export function handleBulletinBoardReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  try { handleBulletinPacket(state, pkt); }
  catch (e) { console.error('[bbs]', e.message); }
}

/**
 * `/channel msg`, `/list`, `/join`, `/leave` chat-channel UX. Returns
 * true when the input was consumed (so the caller skips the world
 * speech broadcast), false to fall through.
 */
export function handleChannelCommand(state, mob, text) {
  // Strip leading slash + tokenise. Empty / single-char inputs fall
  // through (caller broadcasts them as speech, e.g. someone literally
  // saying "/").
  const body = text.slice(1).trim();
  if (!body) return false;
  const m = body.match(/^(\S+)\s*(.*)$/);
  if (!m) return false;
  const verb = m[1].toLowerCase();
  const rest = m[2];

  if (verb === 'list' || verb === 'channels') {
    const lines = chatChannels.list().map((c) => `  ${c.name} (${c.members})`);
    state.sendSystemMessage?.(`Channels:\n${lines.join('\n')}`);
    return true;
  }
  if (verb === 'join' && rest) {
    if (chatChannels.join(rest, mob)) state.sendSystemMessage?.(`Joined ${rest}.`);
    else state.sendSystemMessage?.(`Cannot join ${rest}.`);
    return true;
  }
  if (verb === 'leave' && rest) {
    if (chatChannels.leave(rest, mob)) state.sendSystemMessage?.(`Left ${rest}.`);
    else state.sendSystemMessage?.(`You are not in ${rest}.`);
    return true;
  }

  // Otherwise treat the verb as a channel name and `rest` as the
  // message. Auto-join if not yet a member so first-time `/general hi`
  // just works.
  if (rest) {
    if (!chatChannels.isMember(verb, mob)) chatChannels.join(verb, mob);
    const count = chatChannels.broadcast(verb, mob, () => unicodeMessage({
      serial: mob.serial,
      graphic: mob.body,
      type: 0,
      hue: 0x0481,            // chat channel hue (CUO ChatColor.Default)
      name: `[${verb}] ${mob.name}`,
      text: rest,
    }));
    if (count === 0 && !chatChannels.isMember(verb, mob)) {
      state.sendSystemMessage?.(`Channel "${verb}" does not exist.`);
    } else {
      // Echo to self so the sender sees their own line.
      state.send(unicodeMessage({
        serial: mob.serial, graphic: mob.body, type: 0, hue: 0x0481,
        name: `[${verb}] ${mob.name}`, text: rest,
      }));
    }
    return true;
  }
  return false;
}

export function handleHelpRequest(state, pkt) {
  // 0x9B HelpRequest layout in ServUO PageQueueGump dispatch is just a
  // stub trigger — the C# server pops a category gump back to the
  // client. We don't have that gump wired client-side yet, so the
  // simplest port is "treat the 257-byte payload as a category byte +
  // 256-char message slot, then enqueue". Older clients send only the
  // opcode + 1B, so we fall back to category=Other / no message.
  let category = 8;        // 'Other request'
  let text = '';
  if (pkt && pkt.length >= 2) {
    try {
      const r = readHelpRequest(pkt);
      if (r) { category = r.category ?? category; text = r.text ?? ''; }
    } catch { /* shape-tolerant — older clients omit fields */ }
  }
  if (!text) text = `(no message — category ${helpQueue.categoryName(category)})`;
  const id = helpQueue.enqueue({
    sender: state.mobile?.name ?? state.accountName ?? '(anon)',
    senderSerial: state.mobile?.serial ?? 0,
    text, category,
  });
  console.log(`[help#${id}] ${state.mobile?.name ?? '(anon)'} (${helpQueue.categoryName(category)}): ${text}`);
  // Open the Help category gump server-side so clients without the
  // built-in help dialog still get an interactive picker. ServUO uses
  // QueryHelpGump (subop 0xBF/0x39); we use the standard 0xB0 layout.
  try {
    const gumpDispatcher = state.ctx?.systems?.serverGumps;
    const gumps = state.ctx?.gumps;
    if (gumpDispatcher?.openHelpCategoriesGump && gumps?.send) {
      gumpDispatcher.openHelpCategoriesGump(gumps, state, (chosenCategory) => {
        if (chosenCategory != null && chosenCategory !== category) {
          // Player picked a different category → record an updated entry.
          helpQueue.enqueue({
            sender: state.mobile?.name ?? state.accountName ?? '(anon)',
            senderSerial: state.mobile?.serial ?? 0,
            text: `(category reclassified to ${helpQueue.categoryName?.(chosenCategory) ?? chosenCategory})`,
            category: chosenCategory,
          });
        }
      });
    }
  } catch { /* gump optional */ }
  state.sendSystemMessage?.(`Your page (#${id}) has been entered into the help queue. A GM will be with you shortly.`);
  // Notify staff online — visibility filter to GM/Admin only.
  for (const o of state.ctx.world.mobiles.values()) {
    if (!o.client) continue;
    const lvl = o.client.account?.accessLevel;
    if (lvl !== 'GM' && lvl !== 'Admin') continue;
    o.client.sendSystemMessage?.(`[help#${id}] ${state.mobile?.name ?? '(anon)'}: ${text}`, 0x40);
  }
}

