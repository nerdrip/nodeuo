import {
  mobileIncoming,
  openPaperdoll,
} from '@uo/protocol';
import { NodeUOFeature, NodeUONpcDialogMessage } from '@uo/nodeuo-protocol';
import { recordNpcInteraction } from './nodeuo-wave3.js';
import { isPaperdollBody } from '../../systems/race.js';
import { equipmentFor } from './equipment-visibility.js';
import { sendNodeUOEvent } from './nodeuo-modern.js';

const NPC_DIALOG_TTL_MS = 60_000;
const NPC_DIALOG_RANGE = 12;
const NPC_DIALOG_MAX_ACTIONS = 24;
const NPC_CONTEXT_LABELS = new Map([
  [3006124, 'View profile'],
  [3006145, 'Open backpack'],
  [3006107, 'Guard me'],
  [3006108, 'Follow me'],
  [3006111, 'Attack…'],
  [3006114, 'Stay here'],
  [3006118, 'Release'],
  [3006109, 'Hear the news'],
  [3006146, 'Training'],
  [1157587, 'Mount'],
  [1028843, 'Dismount'],
]);

/**
 * Owns the negotiated Visual Novel NPC interaction flow. Dependencies on the
 * handler module's vendor registry are injected to keep this module acyclic
 * and independently testable.
 */
export function createNpcDialogController({ vendors, hasVendor }) {
  const conversationFor = (state, mob) => {
    const conversations = state.ctx?.systems?.questConversation ?? state.ctx?.questConversation;
    const kind = [mob.kind, mob.servuoClass, ...(mob.servuoClasses ?? [])]
      .find((candidate) => candidate && conversations?.getConversation?.(candidate));
    return kind ? { conversations, kind } : null;
  };

  const isBanker = (mob) => [mob.kind, mob.role, mob.npcRole, mob.vendorKind, mob.behavior, mob.ai]
    .some((value) => String(value ?? '').toLowerCase() === 'banker');

  const inRange = (state, mob) => {
    const actor = state.mobile;
    return !!(actor && mob && !actor.dead && !mob.dead && actor.map === mob.map
      && Math.max(Math.abs(actor.x - mob.x), Math.abs(actor.y - mob.y)) <= NPC_DIALOG_RANGE);
  };

  const sendPaperdoll = (state, mob) => {
    if (!isPaperdollBody(mob.body)) return false;
    state.send(mobileIncoming({
      serial: mob.serial,
      body: mob.body,
      x: mob.x,
      y: mob.y,
      z: mob.z,
      direction: mob.direction,
      hue: mob.hue,
      flags: mob.flags,
      notoriety: mob.notoriety,
      equipment: equipmentFor(state.ctx.world, mob),
    }));
    state.send(openPaperdoll({
      serial: mob.serial,
      title: mob.title ? `${mob.name}, ${mob.title}` : (mob.name ?? ''),
      flags: mob === state.mobile ? 0x02 : 0x00,
    }));
    return true;
  };

  const close = (state, requestId, npcSerial) => {
    if (state._nodeUONpcDialog?.requestId === (requestId >>> 0)) state._nodeUONpcDialog = null;
    const payload = { npcSerial: npcSerial >>> 0 };
    sendNodeUOEvent(state, {
      feature: NodeUOFeature.NpcDialog, eventKind: NodeUONpcDialogMessage.Close, requestId, payload,
    });
  };

  const render = (state, mob, dialogue = null, requestId = 0) => {
    if (!inRange(state, mob)) return false;
    const id = (requestId >>> 0) || (() => {
      state._nodeUONpcDialogSeq = ((state._nodeUONpcDialogSeq ?? 0) + 1) >>> 0;
      return state._nodeUONpcDialogSeq || 1;
    })();
    const actions = new Map();
    const publicActions = [];
    const seen = new Set();
    const addAction = ({ label, kind = 'service', onPick, close: closes = true,
      enabled = true, reason = '', skillCheck = null }) => {
      label = String(label ?? '').trim().slice(0, 96);
      if (!label || typeof onPick !== 'function' || publicActions.length >= NPC_DIALOG_MAX_ACTIONS) return;
      const dedupeKey = `${kind}:${label.toLowerCase()}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      state._nodeUONpcDialogActionSeq = ((state._nodeUONpcDialogActionSeq ?? 0) + 1) >>> 0;
      const actionId = `a${state._nodeUONpcDialogActionSeq || 1}`;
      if (enabled) actions.set(actionId, { onPick, close: closes });
      publicActions.push({ id: actionId, label, kind, enabled, reason: String(reason).slice(0, 160), skillCheck });
    };

    const conversation = conversationFor(state, mob);
    if (conversation && dialogue) {
      for (const choice of dialogue.choices ?? []) {
        const choiceKey = String(choice.key ?? '');
        const required = choice.requiresSkill;
        const rawSkill = required ? state.mobile?.skills?.[required.skillId] : null;
        const skill = Number(rawSkill?.value ?? rawSkill?.base ?? rawSkill ?? 0) || 0;
        const minimum = Number(required?.minimum) || 0;
        const enabled = !required || (skill > 120 ? skill / 10 : skill) >= minimum;
        addAction({
          label: choice.text || choiceKey,
          kind: 'talk',
          close: false,
          enabled,
          reason: enabled ? '' : `Requires skill #${required.skillId} at ${minimum}.`,
          skillCheck: choice.skillCheck ?? null,
          onPick: () => {
            const next = conversation.conversations.advanceConversation?.({
              playerState: state, npc: mob, input: choiceKey,
            });
            render(state, mob, next ?? dialogue, id);
          },
        });
      }
      if (!dialogue.terminal && !(dialogue.choices?.length)) {
        addAction({
          label: 'Continue', kind: 'talk', close: false,
          onPick: () => {
            const next = conversation.conversations.advanceConversation?.({
              playerState: state, npc: mob, input: '',
            });
            render(state, mob, next ?? dialogue, id);
          },
        });
      }
    } else if (!conversation) {
      const keywords = [...new Set([
        ...(Array.isArray(mob._speechKeywords) ? mob._speechKeywords : []),
        ...(Array.isArray(mob.keywords) ? mob.keywords : []),
      ].map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 8);
      for (const keyword of keywords) {
        if (isBanker(mob) && /^(bank|balance)$/i.test(keyword)) continue;
        addAction({
          label: `Ask about ${keyword}`, kind: 'talk',
          onPick: () => {
            mob._heardSpeech ??= [];
            mob._heardSpeech.push({ speaker: state.mobile, text: keyword, hue: 0 });
            while (mob._heardSpeech.length > 16) mob._heardSpeech.shift();
          },
        });
      }
    }

    const banker = isBanker(mob);
    if (banker) {
      addAction({
        label: 'Open bank box', kind: 'service',
        onPick: () => state.ctx?.commands?.dispatch?.('bank', {
          sender: state.mobile, state, world: state.ctx.world, args: [],
        }),
      });
    }
    if (hasVendor(mob.serial) && !banker) {
      addAction({ label: 'Buy', kind: 'trade', onPick: () => vendors.openBuy(state, mob.serial) });
      addAction({
        label: 'Sell', kind: 'trade',
        onPick: () => {
          if (!vendors.openSell(state, mob.serial)) state.sendSystemMessage?.('You have nothing I would buy.');
        },
      });
    }

    try {
      const entries = state.ctx?.contextMenuProvider?.(state, mob.serial) ?? [];
      for (const entry of entries) {
        if ((entry.flags ?? 0) & 0x01) continue;
        if (entry.cliloc === 3006123 || entry.cliloc === 3006121 || entry.cliloc === 3006122) continue;
        const label = entry.nodeUOLabel ?? entry.label ?? NPC_CONTEXT_LABELS.get(entry.cliloc);
        if (!label) continue;
        addAction({
          label,
          kind: entry.nodeUOKind ?? (entry.cliloc === 3006124 ? 'character' : 'service'),
          onPick: entry.onPick,
        });
      }
    } catch (error) {
      console.warn(`[npc-dialog] context provider failed: ${error?.message ?? error}`);
    }

    if (isPaperdollBody(mob.body)) {
      addAction({ label: 'Open paperdoll', kind: 'character', onPick: () => sendPaperdoll(state, mob) });
    }

    const greeting = dialogue?.text
      ?? mob._greetings?.[0]
      ?? mob.greeting
      ?? `${mob.name ?? 'The stranger'} regards you expectantly.`;
    const previous = state._nodeUONpcDialog;
    const history = previous?.npcSerial === (mob.serial >>> 0) ? [...(previous.history ?? [])] : [];
    history.push({ speaker: String(dialogue?.speaker ?? mob.name ?? 'NPC').slice(0, 80),
      text: String(greeting).slice(0, 4000), nodeId: dialogue?.id ?? null });
    if (history.length > 16) history.splice(0, history.length - 16);
    state._nodeUONpcDialog = {
      requestId: id,
      npcSerial: mob.serial >>> 0,
      expiresAt: Date.now() + NPC_DIALOG_TTL_MS,
      actions, history,
    };
    const payload = {
        npcSerial: mob.serial >>> 0,
        name: String(mob.name ?? 'Unknown').slice(0, 80),
        title: String(mob.title ?? mob.vocation ?? mob.role ?? '').slice(0, 120),
        portrait: {
          body: (dialogue?.portrait?.body ?? mob.body) | 0,
          hue: (dialogue?.portrait?.hue ?? mob.hue) | 0,
          equipment: equipmentFor(state.ctx.world, mob).slice(0, 32).map((item) => ({
            itemId: item.itemId | 0, hue: item.hue | 0, layer: item.layer | 0,
          })),
        },
        dialogue: {
          nodeId: dialogue?.id ?? null,
          text: String(greeting).slice(0, 4000),
          terminal: !!dialogue?.terminal,
          speaker: String(dialogue?.speaker ?? mob.name ?? '').slice(0, 80),
          expression: String(dialogue?.expression ?? mob.expression ?? '').slice(0, 48),
          voice: String(dialogue?.voice ?? '').slice(0, 256),
          rewards: Array.isArray(dialogue?.rewards) ? dialogue.rewards.slice(0, 16) : [],
        },
        history,
        actions: publicActions,
      };
    sendNodeUOEvent(state, {
      feature: NodeUOFeature.NpcDialog, eventKind: NodeUONpcDialogMessage.Open, requestId: id, payload,
    });
    return true;
  };

  const open = (state, mob) => {
    if (!inRange(state, mob)) return false;
    recordNpcInteraction(state.mobile, mob, 'open');
    const conversation = conversationFor(state, mob);
    const dialogue = conversation?.conversations.beginConversation?.({
      playerState: state, npc: mob, kind: conversation.kind,
    }) ?? null;
    return render(state, mob, dialogue);
  };

  const handleReply = (state, kind, requestId, payload) => {
    const session = state._nodeUONpcDialog;
    if (!session || session.requestId !== (requestId >>> 0)) return;
    if (kind === NodeUONpcDialogMessage.Close) {
      state._nodeUONpcDialog = null;
      return;
    }
    const mob = state.ctx.world.mobiles.get(session.npcSerial);
    if (!mob || Date.now() > session.expiresAt || !inRange(state, mob)) {
      close(state, requestId, session.npcSerial);
      return;
    }
    const actionId = typeof payload?.actionId === 'string' ? payload.actionId : '';
    const action = session.actions.get(actionId);
    if (!action) return;
    recordNpcInteraction(state.mobile, mob, 'choice');
    session.actions.delete(actionId);
    if (action.close) close(state, requestId, mob.serial);
    try {
      const result = action.onPick();
      Promise.resolve(result).catch((error) => {
        if (!action.close) close(state, requestId, mob.serial);
        console.error('[npc-dialog] async action rejected:', error);
      });
    } catch (error) {
      if (!action.close) close(state, requestId, mob.serial);
      console.error('[npc-dialog] action threw:', error);
    }
  };

  return Object.freeze({
    handleReply,
    isScripted(state, mob) {
      return !!(mob && !mob.isPlayer && (
        mob.isNpc || isPaperdollBody(mob.body) || mob.vocation || mob.role || mob.npcRole || mob.vendorKind
        || mob._listensToSpeech || mob.invulnerable || Array.isArray(mob._greetings)
        || Array.isArray(mob.teaches) || hasVendor(mob.serial) || conversationFor(state, mob)
      ));
    },
    open,
    refreshConversation: (state, mob, dialogue, requestId) => render(state, mob, dialogue, requestId),
    sendPaperdoll,
  });
}
