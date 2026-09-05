// CLI: convert UO MUL/UOP files into PNG atlases + JSON manifests under
// apps/client/public/assets/. One step per asset class. The default
// `--only` list covers *every* extractor module we ship — running with
// no `--only` flag (which is how the Control Panel "Extract" button
// invokes us) reproduces a full client+server asset/content build.
// Use `--only=hues,tiledata,...` to run a narrow subset.
//
//   node packages/extractor/extract.js --src "D:\Games\..." --out apps\client\public\assets [--only hues,tiledata,art,statics,gumps,map,cliloc] [--ktx2]

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractHues }     from './hues.js';
import { extractTiledata } from './tiledata.js';
import { extractArt }      from './art.js';
import { extractGumps }    from './gumps.js';
import { extractMap, extractStatics, FACET_IDS, facetName } from './map.js';
import { extractCliloc } from './cliloc.js';
import { extractSounds } from './sounds.js';
import { extractAnim } from './anim.js';
import { extractMusic } from './music.js';
import { extractMulti } from './multi.js';
import { extractAnimData } from './animdata.js';
import { extractFonts } from './fonts.js';
import { extractTexmaps } from './texmaps.js';
import { extractHouseData } from './housedata.js';
import { extractCursors } from './cursors.js';
import { extractRadarcol } from './radarcol.js';
import { extractLights } from './lights.js';
import { extractVerdata } from './verdata.js';
import { extractProfessions } from './professions.js';
import { extractSpeeches } from './speeches.js';
import { extractMultimap } from './multimap.js';
import { extractUnifont } from './unifont.js';
import { extractServUOBosses } from './servuo-bosses.js';
import { extractServUOFunctional } from './servuo-functional.js';
import { extractServUOItems } from './servuo-items.js';
import { extractServUOMonsters } from './servuo-monsters.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SERVUO_ROOT = join(REPO_ROOT, 'templates', 'ServUO');
// ServUO content extractors write into the canonical data/config and
// data/world trees. They take apps/scripts/src as the common root.
const SCRIPTS_OUT = join(REPO_ROOT, 'apps', 'scripts', 'src');
const CLIENT_ASSET_OUT = resolve(REPO_ROOT, 'apps', 'client', 'public', 'assets');

const args = parseArgs(process.argv.slice(2));
if (!args.src) {
  console.error('usage: extract.js --src <UO-folder> --out <out-dir> [--only h,t,art,...]');
  process.exit(2);
}
const src = resolve(args.src);
const out = resolve(args.out ?? 'apps/client/public/assets');
// Default = every asset extractor we ship — runtime depends on the
// extracted PNG atlases + JSON manifests under apps/client/public/assets.
//
// ServUO content extractors (decoration / xmlspawner / servuo-*) are
// EXPLICITLY OPT-IN now: the JSON files they produce are committed to
// `apps/scripts/src/data/*.json` and are the canonical source the
// server reads at runtime. The extractors only need to run when we
// want to refresh those files against a newer ServUO checkout — they
// are NOT part of the everyday "Extract" cycle, and the app no
// longer depends on templates/ServUO/ being present at all.
// Run via `--only=decoration,xmlspawner,servuo-bosses,...` to refresh.
const DEFAULT_STEPS = [
  // Asset (UO_SRC → apps/client/public/assets)
  'hues', 'tiledata', 'art', 'texmaps', 'gumps', 'cursors',
  'fonts', 'music', 'sounds', 'radarcol',
  'map', 'statics', 'anim', 'animdata', 'multi', 'cliloc', 'housedata',
  // Audit rev.4 P2 — new extractors completing CUO loader parity.
  'lights', 'verdata', 'professions', 'speeches',
  // Audit rev.9 P2 — Multimap.rle + unifont*.mul.
  'multimap', 'unifont',
];

// Optional content-refresh group — listed for documentation only. The
// extractor still accepts these in `--only`; they just don't run when
// the user invokes extract.js with no flag.
const OPTIONAL_SERVUO_REFRESH = [
  'decoration', 'xmlspawner',
  'servuo-bosses', 'servuo-functional', 'servuo-items', 'servuo-monsters',
  'servuo-recipes', 'servuo-vendors', 'servuo-quests', 'servuo-artifacts',
  'servuo-magic-gen', 'servuo-item-types', 'servuo-mobile-types',
];

// Audit rev.4 — `--include-servuo` flag (set by the control-panel
// "+ ServUO" checkbox) appends OPTIONAL_SERVUO_REFRESH to the active
// step set so a single click rebuilds BOTH the UO_SRC assets and the
// apps/scripts/src/data/*.json content files. Without the flag the
// default pass stays asset-only (matches the prior fast workflow).
const baseSteps = args.only
  ? args.only.split(',').map((s) => s.trim()).filter(Boolean)
  : [...DEFAULT_STEPS];
if (args['include-servuo']) {
  for (const s of OPTIONAL_SERVUO_REFRESH) if (!baseSteps.includes(s)) baseSteps.push(s);
}
const only = new Set(baseSteps);

mkdirSync(out, { recursive: true });
console.log(`[extract] src: ${src}`);
console.log(`[extract] out: ${out}`);
console.log(`[extract] steps: ${[...only].join(', ')}`);

const t0 = Date.now();
let any = false;

if (only.has('hues')) {
  const path = join(src, 'hues.mul');
  if (!existsSync(path)) {
    console.warn(`[hues]    skip — ${path} missing`);
  } else {
    const r = await extractHues(path, out);
    console.log(`[hues]    ${r.count} hues → hues.png + hues.json`);
    any = true;
  }
}

if (only.has('tiledata')) {
  const path = join(src, 'tiledata.mul');
  if (!existsSync(path)) {
    console.warn(`[tiledata] skip — ${path} missing`);
  } else {
    const r = await extractTiledata(path, out);
    console.log(`[tiledata] ${r.landCount} lands + ${r.staticCount} statics → tiledata.json`);
    any = true;
  }
}

if (only.has('art')) {
  const uop = join(src, 'artLegacyMUL.uop');
  if (!existsSync(uop)) {
    console.warn(`[art]     skip — ${uop} missing`);
  } else {
    console.log(`[art]     decoding land + static sprites (this is the slowest step)…`);
    await extractArt(src, out);
    console.log(`[art]     done`);
    any = true;
  }
}

if (only.has('texmaps')) {
  const idx = join(src, 'texidx.mul');
  const dat = join(src, 'texmaps.mul');
  if (!existsSync(idx) || !existsSync(dat)) {
    console.warn(`[texmaps] skip — texidx/texmaps missing`);
  } else {
    console.log(`[texmaps] decoding stretched-land textures…`);
    const r = await extractTexmaps(src, out);
    console.log(`[texmaps] ${r.count} unique × ${r.sprites ?? 0} aliased → ${r.pages} atlas page(s) + texmap-atlas.json`);
    any = true;
  }
}

if (only.has('map')) {
  // Walk every canonical facet (0..5) and extract whichever has source files
  // present. Missing facets are silently skipped so users with a slimmed-down
  // UO install (e.g. only Felucca/Trammel) still get a clean run.
  for (const facet of FACET_IDS) {
    const uop = join(src, `map${facet}LegacyMUL.uop`);
    const mul = join(src, `map${facet}.mul`);
    if (!existsSync(uop) && !existsSync(mul)) {
      console.log(`[map]     skip facet ${facet} (${facetName(facet)}) — no source`);
      continue;
    }
    console.log(`[map]     decoding facet ${facet} (${facetName(facet)}) land blocks…`);
    const r = await extractMap(src, out, facet);
    if (r.skipped) console.log(`[map]     facet ${facet} skipped`);
    else { console.log(`[map]     ${r.written}/${r.total} blocks → map${facet}.bin + map${facet}.json`); any = true; }
  }
}

if (only.has('statics')) {
  for (const facet of FACET_IDS) {
    const idx = join(src, `staidx${facet}.mul`);
    const dat = join(src, `statics${facet}.mul`);
    if (!existsSync(idx) || !existsSync(dat)) {
      console.log(`[statics] skip facet ${facet} — staidx${facet}/statics${facet} missing`);
      continue;
    }
    console.log(`[statics] copying facet ${facet} (${facetName(facet)}) statics…`);
    const r = await extractStatics(src, out, facet);
    if (r.skipped) continue;
    console.log(`[statics] facet ${facet}: ${r.blocks} blocks, ${r.datBytes} bytes → staidx${facet}.bin + statics${facet}.bin`);
    any = true;
  }
}

if (only.has('anim')) {
  const mul = join(src, 'anim.mul');
  if (!existsSync(mul)) {
    console.warn(`[anim]    skip — ${mul} missing`);
  } else {
    console.log(`[anim]    decoding complete mobile/equipment animation groups…`);
    const r = await extractAnim(src, out);
    console.log(`[anim]    ${r.count} bodies → ${r.pages} atlas page(s), ${r.shards} metadata shard(s), revision ${r.revision?.slice(0, 12)}`);
    any = true;
  }
}

if (only.has('animdata')) {
  const path = join(src, 'animdata.mul');
  if (!existsSync(path)) {
    console.warn(`[animdata] skip — ${path} missing`);
  } else {
    const r = extractAnimData(src, out);
    console.log(`[animdata] ${r.count} animated statics → animdata.json`);
    any = true;
  }
}

if (only.has('fonts')) {
  const path = join(src, 'fonts.mul');
  if (!existsSync(path)) {
    console.warn(`[fonts]   skip — ${path} missing`);
  } else {
    console.log(`[fonts]   extracting 10 ASCII fonts…`);
    const r = await extractFonts(src, out);
    console.log(`[fonts]   ${r.count} glyphs across ${r.fonts} fonts → fonts.png (${r.atlasW}×${r.atlasH}) + fonts.json`);
    any = true;
  }
}

if (only.has('multi')) {
  const uop = join(src, 'MultiCollection.uop');
  const mul = join(src, 'multi.mul');
  if (!existsSync(uop) && !existsSync(mul)) {
    console.warn(`[multi]   skip — neither MultiCollection.uop nor multi.mul present`);
  } else {
    console.log(`[multi]   decoding multi templates…`);
    const r = await extractMulti(src, out);
    console.log(`[multi]   ${r.count} multis → multi.json`);
    any = true;
  }
}

if (only.has('music')) {
  console.log(`[music]   copying mp3s + parsing Config.txt…`);
  const r = await extractMusic(src, out);
  console.log(`[music]   ${r.copied}/${r.count} tracks copied → music/ + music.json`);
  any = true;
}

if (only.has('sounds')) {
  const uop = join(src, 'soundLegacyMUL.uop');
  if (!existsSync(uop)) {
    console.warn(`[sounds]  skip — ${uop} missing`);
  } else {
    console.log(`[sounds]  decoding sound effects…`);
    const r = await extractSounds(src, out);
    console.log(`[sounds]  ${r.count} sounds, ${(r.totalBytes / (1024*1024)).toFixed(1)} MiB → sounds.bin + sounds.json`);
    any = true;
  }
}

if (only.has('cliloc')) {
  const path = join(src, 'Cliloc.enu');
  if (!existsSync(path)) {
    console.warn(`[cliloc]  skip — ${path} missing`);
  } else {
    const r = await extractCliloc(path, out);
    console.log(`[cliloc]  ${r.count} entries → cliloc.json`);
    any = true;
  }
}

if (only.has('gumps')) {
  const uop = join(src, 'gumpartLegacyMUL.uop');
  if (!existsSync(uop)) {
    console.warn(`[gumps]   skip — ${uop} missing`);
  } else {
    console.log(`[gumps]   decoding gump sprites…`);
    await extractGumps(src, out);
    console.log(`[gumps]   done`);
    any = true;
  }
}

if (only.has('radarcol')) {
  // 65 536 × u16 ARGB1555 palette for minimap / world-map tile colours.
  // Tiny output (~256 KB JSON) but the difference vs our placeholder
  // colour table is night-and-day on the minimap gump.
  const path = join(src, 'radarcol.mul');
  if (!existsSync(path)) {
    console.warn(`[radarcol] skip — ${path} missing`);
  } else {
    const r = await extractRadarcol(src, out);
    console.log(`[radarcol] ${r.count} entries (${r.landCount} land + ${r.count - r.landCount} static) → radarcol.json`);
    any = true;
  }
}

if (only.has('lights')) {
  // Audit rev.4 P2 — light.mul + lightidx.mul → lights.json. Per-static
  // light emission masks (~100 entries, ~50 KB). Client glues to
  // tile-renderer for torches / lava / sconces / brazier glow.
  console.log(`[lights]   decoding light emission masks…`);
  const r = extractLights(src, out);
  if (r.skipped) console.warn(`[lights]   skip — light.mul / lightidx.mul missing`);
  else { console.log(`[lights]   ${r.count} lights → lights.json`); any = true; }
}

if (only.has('verdata')) {
  // Audit rev.4 P2 — verdata.mul → verdata.json + patches.json schema
  // extension. Verdata holds shard-side patches for art / gump / multi
  // / hue records that override the base .mul. We expose it as a JSON
  // manifest with per-resource override blobs the client can apply.
  console.log(`[verdata]  decoding shard patch container…`);
  const r = extractVerdata(src, out);
  if (r.skipped) console.warn(`[verdata]  skip — verdata.mul missing`);
  else { console.log(`[verdata]  ${r.count} patches → verdata.json`); any = true; }
}

if (only.has('professions')) {
  // Audit rev.4 P2 — Prof.txt → professions.json. Char-creation preset
  // classes (skill / stat defaults per profession). CUO ProfessionLoader.
  console.log(`[prof]     parsing Prof.txt profession trees…`);
  const r = extractProfessions(src, out);
  if (r.skipped) console.warn(`[prof]     skip — Prof.txt missing`);
  else { console.log(`[prof]     ${r.count} professions → professions.json`); any = true; }
}

if (only.has('speeches')) {
  // Audit rev.4 P2 — speech.mul → speeches.json. NPC vendor keyword
  // triggers (server-AI consumes; rarely client-side but cheap to ship).
  console.log(`[speech]   decoding NPC speech keyword table…`);
  const r = extractSpeeches(src, out);
  if (r.skipped) console.warn(`[speech]   skip — speech.mul missing`);
  else { console.log(`[speech]   ${r.count} entries → speeches.json`); any = true; }
}

if (only.has('multimap')) {
  // Audit rev.9 P2 — Multimap.rle (worldmap-overview grayscale) →
  // multimap.png + multimap.json. Used by the world-map gump as a
  // backdrop and by future house/boat-placement preview.
  console.log(`[multimap] decoding world-overview RLE…`);
  const r = await extractMultimap(src, out);
  if (r.skipped) console.warn(`[multimap] skip — Multimap.rle missing (${r.reason ?? 'not found'})`);
  else { console.log(`[multimap] ${r.w}×${r.h} (peak intensity ${r.max}) → multimap.png + multimap.json`); any = true; }
}

if (only.has('unifont')) {
  // Audit rev.9 P2 — unifont0..unifont19.mul (CJK glyph banks) →
  // unifont-N.png per file + unifont.json manifest. Shards with
  // Asian-community clients (Japan / Korea / China) need these for
  // 0xAE UnicodeSpeech rendering.
  console.log(`[unifont]  decoding CJK glyph banks…`);
  const r = await extractUnifont(src, out);
  if (r.skipped) console.warn(`[unifont]  skip — no unifont*.mul present`);
  else { console.log(`[unifont]  ${r.count} font(s), ${r.total} glyphs → unifont-N.png + unifont.json`); any = true; }
}

if (only.has('cursors')) {
  // Cursor sprites live in art.mul (pre-AOS block) AND optionally in
  // gump.mul (AOS theme). We pull both and pack into a single small
  // 256×256 atlas with named entries (walk-n / target-neutral / etc).
  // The client overlays our DOM cursor div from these.
  const artUop  = join(src, 'artLegacyMUL.uop');
  const gumpUop = join(src, 'gumpartLegacyMUL.uop');
  if (!existsSync(artUop) && !existsSync(gumpUop)) {
    console.warn(`[cursors] skip — neither art.uop nor gump.uop present`);
  } else {
    console.log(`[cursors] pulling cursor sprites from art + gump UOPs…`);
    const r = await extractCursors(src, out);
    console.log(`[cursors] ${r.count} cursors → cursors-atlas.png + cursors.json`);
    any = true;
  }
}

if (only.has('housedata')) {
  // walls/doors/floors/stairs/roof/misc/teleprts. Each file is independent;
  // extractor logs warnings per missing file and emits whatever it found.
  const r = await extractHouseData(src, out);
  const summary = Object.entries(r.totals)
    .map(([k, v]) => `${k}=${v.categories}c/${v.styles}s`).join(' ');
  console.log(`[housedata] ${summary} → housedata.json`);
  any = true;
}

// ---- ServUO content extractors -------------------------------------------
// These read from `templates/ServUO/` (in-repo) and write JSON catalogues
// under `apps/scripts/src/data/`. They don't depend on UO_SRC. Skipped
// silently when the ServUO checkout isn't present (some installs only
// pull client mul/uop and run a slim shard).

const servUOAvailable = existsSync(SERVUO_ROOT);
if (!servUOAvailable && only.size > 0) {
  // Only warn once if at least one ServUO step was requested.
  const needsServUO = OPTIONAL_SERVUO_REFRESH.some((step) => only.has(step));
  if (needsServUO) {
    console.warn(`[content] skip ServUO content steps — ${SERVUO_ROOT} missing`);
  }
}

if (servUOAvailable && only.has('servuo-bosses')) {
  const r = await extractServUOBosses(SERVUO_ROOT, SCRIPTS_OUT);
  console.log(`[servuo-bosses] +${r.added}/${r.scanned} new (total ${r.total}) → apps/scripts/src/data/config/monsters.json`);
  any = true;
}

if (servUOAvailable && only.has('servuo-functional')) {
  const r = await extractServUOFunctional(SERVUO_ROOT, SCRIPTS_OUT);
  console.log(`[servuo-functional] +${r.added}/${r.scanned} new (total ${r.total}) → apps/scripts/src/data/config/items.json`);
  any = true;
}

if (servUOAvailable && only.has('servuo-items')) {
  const r = await extractServUOItems(SERVUO_ROOT, SCRIPTS_OUT);
  console.log(`[servuo-items] +${r.added}/${r.scanned} new (total ${r.total}) → apps/scripts/src/data/config/items.json`);
  any = true;
}

if (servUOAvailable && only.has('servuo-monsters')) {
  const r = await extractServUOMonsters(SERVUO_ROOT, SCRIPTS_OUT);
  console.log(`[servuo-monsters] +${r.added}/${r.parsed} (scanned ${r.scanned}, total ${r.total}) → apps/scripts/src/data/config/monsters.json`);
  any = true;
}

// The remaining script-style extractors have a top-level CLI body and no
// exported entry point — invoking them as subprocesses keeps the
// scripts self-contained while still letting the Control Panel
// "Extract" button drive a full content rebuild.
const childFailures = [];
function runChildScript(step, scriptPath, extraArgs = [], options = {}) {
  const child = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (child.status === 0) {
    if (options.produced !== false) any = true;
    return true;
  }
  childFailures.push(step);
  console.warn(`[${step}] failed (exit ${child.status ?? child.signal ?? '?'})`);
  return false;
}

if (servUOAvailable && only.has('decoration')) {
  runChildScript('decoration', join(HERE, 'decoration.js'));
}
if (servUOAvailable && only.has('xmlspawner')) {
  runChildScript('xmlspawner', join(HERE, 'xmlspawner.js'));
}
if (servUOAvailable && only.has('servuo-recipes')) {
  runChildScript('servuo-recipes', join(HERE, 'servuo-recipes.js'));
}
if (servUOAvailable && only.has('servuo-vendors')) {
  runChildScript('servuo-vendors', join(HERE, 'servuo-vendors.js'));
}
if (servUOAvailable && only.has('servuo-quests')) {
  runChildScript('servuo-quests', join(HERE, 'servuo-quests.js'));
}
if (servUOAvailable && only.has('servuo-artifacts')) {
  runChildScript('servuo-artifacts', join(HERE, 'servuo-artifacts.js'));
}
if (servUOAvailable && only.has('servuo-magic-gen')) {
  runChildScript('servuo-magic-gen', join(HERE, 'servuo-magic-gen.js'));
}
if (servUOAvailable && only.has('servuo-item-types')) {
  runChildScript('servuo-item-types', join(HERE, 'servuo-item-types.js'));
}
if (servUOAvailable && only.has('servuo-mobile-types')) {
  runChildScript('servuo-mobile-types', join(HERE, 'servuo-mobile-types.js'));
}

if (childFailures.length) {
  console.error(`[extract] failed child importers: ${childFailures.join(', ')}`);
  process.exit(1);
}

if (args.ktx2 || only.has('ktx2')) {
  const extraArgs = ['--out', out];
  if (args['ktx2-force']) extraArgs.push('--force');
  if (args['ktx2-dry-run']) extraArgs.push('--dry-run');
  if (args['ktx2-only']) extraArgs.push('--only', args['ktx2-only']);
  if (args['ktx2-toktx']) extraArgs.push('--toktx', args['ktx2-toktx']);
  if (args['ktx2-zcmp']) extraArgs.push('--zcmp', args['ktx2-zcmp']);
  const ok = runChildScript('ktx2', join(HERE, 'ktx2.js'), extraArgs, {
    produced: !args['ktx2-dry-run'],
  });
  if (!ok) process.exit(1);
}

// Bump the service-worker cache version so the browser drops every
// cached atlas PNG from this extraction's predecessor. Without this
// the browser kept serving stale `mobiles-atlas-*.png` against a fresh
// `mobiles-atlas.json` — frame rectangles pointed into pages whose
// pixels were laid out by the OLD packer, producing the
// "garbled/multi-frame overlap" sprite the user reported.
if (any && out === CLIENT_ASSET_OUT) {
  try {
    const swPath = join(REPO_ROOT, 'apps', 'client', 'public', 'sw.js');
    if (existsSync(swPath)) {
      const sw = readFileSync(swPath, 'utf8');
      const cacheVersion = `uo-assets-v${Date.now()}`;
      const published = sw.replace(
        /const CACHE_VERSION = 'uo-assets-v[^']*';/,
        `const CACHE_VERSION = '${cacheVersion}';`,
      );
      if (published !== sw) {
        writeFileSync(swPath, published);
        console.log(`[sw]      cache version bumped — ${cacheVersion}`);
      }
    }
  } catch (e) {
    console.warn(`[sw]      skip cache-version bump: ${e.message}`);
  }
}

if (!any && !args['ktx2-dry-run']) {
  console.error('[extract] nothing produced — check your --only or --src');
  process.exit(1);
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[extract] done in ${dt}s`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    out[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return out;
}
