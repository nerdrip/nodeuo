// Named NPCs — Britannia lore characters. Mirrors ServUO's
// `Mobiles/Named/*.cs` for the canonical heroes / villains plus the
// pre-Age-of-Shadows quest-givers. Each entry has:
//
//   name, body, hue, role (king/healer/blacksmith/...), city,
//   default outfit, optional `says[]` greeting lines, behaviour
//   (banker / trainer / vendor / town-crier — reuses our existing
//   per-role scripts).
//
// Spawn via `[spawnnamed <id>` (GM only). Lore characters never tick AI
// movement — they stand on assigned coords like ServUO's static spawns.

import { spawnNPC } from './_spawn.js';
import { allMobiles } from '../../_spatial.js';

const NAMED = {
  // ============ Britain — royal court ============
  'lord-british': {
    name: 'Lord British',
    body: 0x190, hue: 0x0083,
    role: 'king',
    outfit: 'noble',
    notoriety: 7,                // invulnerable yellow
    city: 'Britain',
    says: ['Welcome, traveller, to the realm of Britannia.', 'Justice and Honor light your path.'],
  },
  'lord-blackthorn': {
    name: 'Lord Blackthorn',
    body: 0x190, hue: 0x0497,
    role: 'noble',
    outfit: 'noble',
    notoriety: 7,
    city: 'Britain',
    says: ['Power must be wielded with purpose.'],
  },
  'sage-mariah': {
    name: 'Mariah',
    body: 0x191, hue: 0x056F,
    role: 'mage',
    outfit: 'mage',
    notoriety: 7,
    city: 'Moonglow',
    says: ['The arcane arts demand a keen mind.', 'Truth, found in study, illuminates all.'],
  },
  'shamino': {
    name: 'Shamino',
    body: 0x190, hue: 0x03A4,
    role: 'ranger',
    outfit: 'warrior',
    notoriety: 7,
    city: 'Skara Brae',
    says: ['The forest knows secrets we forget.', 'Tread softly.'],
  },
  'iolo': {
    name: 'Iolo',
    body: 0x190, hue: 0x041D,
    role: 'bard',
    outfit: 'peasant',
    notoriety: 7,
    city: 'Britain',
    says: ['A song lifts the heaviest burden, friend.'],
  },
  'dupre': {
    name: 'Dupre',
    body: 0x190, hue: 0x0497,
    role: 'paladin',
    outfit: 'warrior',
    notoriety: 7,
    city: 'Trinsic',
    says: ['Honor before all.', 'The Code of Chivalry is no mere ornament.'],
  },
  'geoffrey': {
    name: 'Geoffrey',
    body: 0x190, hue: 0x0021,
    role: 'fighter',
    outfit: 'warrior',
    notoriety: 7,
    city: 'Jhelom',
    says: ['Train hard. The blade will repay your sweat.'],
  },
  'jaana': {
    name: 'Jaana',
    body: 0x191, hue: 0x041D,
    role: 'druid',
    outfit: 'mage',
    notoriety: 7,
    city: 'Yew',
    says: ['The roots remember what kings forget.'],
  },
  'julia': {
    name: 'Julia',
    body: 0x191, hue: 0x083A,
    role: 'tinker',
    outfit: 'peasant',
    notoriety: 7,
    city: 'Minoc',
    says: ['Brass and bronze, friend, brass and bronze.'],
  },
  'katrina': {
    name: 'Katrina',
    body: 0x191, hue: 0x041F,
    role: 'shepherd',
    outfit: 'peasant',
    notoriety: 7,
    city: 'New Magincia',
    says: ['Humility teaches what pride can never grasp.'],
  },

  // ============ Counsellors of Virtue ============
  'gilforn': {
    name: 'Gilforn the Sage',
    body: 0x190, hue: 0x055D,
    role: 'mage', outfit: 'mage', notoriety: 7,
    city: 'Moonglow',
    says: ['Knowledge is the candle, wisdom the flame.'],
  },
  'nostro': {
    name: 'Nostro',
    body: 0x190, hue: 0x002D,
    role: 'healer', outfit: 'mage', notoriety: 7,
    city: 'Britain',
    says: ['Healing comes from compassion, not compulsion.'],
  },

  // ============ Villains / morally-grey lore figures ============
  'minax': {
    name: 'Minax',
    body: 0x191, hue: 0x0496,
    role: 'witch', outfit: 'mage', notoriety: 6,
    city: 'Felucca-Brit',
    says: ['Bow, mortals. Or burn.'],
  },
  'mondain': {
    name: 'Mondain',
    body: 0x190, hue: 0x0496,
    role: 'lich', outfit: 'mage', notoriety: 6,
    city: 'Hythloth',
    says: ['Your soul. Now.'],
  },
  'exodus': {
    name: 'Exodus',
    body: 0x190, hue: 0x0481,
    role: 'construct', outfit: 'mage', notoriety: 6,
    city: 'Tokuno',
    says: ['ERROR: HUMAN DETECTED. PURGE INITIATED.'],
  },

  // ============ Town-specific service NPCs ============
  'haran-the-banker': {
    name: 'Haran',
    body: 0x190, hue: 0x0388,
    role: 'banker', outfit: 'noble', notoriety: 7,
    city: 'Britain',
    behavior: 'banker',
    says: ['Banking, my friend?', 'Say "bank" and I shall open your vault.'],
  },
  'vesper-banker-anya': {
    name: 'Anya',
    body: 0x191, hue: 0x041F,
    role: 'banker', outfit: 'noble', notoriety: 7,
    city: 'Vesper',
    behavior: 'banker',
    says: ['Welcome to the Vesper bank.'],
  },
  'minoc-blacksmith-grenn': {
    name: 'Grenn',
    body: 0x190, hue: 0x0846,
    role: 'blacksmith', outfit: 'warrior', notoriety: 7,
    city: 'Minoc',
    behavior: 'trainer',
    teaches: ['Blacksmithy', 'Mining'],
    says: ['Forge a finer blade today than yesterday.'],
  },
  'yew-tailor-meranna': {
    name: 'Meranna',
    body: 0x191, hue: 0x047F,
    role: 'tailor', outfit: 'peasant', notoriety: 7,
    city: 'Yew',
    behavior: 'trainer',
    teaches: ['Tailoring', 'Cooking'],
    says: ['Cloth tells a story, lad. Each thread.'],
  },
  'trinsic-paladin-tristan': {
    name: 'Sir Tristan',
    body: 0x190, hue: 0x0497,
    role: 'paladin', outfit: 'warrior', notoriety: 7,
    city: 'Trinsic',
    behavior: 'trainer',
    teaches: ['Chivalry', 'Tactics', 'Swordsmanship'],
    says: ['Defend the weak. Honor binds us.'],
  },
  'skara-brae-bard-callum': {
    name: 'Callum the Singer',
    body: 0x190, hue: 0x044F,
    role: 'bard', outfit: 'peasant', notoriety: 7,
    city: 'Skara Brae',
    behavior: 'trainer',
    teaches: ['Musicianship', 'Provocation', 'Peacemaking'],
    says: ['A pleasant tune, traveller?'],
  },
  'magincia-mage-elara': {
    name: 'Elara the Wise',
    body: 0x191, hue: 0x055D,
    role: 'mage', outfit: 'mage', notoriety: 7,
    city: 'New Magincia',
    behavior: 'trainer',
    teaches: ['Magery', 'Meditation', 'EvalIntelligence'],
    says: ['Pride was our undoing once. Be humble.'],
  },
  'britain-healer-finna': {
    name: 'Finna',
    body: 0x191, hue: 0x002D,
    role: 'healer', outfit: 'mage', notoriety: 7,
    city: 'Britain',
    behavior: 'healer',
    says: ['Hold still, your wounds will close.'],
  },

  // ============ Malas — Sphynx (fortune-telling NPC) ============
  // ServUO `Mobiles/Sphinx.cs` reads the player's gold and offers a
  // fortune for 1000gp. Our `says` rotation gives one of several
  // proverbs; the actual gold-take + virtue-roll happens via the
  // shared "fortune" speech keyword the ambient-tick handler picks up.
  'sphynx-of-malas': {
    name: 'The Sphynx',
    body: 0x32D, hue: 0x0,                  // sphynx body
    role: 'oracle', outfit: 'naked', notoriety: 7,
    city: 'Malas',
    behavior: 'oracle',
    says: [
      'Speak the word "fortune" and I shall tell yours.',
      'The dust of ages settles on all who pass.',
      'Riddles guard truths from idle ears.',
    ],
  },

  // ============ Heartwood (ML expansion) ============
  'arielle-the-arborist': {
    name: 'Arielle',
    body: 0x25E, hue: 0x847A,
    role: 'arborist', outfit: 'elf-druid', notoriety: 7,
    city: 'Heartwood',
    behavior: 'quest-giver',
    says: ['The forest remembers every footstep.'],
  },
  'walker-of-the-heartwood': {
    name: 'Walker',
    body: 0x25D, hue: 0x842B,
    role: 'guide', outfit: 'elf-ranger', notoriety: 7,
    city: 'Heartwood',
    behavior: 'quest-giver',
    says: ['The trails I know would tire even an elf.'],
  },
  'gwenno-elven-bard': {
    name: 'Gwenno',
    body: 0x25E, hue: 0x842C,
    role: 'bard', outfit: 'elf-bard', notoriety: 7,
    city: 'Heartwood',
    says: ['Sing with me, traveller — songs warm cold hearts.'],
  },

  // ============ Sanctuary (Despise revamp) ============
  'andros-the-sanctuary-warden': {
    name: 'Andros',
    body: 0x190, hue: 0x0481,
    role: 'warden', outfit: 'paladin', notoriety: 7,
    city: 'Sanctuary',
    says: ['Light prevails — but only with vigilance.'],
  },

  // ============ Stygian Abyss / Ter Mur ============
  'high-mage-apollo': {
    name: 'High Mage Apollo',
    body: 0x29A, hue: 0x86F,                // gargoyle female mage
    role: 'mage', outfit: 'gargoyle-mage', notoriety: 7,
    city: 'Royal City',
    behavior: 'quest-giver',
    says: ['Three trials stand between you and the throne.'],
  },
  'queen-zhah': {
    name: 'Queen Zhah',
    body: 0x29A, hue: 0x86E,
    role: 'royal', outfit: 'gargoyle-royal', notoriety: 7,
    city: 'Royal City',
    says: ['The Gargish people endure. So shall we.'],
  },
  'naxatilor-the-seer': {
    name: 'Naxatilor',
    body: 0x29A, hue: 0x86A,
    role: 'seer', outfit: 'gargoyle-mage', notoriety: 7,
    city: 'Royal City',
    says: ['I see what was and shall be.'],
  },

  // ============ Tokuno Islands ============
  'master-bushi-akira': {
    name: 'Master Akira',
    body: 0x190, hue: 0x041E,
    role: 'samurai', outfit: 'samurai', notoriety: 7,
    city: 'Zento',
    says: ['Discipline is the path. Skill is its reward.'],
  },
  'ninja-shogo': {
    name: 'Shogo',
    body: 0x190, hue: 0x0481,
    role: 'ninja', outfit: 'ninja', notoriety: 7,
    city: 'Homare-Jima',
    says: ['Shadows hide what walks beneath them.'],
  },

  // ============ Khaldun / lost cities ============
  'haven-elder-thomas': {
    name: 'Elder Thomas',
    body: 0x190, hue: 0x0481,
    role: 'elder', outfit: 'robed', notoriety: 7,
    city: 'Haven',
    behavior: 'quest-giver',
    says: ['Khaldun calls again — its nightmare must be quieted.'],
  },
  'underworld-scholar-vanya': {
    name: 'Scholar Vanya',
    body: 0x191, hue: 0x044E,
    role: 'scholar', outfit: 'mage', notoriety: 7,
    city: 'Underworld',
    behavior: 'quest-giver',
    says: ['Below us lies a maze that swallows the unwary.'],
  },

  // ============ Naturalist quest giver ============
  'naturalist-aldur': {
    name: 'Aldur',
    body: 0x190, hue: 0x0481,
    role: 'naturalist', outfit: 'ranger', notoriety: 7,
    city: 'Yew',
    behavior: 'quest-giver',
    says: ['Britannia is alive with wonders — I aim to catalogue them all.'],
  },

  // ============ Bedlam / mind ============
  'bedlam-watcher-galen': {
    name: 'Watcher Galen',
    body: 0x190, hue: 0x047E,
    role: 'guard', outfit: 'guard', notoriety: 7,
    city: 'Bedlam',
    behavior: 'quest-giver',
    says: ['Bedlam corrupts even the strongest mind. Tread lightly.'],
  },

  // ============ Tomb of Kings ============
  'tok-archivist-baruk': {
    name: 'Baruk the Archivist',
    body: 0x29A, hue: 0x86B,
    role: 'archivist', outfit: 'gargoyle-scholar', notoriety: 7,
    city: 'Tomb of Kings',
    behavior: 'quest-giver',
    says: ['Each stone remembers a king. Pay them respect.'],
  },

  // ============ Heartwood batch 2 ============
  'sarakki-the-arcanist': {
    name: 'Sarakki',
    body: 0x25E, hue: 0x842D,
    role: 'mage', outfit: 'elf-mage', notoriety: 7,
    city: 'Heartwood', behavior: 'quest-giver',
    says: ['The arcane Web binds all living things.'],
  },
  'aulan-the-fletcher': {
    name: 'Aulan',
    body: 0x25D, hue: 0x842E,
    role: 'fletcher', outfit: 'elf-ranger', notoriety: 7,
    city: 'Heartwood', behavior: 'vendor',
    says: ['Yew bends true. Bloodwood remembers blood.'],
  },
  'sinain-the-bowyer': {
    name: 'Sinain',
    body: 0x25E, hue: 0x842F,
    role: 'bowyer', outfit: 'elf-bard', notoriety: 7,
    city: 'Heartwood', behavior: 'vendor',
    says: ['I string only by moonlight.'],
  },
  'rissin-the-tailor': {
    name: 'Rissin',
    body: 0x25E, hue: 0x8430,
    role: 'tailor', outfit: 'elf-noble', notoriety: 7,
    city: 'Heartwood', behavior: 'vendor',
    says: ['Spined leather costs more — but lasts forever.'],
  },

  // ============ Royal City (Ter Mur) batch 2 ============
  'kerinaffi-the-armorer': {
    name: 'Kerinaffi',
    body: 0x29A, hue: 0x88E,
    role: 'armorer', outfit: 'gargoyle-armorer', notoriety: 7,
    city: 'Royal City', behavior: 'vendor',
    says: ['Gargish armor turns more than steel.'],
  },
  'velkkanu-the-imbuer': {
    name: 'Velkkanu',
    body: 0x29A, hue: 0x86D,
    role: 'imbuer', outfit: 'gargoyle-mage', notoriety: 7,
    city: 'Royal City', behavior: 'trainer',
    says: ['The art of imbuing was born here. Pay attention.'],
  },
  'dafdal-the-stoneworker': {
    name: 'Dafdal',
    body: 0x29A, hue: 0x86C,
    role: 'mason', outfit: 'gargoyle-craft', notoriety: 7,
    city: 'Royal City', behavior: 'vendor',
    says: ['Stone is patient. So am I.'],
  },
  'ka-zhel-the-merchant': {
    name: 'Ka-zhel',
    body: 0x29A, hue: 0x86F,
    role: 'merchant', outfit: 'gargoyle-noble', notoriety: 7,
    city: 'Royal City', behavior: 'vendor',
    says: ['Trade flourishes when the borders are quiet.'],
  },

  // ============ Tokuno batch 2 ============
  'naoko-the-tailoress': {
    name: 'Naoko',
    body: 0x191, hue: 0x041C,
    role: 'tailor', outfit: 'noble', notoriety: 7,
    city: 'Zento', behavior: 'vendor',
    says: ['Silk flows like water — touch it gently.'],
  },
  'kentaro-the-swordsmith': {
    name: 'Kentaro',
    body: 0x190, hue: 0x041E,
    role: 'blacksmith', outfit: 'samurai', notoriety: 7,
    city: 'Zento', behavior: 'vendor',
    says: ['A katana is balance forged in fire.'],
  },
  'hisako-the-mage': {
    name: 'Hisako',
    body: 0x191, hue: 0x041F,
    role: 'mage', outfit: 'mage', notoriety: 7,
    city: 'Makoto-Jima', behavior: 'trainer',
    says: ['Mysticism runs deeper than Magery in these isles.'],
  },
  'genshu-the-bonsai-master': {
    name: 'Genshu',
    body: 0x190, hue: 0x0420,
    role: 'gardener', outfit: 'noble', notoriety: 7,
    city: 'Makoto-Jima', behavior: 'quest-giver',
    says: ['Patience grows the smallest tree.'],
  },

  // ============ Britannia city guildmasters ============
  'master-armorer-bohran': {
    name: 'Bohran',
    body: 0x190, hue: 0x041D,
    role: 'guildmaster-armorer', outfit: 'guild', notoriety: 7,
    city: 'Britain', behavior: 'trainer',
    says: ['The Smiths\' Guild welcomes apprentices of true mettle.'],
  },
  'master-tailor-aluna': {
    name: 'Aluna',
    body: 0x191, hue: 0x041D,
    role: 'guildmaster-tailor', outfit: 'guild', notoriety: 7,
    city: 'Vesper', behavior: 'trainer',
    says: ['Stitch with intent. Sloppy seams shame the Guild.'],
  },
  'master-mage-celeste': {
    name: 'Celeste',
    body: 0x191, hue: 0x0481,
    role: 'guildmaster-mage', outfit: 'mage', notoriety: 7,
    city: 'Moonglow', behavior: 'trainer',
    says: ['The Magus Mark is earned, not given.'],
  },
  'master-thief-tharin': {
    name: 'Tharin',
    body: 0x190, hue: 0x047F,
    role: 'guildmaster-thief', outfit: 'bandit', notoriety: 7,
    city: 'Britain', behavior: 'trainer',
    says: ['Quiet feet, quick hands. That is all you need to know.'],
  },
  'master-bard-corwin': {
    name: 'Corwin',
    body: 0x190, hue: 0x044E,
    role: 'guildmaster-bard', outfit: 'bard', notoriety: 7,
    city: 'Britain', behavior: 'trainer',
    says: ['Play with your heart and the beast will listen.'],
  },
  'master-ranger-fairin': {
    name: 'Fairin',
    body: 0x190, hue: 0x04AD,
    role: 'guildmaster-ranger', outfit: 'ranger', notoriety: 7,
    city: 'Yew', behavior: 'trainer',
    says: ['The wilderness has its own etiquette.'],
  },

  // ============ Khaldun / lost cities batch 2 ============
  'archaeologist-thom': {
    name: 'Thom',
    body: 0x190, hue: 0x041C,
    role: 'archaeologist', outfit: 'robed', notoriety: 7,
    city: 'Khaldun', behavior: 'quest-giver',
    says: ['Every brick of Khaldun whispers a curse.'],
  },
  'spelunker-merilda': {
    name: 'Merilda',
    body: 0x191, hue: 0x047D,
    role: 'explorer', outfit: 'ranger', notoriety: 7,
    city: 'Khaldun', behavior: 'quest-giver',
    says: ['The deeper you dig, the louder they answer.'],
  },

  // ============ Bedlam batch 2 ============
  'asylum-keeper-vana': {
    name: 'Vana',
    body: 0x191, hue: 0x0481,
    role: 'keeper', outfit: 'guard', notoriety: 7,
    city: 'Bedlam', behavior: 'quest-giver',
    says: ['Mad Mage Estaryn is not raving. Listen carefully.'],
  },

  // ============ Magincia (post-invasion) ============
  'magincia-quartermaster-perissa': {
    name: 'Perissa',
    body: 0x191, hue: 0x044E,
    role: 'quartermaster', outfit: 'noble', notoriety: 7,
    city: 'New Magincia', behavior: 'vendor',
    says: ['Welcome to New Magincia. Rebuilding never ends.'],
  },
  'magincia-bard-edgar': {
    name: 'Edgar',
    body: 0x190, hue: 0x0481,
    role: 'bard', outfit: 'bard', notoriety: 7,
    city: 'New Magincia', behavior: 'storyteller',
    says: ['I once sang in old Magincia. The acoustics were better.'],
  },

  // ============ Skara Brae rangers ============
  'skara-treasurer-ardin': {
    name: 'Ardin',
    body: 0x190, hue: 0x041E,
    role: 'treasurer', outfit: 'noble', notoriety: 7,
    city: 'Skara Brae', behavior: 'vendor',
    says: ['Coinage, ledgers, and quiet sums.'],
  },
  'skara-ranger-velja': {
    name: 'Velja',
    body: 0x191, hue: 0x04AD,
    role: 'ranger', outfit: 'ranger', notoriety: 7,
    city: 'Skara Brae', behavior: 'trainer',
    says: ['Track quietly. The forest forgives no clumsy feet.'],
  },

  // ============ Trinsic paladins ============
  'paladin-instructor-galen': {
    name: 'Galen',
    body: 0x190, hue: 0x0481,
    role: 'paladin', outfit: 'paladin', notoriety: 7,
    city: 'Trinsic', behavior: 'trainer',
    says: ['Honor is not a creed — it is a discipline.'],
  },
  'sister-of-the-shrine-iolanthe': {
    name: 'Iolanthe',
    body: 0x191, hue: 0x041D,
    role: 'priestess', outfit: 'robed', notoriety: 7,
    city: 'Trinsic', behavior: 'healer',
    says: ['The Shrine of Honor is always open.'],
  },

  // ============ Faction commanders ============
  'truebrits-commander-roland': {
    name: 'Sir Roland',
    body: 0x190, hue: 0x041E,
    role: 'commander', outfit: 'paladin', notoriety: 7,
    city: 'Britain', behavior: 'faction-leader',
    faction: 'truebrits',
    says: ['For the True Britannian crown!'],
  },
  'minax-commander-vexis': {
    name: 'Vexis',
    body: 0x191, hue: 0x0026,
    role: 'commander', outfit: 'noble', notoriety: 7,
    city: 'Hidden Vale', behavior: 'faction-leader',
    faction: 'minax',
    says: ['Minax\'s shadow falls on every throne.'],
  },
  'shadowlords-commander-mortis': {
    name: 'Mortis',
    body: 0x190, hue: 0x0001,
    role: 'commander', outfit: 'necro', notoriety: 7,
    city: 'Buccaneer\'s Den', behavior: 'faction-leader',
    faction: 'shadowlords',
    says: ['The Lords of Shadow await your obedience.'],
  },
  'council-commander-arlina': {
    name: 'Arlina',
    body: 0x191, hue: 0x0030,
    role: 'commander', outfit: 'mage', notoriety: 7,
    city: 'Moonglow', behavior: 'faction-leader',
    faction: 'council',
    says: ['The Council guards what blood and iron cannot.'],
  },
};

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'spawnnamed',
    help: '[spawnnamed <id> — spawn a named NPC at your feet (GM only).',
    access: 'GameMaster',
    run(ctx) {
      const id = String(ctx.args[0] ?? '').toLowerCase();
      const cfg = NAMED[id];
      if (!cfg) {
        ctx.state.sendSystemMessage(`Unknown named NPC '${id}'. Try one of: ${Object.keys(NAMED).slice(0, 6).join(', ')}…`);
        return;
      }
      const mob = spawnNPC(api, ctx.sender, {
        name: cfg.name,
        body: cfg.body,
        hue: cfg.hue ?? 0,
        notoriety: cfg.notoriety ?? 7,
        invulnerable: (cfg.notoriety ?? 7) === 7,
        kind: cfg.role,
        outfit: cfg.outfit,
        keywords: cfg.behavior === 'banker' ? ['bank', 'balance']
                : cfg.behavior === 'trainer' ? ['train', 'help', 'learn']
                : null,
        behavior: cfg.behavior,
        fields: { teaches: cfg.teaches, _city: cfg.city, _greetings: cfg.says },
      });
      if (mob) ctx.state.sendSystemMessage(`Spawned ${cfg.name}.`);
    },
  });

  // List command for content-authoring convenience.
  api.commands.register({
    name: 'namedlist',
    help: '[namedlist — show every spawnable named NPC.',
    access: 'GameMaster',
    run(ctx) {
      const lines = Object.entries(NAMED)
        .map(([id, cfg]) => `  ${id} → ${cfg.name} (${cfg.city}, ${cfg.role})`);
      ctx.state.sendSystemMessage(['Named NPCs:', ...lines].join('\n'));
    },
  });

  // Periodic ambient speech — every named NPC randomly says one of their
  // `_greetings` lines every 60-180 s if a player is within 10 tiles.
  if (api.ai?.registerBehavior) {
    // ai.registerBehavior expects a `{ name, tick(ctx, mob, state) }`
    // bag — passing positional `('named-ambient', { onTick })` threw
    // "behavior must have name + tick()" at script load. Same fix as
    // boss-ai.js.
    api.ai.registerBehavior({
      name: 'named-ambient',
      tick(_ctx, mob /* , state */) {
        const greetings = mob._greetings;
        if (!greetings?.length) return;
        const now = api.now?.() ?? Date.now();
        if ((mob._nextAmbientAt ?? 0) > now) return;
        mob._nextAmbientAt = now + 60_000 + Math.floor(Math.random() * 120_000);
        // Need a player nearby.
        let near = false;
        for (const other of allMobiles(api)) {
          if (!other.client || other.map !== mob.map) continue;
          const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
          if (d <= 10) { near = true; break; }
        }
        if (!near) return;
        const line = greetings[Math.floor(Math.random() * greetings.length)];
        try { api.protocol?.broadcastSpeech?.(mob, line); }
        catch { /* socket transient */ }
      },
    });
  }

  return () => {
    api.commands?.unregister?.('spawnnamed');
    api.commands?.unregister?.('namedlist');
    api.ai?.unregisterBehavior?.('named-ambient');
  };
}

export const NAMED_NPCS = NAMED;
