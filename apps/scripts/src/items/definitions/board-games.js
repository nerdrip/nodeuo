// Board games — Cards, Chess, Checkers, Backgammon. Mirrors ServUO
// `Items/Decorative/Cards*.cs`, `Chessmen*.cs`, `Checkers*.cs`,
// `Backgammon*.cs`. Each is a deco container that opens a custom
// game gump on double-click. We register the items + tag the script
// so a future client gump can render the actual board.



const __PENDING__ = [];

function game(def) {
  __PENDING__.push({
    kind: 'functional',
    weight: def.weight ?? 5,
    movable: true,
    ...def,
  });
}

// =====================================================================
//  CARDS — playing-card decks (52-card + 32-card variants)
// =====================================================================
game({ id: 0x0E1A, name: 'Deck of Cards',       tagId: 'deck-cards-52',
       script: 'cards-game', weight: 1, gameType: 'cards52' });
game({ id: 0x0E1B, name: 'Pinochle Deck',       tagId: 'deck-cards-pinochle',
       script: 'cards-game', weight: 1, gameType: 'pinochle' });
game({ id: 0x0E1C, name: 'Tarot Deck',          tagId: 'deck-cards-tarot',
       script: 'cards-game', weight: 1, gameType: 'tarot' });

// =====================================================================
//  CHESSBOARD + Chessmen pieces
// =====================================================================
game({ id: 0x0FA6, name: 'Chess Board',         tagId: 'chess-board',
       script: 'board-game', weight: 12, gameType: 'chess', movable: false });
game({ id: 0x0FA9, name: 'Chess Pieces',        tagId: 'chess-pieces',
       script: 'board-game', weight: 5 });

// =====================================================================
//  CHECKERS
// =====================================================================
game({ id: 0x0FA0, name: 'Checker Board',       tagId: 'checker-board',
       script: 'board-game', weight: 10, gameType: 'checkers', movable: false });
game({ id: 0x0FA2, name: 'Checker Pieces',      tagId: 'checker-pieces',
       script: 'board-game', weight: 4 });

// =====================================================================
//  BACKGAMMON
// =====================================================================
game({ id: 0x0E1F, name: 'Backgammon Board',    tagId: 'backgammon-board',
       script: 'board-game', weight: 8, gameType: 'backgammon' });
game({ id: 0x0E1E, name: 'Backgammon Pieces',   tagId: 'backgammon-pieces',
       script: 'board-game', weight: 3 });

// =====================================================================
//  DICE + DARTS
// =====================================================================
game({ id: 0x0FA7, name: 'Dice',                tagId: 'dice',
       script: 'dice-roll', weight: 1 });
game({ id: 0x0FA8, name: 'Cup of Dice',         tagId: 'dice-cup',
       script: 'dice-cup', weight: 1 });
game({ id: 0x232C, name: 'Dart Board',          tagId: 'dart-board',
       script: 'board-game', weight: 4, movable: false });

// =====================================================================
//  MAHJONG (already exists in our codebase as a system; keep entry for
//  legacy spawners that reference the item directly)
// =====================================================================
game({ id: 0x0FAB, name: 'Mahjong Set',         tagId: 'mahjong-set-item',
       script: 'mahjong-set', weight: 8, gameType: 'mahjong',
       servuoClass: 'MahjongGame',
       servuoClasses: [
         'MahjongGame', 'MahjongEnums', 'MahjongPlayers', 'MahjongTile',
         'MahjongPieceDim', 'MahjongGeneralInfo', 'MahjongJoinGame',
         'MahjongPlayersInfo', 'MahjongRelieve', 'MahjongTileInfo',
         'MahjongTilesInfo', 'ResetGameEntry',
       ] });

// =====================================================================
//  PIANO / Music tables (decoration)
// =====================================================================
game({ id: 0x0EB1, name: 'Drum',                tagId: 'drum',  script: 'board-game' });
game({ id: 0x0EB2, name: 'Tambourine',          tagId: 'tambourine-prop', script: 'board-game' });
game({ id: 0x0E9C, name: 'Lute Display',        tagId: 'lute-display', script: 'board-game' });

// =====================================================================
//  GAMBLING — chips + tokens (used by Fire Casino events)
// =====================================================================
game({ id: 0x14F0, name: 'Casino Chip',         tagId: 'casino-chip', kind: 'consumable',
       script: 'casino-chip', weight: 0.1, value: 100 });
game({ id: 0x14F0, name: 'High-Roller Chip',    tagId: 'casino-chip-high', kind: 'consumable',
       script: 'casino-chip', weight: 0.1, value: 1000 });


export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) return () => {};
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('board-games: ' + e.message); } }
  api.log?.('board-games: registered ' + count + ' items');
  return () => {};
}
