function panel(w, h) { return `{ resizepic 0 0 5054 ${w} ${h} }`; }

function nowLine(ts = Date.now()) {
  try { return new Date(ts).toISOString().slice(0, 19).replace('T', ' '); }
  catch { return ''; }
}

function isStaff(mob) {
  return (mob?.accessLevel | 0) > 0 || mob?.isAdmin === true;
}

function isOwner(item, mob) {
  if (!mob) return false;
  if (isStaff(mob)) return true;
  if (!item.ownerSerial) item.ownerSerial = mob.serial;
  return (item.ownerSerial >>> 0) === (mob.serial >>> 0);
}

// ServUO BallotBox.TopicPrompt parity: repeated text prompts append up
// to six topic lines; cancelling ends editing and reopens the ballot.
function askBallotTopicLine(api, world, item, user, openGump) {
  const state = user?.client;
  if (!state || !api.prompts?.ask) return;
  api.prompts.ask(state, {
    text: (item.ballot?.topic?.length ?? 0) === 0
      ? 'Enter a line of text for your ballot. ESC or blank line finishes.'
      : 'Next line or ESC to finish:',
  }, (reply) => {
    if (!item.ballot || !isOwner(item, user)) return;
    const text = String(reply?.text ?? '').trimEnd();
    if (!reply?.cancelled && text.length > 0 && item.ballot.topic.length < 6) {
      item.ballot.topic.push(text.slice(0, 80));
      item.ballot.yes = [];
      item.ballot.no = [];
      if (item.ballot.topic.length < 6) {
        askBallotTopicLine(api, world, item, user, openGump);
        return;
      }
    }
    state.sendSystemMessage?.('Ballot entry complete.');
    openGump(world, item, user);
  });
}

function ballotState(item) {
  item.ballot ??= { topic: [], yes: [], no: [] };
  item.ballot.topic ??= [];
  item.ballot.yes ??= [];
  item.ballot.no ??= [];
  return item.ballot;
}

export function buildBallotBox(api) {
  function openGump(world, item, user) {
    const state = user?.client;
    if (!state) return;
    const ballot = ballotState(item);
    const owner = isOwner(item, user);
    if (!api.gumps?.send) {
      state.sendSystemMessage?.(`Ballot: ${ballot.topic.join(' / ') || '(no topic)'}`);
      state.sendSystemMessage?.(`Aye: ${ballot.yes.length}, Nay: ${ballot.no.length}`);
      return;
    }
    const layout = [
      panel(410, 330),
      `{ text 20 14 1153 0 }`,
      `{ text 20 44 1153 1 }`,
    ];
    const texts = [owner ? "Ballot Box Owner's Menu" : 'Ballot Box - Vote Here', 'Topic'];
    let y = 76;
    const lines = ballot.topic.length ? ballot.topic : ['(no topic set)'];
    for (const line of lines.slice(0, 6)) {
      texts.push(line);
      layout.push(`{ text 34 ${y} 1149 ${texts.length - 1} }`);
      y += 20;
    }
    texts.push(`Aye: [${ballot.yes.length}]`);
    texts.push(`Nay: [${ballot.no.length}]`);
    layout.push(`{ text 55 220 1149 ${texts.length - 2} }`);
    layout.push(`{ text 55 252 1149 ${texts.length - 1} }`);
    if (!owner) {
      layout.push('{ button 22 218 4005 4007 1 0 3 }');
      layout.push('{ button 22 250 4005 4007 1 0 4 }');
    } else {
      layout.push('{ button 22 292 4023 4024 1 0 1 }');
      texts.push('Change topic');
      layout.push(`{ text 60 294 1153 ${texts.length - 1} }`);
      layout.push('{ button 180 292 4017 4018 1 0 2 }');
      texts.push('Reset votes');
      layout.push(`{ text 218 294 1153 ${texts.length - 1} }`);
    }
    api.gumps.send(state, { gumpId: 0xBA1107, x: 110, y: 70, layout: layout.join(''), texts }, (resp) => {
      const b = resp?.buttonId | 0;
      if (b === 1 && owner) {
        ballot.topic = [];
        ballot.yes = [];
        ballot.no = [];
        askBallotTopicLine(api, world, item, user, openGump);
        return;
      }
      if (b === 2 && owner) {
        ballot.yes = [];
        ballot.no = [];
        state.sendSystemMessage?.('Votes zeroed out.');
        openGump(world, item, user);
        return;
      }
      if ((b === 3 || b === 4) && !owner) {
        const serial = user.serial >>> 0;
        if (ballot.yes.includes(serial) || ballot.no.includes(serial)) {
          state.sendSystemMessage?.('You have already voted on this ballot.');
        } else {
          (b === 3 ? ballot.yes : ballot.no).push(serial);
          state.sendSystemMessage?.('Your vote has been registered.');
        }
        openGump(world, item, user);
      }
    });
  }
  return {
    name: 'ballot-box',
    onCreate(_world, item) {
      item.movable = false;
      item.servuoClass ??= 'BallotBox';
      item.servuoClasses = [...new Set([
        ...(item.servuoClasses ?? []),
        'BallotBox',
        'TopicPrompt',
        'BallotBoxAddon',
        'BallotBoxDeed',
      ])];
      ballotState(item);
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      openGump(world, item, user);
      return true;
    },
    onDrop(_world, _item, _dropped, dropper) {
      dropper?.client?.sendSystemMessage?.("I'm a ballot box, not a container!");
      return { handled: true, consumeHeld: false };
    },
  };
}

function boardState(item) {
  item.playerBB ??= { title: '', greeting: null, messages: [] };
  item.playerBB.messages ??= [];
  return item.playerBB;
}

function askBoardText(api, item, user, opts, done) {
  const state = user?.client;
  if (!state || !api.prompts?.ask) return;
  api.prompts.ask(state, { text: opts.text }, (reply) => {
    if (reply?.cancelled) return done('');
    done(String(reply?.text ?? '').trim().slice(0, opts.max ?? 255));
  });
}

export function buildPlayerBulletinBoard(api) {
  function openGump(world, item, user, page = 0) {
    const state = user?.client;
    if (!state) return;
    const board = boardState(item);
    const owner = isOwner(item, user);
    page = Math.max(0, Math.min(page | 0, board.messages.length));
    const message = page === 0 ? board.greeting : board.messages[page - 1];
    if (!api.gumps?.send) {
      state.sendSystemMessage?.(board.title || 'Bulletin board');
      state.sendSystemMessage?.(message?.message ?? '(no message)');
      return;
    }
    const layout = [
      panel(450, 430),
      '{ text 24 16 1153 0 }',
      '{ text 360 16 1149 1 }',
      '{ button 28 58 4023 4024 1 0 1 }',
      '{ text 66 60 1153 2 }',
      '{ button 320 58 4005 4007 1 0 4 }',
      '{ button 360 58 4005 4007 1 0 5 }',
    ];
    const texts = [
      board.title || 'Bulletin Board',
      `${page}/${board.messages.length}`,
      'Post message',
    ];
    if (owner) {
      layout.push('{ button 28 90 4023 4024 1 0 2 }');
      texts.push('Set title');
      layout.push(`{ text 66 92 1153 ${texts.length - 1} }`);
      layout.push('{ button 180 90 4023 4024 1 0 3 }');
      texts.push('Post greeting');
      layout.push(`{ text 218 92 1153 ${texts.length - 1} }`);
    }
    let y = 140;
    texts.push(message ? `Posted: ${nowLine(message.createdAt)}` : 'Posted: -');
    layout.push(`{ text 28 ${y} 1149 ${texts.length - 1} }`); y += 22;
    texts.push(message ? `By: ${message.posterName ?? 'Someone'}` : 'By: -');
    layout.push(`{ text 28 ${y} 1149 ${texts.length - 1} }`); y += 34;
    const body = String(message?.message ?? '(no post selected)').split(/\r?\n/).slice(0, 8);
    for (const line of body) {
      texts.push(line.slice(0, 72));
      layout.push(`{ text 36 ${y} 1149 ${texts.length - 1} }`);
      y += 22;
    }
    if (owner && page > 0) {
      layout.push('{ button 28 386 4017 4018 1 0 7 }');
      texts.push('Delete message');
      layout.push(`{ text 66 388 1153 ${texts.length - 1} }`);
    }
    api.gumps.send(state, { gumpId: 0xBB5001, x: 70, y: 50, layout: layout.join(''), texts }, (resp) => {
      const b = resp?.buttonId | 0;
      if (b === 1) {
        askBoardText(api, item, user, { text: 'Please enter your message:', max: 255 }, (text) => {
          if (text) {
            board.messages.unshift({
              createdAt: Date.now(),
              posterSerial: user.serial,
              posterName: user.name ?? 'Someone',
              message: text,
            });
            if (board.messages.length > 50) board.messages.length = 50;
          }
          openGump(world, item, user, 1);
        });
      } else if (b === 2 && owner) {
        askBoardText(api, item, user, { text: 'Enter new title:', max: 80 }, (text) => {
          if (text) board.title = text;
          openGump(world, item, user, page);
        });
      } else if (b === 3 && owner) {
        askBoardText(api, item, user, { text: 'Enter new greeting:', max: 255 }, (text) => {
          if (text) board.greeting = {
            createdAt: Date.now(),
            posterSerial: user.serial,
            posterName: user.name ?? 'Someone',
            message: text,
          };
          openGump(world, item, user, 0);
        });
      } else if (b === 4) {
        openGump(world, item, user, page === 0 ? board.messages.length : page - 1);
      } else if (b === 5) {
        openGump(world, item, user, (page + 1) % (board.messages.length + 1));
      } else if (b === 7 && owner && page > 0) {
        board.messages.splice(page - 1, 1);
        openGump(world, item, user, 0);
      }
    });
  }

  return {
    name: 'player-bulletin-board',
    onCreate(_world, item) {
      item.movable = false;
      const facingClass = (item.itemId | 0) === 0x2312 ? 'PlayerBBEast' : 'PlayerBBSouth';
      item.servuoClass ??= facingClass;
      item.servuoClasses = [...new Set([
        ...(item.servuoClasses ?? []),
        facingClass,
        'BasePlayerBB',
        'PlayerBBGump',
        'PostPrompt',
        'SetTitlePrompt',
        'PlayerBBMessage',
      ])];
      boardState(item);
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      openGump(world, item, user, 0);
      return true;
    },
  };
}
