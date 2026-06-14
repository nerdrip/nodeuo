// [props — text dump every gameplay-relevant prop on the targeted item
// or mobile. Mirrors ServUO `Props.cs` admin command (the gump form is
// deferred — text dump covers GM debugging needs without the gump
// build-out). For a structured editor see [edititem.

import { resolveItemOrMobileArg } from '../_targeting-helpers.js';

const SKIP_KEYS = new Set([
  'client',         // runtime ws ref — sensitive + huge
  'sectors',        // back-ref into world
  '_castTimer', '_walkQueue', '_dragOffset',
  '_huePalettes',   // Map of arrays — too noisy
]);

function fmtVal(v, depth = 0) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'function') return '<fn>';
  if (typeof v === 'number') return v >= 0x10000 ? `0x${v.toString(16)}` : String(v);
  if (typeof v === 'string') return v.length > 60 ? JSON.stringify(v.slice(0, 60)) + '…' : JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Set) return `Set(${v.size})`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (Array.isArray(v)) {
    if (depth > 0) return `Array(${v.length})`;
    return v.length > 4 ? `[${v.slice(0, 4).map((x) => fmtVal(x, depth + 1)).join(', ')} …(${v.length})]`
                        : `[${v.map((x) => fmtVal(x, depth + 1)).join(', ')}]`;
  }
  if (typeof v === 'object') {
    if (depth > 0) return `Object(${Object.keys(v).length})`;
    const keys = Object.keys(v).slice(0, 6);
    return `{${keys.map((k) => `${k}: ${fmtVal(v[k], depth + 1)}`).join(', ')}${Object.keys(v).length > 6 ? ', …' : ''}}`;
  }
  return String(v);
}

export default function (api) {
  const { commands } = api;

  commands.register({
    name: 'props',
    help: 'Dump every property of the targeted item or mobile.',
    access: 'GameMaster',
    run: (ctx) => {
      resolveItemOrMobileArg(api, ctx, 0, (picked) => {
        if (!picked) return;
        const obj = picked.ref;
        const lines = [
          `--- ${picked.kind} 0x${(obj.serial >>> 0).toString(16).padStart(8, '0')} ---`,
        ];
        const keys = Object.keys(obj).sort();
        for (const k of keys) {
          if (SKIP_KEYS.has(k)) continue;
          if (k.startsWith('_') && k.length > 1 && /^[A-Z]/.test(k[1])) continue; // _internal-Camel skipped
          lines.push(`  ${k}: ${fmtVal(obj[k])}`);
        }
        for (const ln of lines) ctx.state.sendSystemMessage(ln);
      });
    },
  });

  return () => commands.unregister('props');
}
