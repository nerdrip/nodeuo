// `[create` — visual root for every staff creation workflow.
// Each category delegates to its canonical catalogue command so spawning,
// AI attachment, template hooks and multi targeting remain single-source.

const CATEGORIES = [
  {
    key: 'item', title: 'Items', command: 'items',
    description: 'Equipment, reagents, containers and world objects',
    preview: '{ tilepicfit 24 64 0x0F51 0 54 54 }',
  },
  {
    key: 'mobile', title: 'Mobiles', command: 'mobs',
    description: 'Creatures, monsters, bosses and tameables',
    preview: '{ mobilepic 28 128 0x190 0 0 54 54 }',
  },
  {
    key: 'multi', title: 'Multis', command: 'multigump',
    description: 'Houses, ships, structures and custom multis',
    preview: '{ tilepicfit 24 192 0x0BD2 0 54 54 }',
  },
  {
    key: 'mount', title: 'Mounts', command: 'mounts',
    description: 'Rideable pets spawned already tamed',
    preview: '{ mobilepic 28 254 0x00C8 0 0 54 54 }',
  },
];

export default function register(api) {
  if (!api.commands) return () => {};

  const dispatch = (ctx, command, args = []) => {
    const line = [command, ...args].filter(Boolean).join(' ');
    if (!api.commands.dispatch?.(line, ctx)) {
      ctx.state?.sendSystemMessage?.(`Creation catalogue [${command} is unavailable.`);
    }
  };

  const openRoot = (ctx) => {
    if (!api.gumps?.send) {
      ctx.state?.sendSystemMessage?.('Use [create item|mobile|multi|mount.');
      return;
    }
    const W = 520, H = 338;
    const layout = [
      `{ page 0 }`, `{ resizepic 0 0 5054 ${W} ${H} }`,
      '{ text 22 14 1153 0 }', '{ text 118 17 70 1 }',
      `{ button ${W - 34} 10 4017 4018 1 0 0 }`,
    ];
    const texts = ['Create', 'Choose what you want to create'];
    CATEGORIES.forEach((category, index) => {
      const y = 58 + index * 66;
      // The preview snippets use absolute row-specific y values so classic
      // tilepic/mobilepic art remains independent of button dimensions.
      layout.push(category.preview);
      layout.push(`{ button 92 ${y + 7} 4005 4007 1 0 ${100 + index} }`);
      texts.push(category.title);
      layout.push(`{ text 122 ${y + 3} 1153 ${texts.length - 1} }`);
      texts.push(category.description);
      layout.push(`{ croppedtext 122 ${y + 25} 350 34 70 ${texts.length - 1} }`);
    });
    api.gumps.send(ctx.state, {
      x: 110, y: 70, gumpId: 0x43524541, layout: layout.join(''), texts,
    }, (response) => {
      const index = (response?.buttonId | 0) - 100;
      if (index < 0 || index >= CATEGORIES.length) return;
      dispatch(ctx, CATEGORIES[index].command);
    });
  };

  api.commands.register({
    name: 'create',
    access: 'Admin',
    help: '[create [item|mobile|multi|mount] [filter] — visual creation hub.',
    run(ctx, args) {
      const category = String(args?.[0] ?? '').toLowerCase();
      if (!category) return openRoot(ctx);
      const found = CATEGORIES.find((entry) => entry.key === category
        || entry.title.toLowerCase() === category
        || entry.command === category);
      if (!found) {
        ctx.state?.sendSystemMessage?.('Usage: [create item|mobile|multi|mount [filter]');
        return;
      }
      dispatch(ctx, found.command, args.slice(1));
    },
  });

  return () => api.commands.unregister('create');
}
