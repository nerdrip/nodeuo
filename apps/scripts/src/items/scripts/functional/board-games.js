import { itemBySerial } from '../../../_entities.js';

const TILE_TYPES = [
  'circle-1','circle-2','circle-3','circle-4','circle-5','circle-6','circle-7','circle-8','circle-9',
  'bamboo-1','bamboo-2','bamboo-3','bamboo-4','bamboo-5','bamboo-6','bamboo-7','bamboo-8','bamboo-9',
  'character-1','character-2','character-3','character-4','character-5','character-6','character-7','character-8','character-9',
  'east','south','west','north','red-dragon','green-dragon','white-dragon',
];

export const MahjongEnums = Object.freeze({
  winds: ['east', 'south', 'west', 'north'],
  dragons: ['red-dragon', 'green-dragon', 'white-dragon'],
  suits: ['circle', 'bamboo', 'character'],
});

export class MahjongTile {
  constructor(type, index) {
    this.servuoClass = 'MahjongTile';
    this.type = type;
    this.index = index;
    this.faceUp = false;
  }
}

export class MahjongPlayers {
  constructor() {
    this.servuoClass = 'MahjongPlayers';
    this.seats = [null, null, null, null];
    this.scores = [25_000, 25_000, 25_000, 25_000];
  }
}

export function MahjongGeneralInfo(game) {
  return { servuoClass: 'MahjongGeneralInfo', dealer: game.dealer, wallCount: game.wall.length };
}
export function MahjongPlayersInfo(game) {
  return { servuoClass: 'MahjongPlayersInfo', seats: [...game.players.seats], scores: [...game.players.scores] };
}
export function MahjongTilesInfo(game, seat = -1) {
  return { servuoClass: 'MahjongTilesInfo', seat, wallCount: game.wall.length, discards: game.discards.map((d) => d.length) };
}

function shuffle(values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildMahjongState() {
  const tiles = [];
  let index = 0;
  for (const type of TILE_TYPES) for (let i = 0; i < 4; i++) tiles.push(new MahjongTile(type, index++));
  const players = new MahjongPlayers();
  return {
    servuoClasses: [
      'MahjongGame', 'MahjongEnums', 'MahjongPlayers', 'MahjongTile',
      'MahjongPieceDim', 'MahjongGeneralInfo', 'MahjongPlayersInfo',
      'MahjongTileInfo', 'MahjongTilesInfo', 'MahjongJoinGame',
      'MahjongRelieve', 'ResetGameEntry',
    ],
    players,
    seats: players.seats,
    scores: players.scores,
    dealer: 0,
    wall: shuffle(tiles),
    hands: [[], [], [], []],
    discards: [[], [], [], []],
    publicHands: [false, false, false, false],
    dice: [1, 1],
    startedAt: Date.now(),
  };
}

function handMessage(user, text) {
  user?.client?.sendSystemMessage?.(text);
}

function seatFor(game, serial) {
  return game.seats.findIndex((s) => (s >>> 0) === (serial >>> 0));
}

function joinGame(game, user) {
  let seat = seatFor(game, user.serial);
  if (seat >= 0) return seat;
  seat = game.seats.findIndex((serial) => !serial);
  if (seat >= 0) game.seats[seat] = user.serial;
  return seat;
}

function drawTile(game, seat) {
  if (seat < 0 || seat > 3 || game.wall.length === 0) return null;
  const tile = game.wall.pop();
  game.hands[seat] ??= [];
  game.hands[seat].push(tile);
  return tile;
}

function discardTile(game, seat, index = -1) {
  const hand = game.hands?.[seat] ?? [];
  if (hand.length === 0) return null;
  const i = index >= 0 && index < hand.length ? index : hand.length - 1;
  const [tile] = hand.splice(i, 1);
  game.discards[seat] ??= [];
  game.discards[seat].push({ ...tile, faceUp: true });
  return tile;
}

function registerMahjongCommand(api) {
  if (!api.commands || api.commands.commands?.has?.('mahjong')) return;
  api.commands.register({
    name: 'mahjong',
    help: '[mahjong <setSerial> info|join|leave|reset|draw|discard [handIndex]',
    access: 'Player',
    run(ctx, args) {
      const serial = (/^0x/i.test(args?.[0] ?? '') ? parseInt(args[0], 16) : parseInt(args?.[0] ?? '0', 10)) >>> 0;
      const item = serial ? itemBySerial({ world: api.world ?? ctx.world }, serial) : null;
      if (!item?.mahjong && item?.script !== 'mahjong-set') {
        ctx.state?.sendSystemMessage?.('Pass a mahjong set serial.');
        return;
      }
      item.mahjong ??= buildMahjongState();
      const action = String(args?.[1] ?? 'info').toLowerCase();
      const game = item.mahjong;
      const user = ctx.sender;
      if (action === 'reset') {
        game.wall = [];
        item.mahjong = buildMahjongState();
        ctx.state?.sendSystemMessage?.('Mahjong game reset.');
        return;
      }
      if (action === 'join') {
        const seat = joinGame(game, user);
        ctx.state?.sendSystemMessage?.(seat >= 0 ? `You join seat ${seat + 1}.` : 'The table is full.');
        return;
      }
      if (action === 'leave') {
        const seat = seatFor(game, user.serial);
        if (seat >= 0) game.seats[seat] = null;
        ctx.state?.sendSystemMessage?.(seat >= 0 ? 'You leave the mahjong game.' : 'You are not seated.');
        return;
      }
      const seat = seatFor(game, user.serial);
      if (action === 'draw') {
        const tile = drawTile(game, seat);
        ctx.state?.sendSystemMessage?.(tile ? `You draw ${tile.type}.` : 'You must be seated and the wall must contain tiles.');
        return;
      }
      if (action === 'discard') {
        const tile = discardTile(game, seat, parseInt(args?.[2] ?? '-1', 10));
        ctx.state?.sendSystemMessage?.(tile ? `You discard ${tile.type}.` : 'You have no tile to discard.');
        return;
      }
      const info = MahjongGeneralInfo(game);
      const players = MahjongPlayersInfo(game);
      ctx.state?.sendSystemMessage?.(`Mahjong: wall ${info.wallCount}, dealer ${info.dealer + 1}, seats ${players.seats.map((s) => s ? 'X' : '-').join('')}.`);
    },
  });
}

export function buildMahjongSet(api) {
  registerMahjongCommand(api);
  return {
    name: 'mahjong-set',
    onCreate(_world, item) {
      item.mahjong ??= buildMahjongState();
      item.servuoClasses ??= item.mahjong.servuoClasses;
    },
    onUse(_world, item, user) {
      item.mahjong ??= buildMahjongState();
      if (user?.serial) joinGame(item.mahjong, user);
      const packets = [
        MahjongGeneralInfo(item.mahjong),
        MahjongPlayersInfo(item.mahjong),
        MahjongTilesInfo(item.mahjong, seatFor(item.mahjong, user?.serial)),
      ];
      item.mahjong.lastPacketSummary = packets;
      handMessage(user, `Mahjong table: ${item.mahjong.wall.length} tiles in wall, dealer seat ${item.mahjong.dealer + 1}.`);
      return true;
    },
  };
}

export function buildDiceRoll(_api) {
  return {
    name: 'dice-roll',
    onUse(_world, _item, user) {
      handMessage(user, `You roll ${1 + Math.floor(Math.random() * 6)}.`);
      return true;
    },
  };
}

export function buildDiceCup(_api) {
  return {
    name: 'dice-cup',
    onUse(_world, _item, user) {
      const a = 1 + Math.floor(Math.random() * 6);
      const b = 1 + Math.floor(Math.random() * 6);
      handMessage(user, `You roll ${a} and ${b}.`);
      return true;
    },
  };
}

export function buildCardsGame(_api) {
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const suits = ['spades','hearts','diamonds','clubs'];
  return {
    name: 'cards-game',
    onCreate(_world, item) {
      item.deck ??= shuffle(suits.flatMap((suit) => ranks.map((rank) => `${rank} of ${suit}`)));
    },
    onUse(_world, item, user) {
      item.deck ??= shuffle(suits.flatMap((suit) => ranks.map((rank) => `${rank} of ${suit}`)));
      if (item.deck.length === 0) item.deck = shuffle(suits.flatMap((suit) => ranks.map((rank) => `${rank} of ${suit}`)));
      handMessage(user, `You draw ${item.deck.pop()}.`);
      return true;
    },
  };
}

export function buildBoardGame(_api) {
  return {
    name: 'board-game',
    onUse(_world, item, user) {
      handMessage(user, `${item.name ?? 'The board'} is ready for play.`);
      return true;
    },
  };
}
