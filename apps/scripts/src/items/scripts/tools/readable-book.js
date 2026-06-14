function asPages(item) {
  if (Array.isArray(item?.pages) && item.pages.length > 0) {
    return item.pages.map((page) => Array.isArray(page)
      ? page.map((line) => String(line ?? ''))
      : String(page ?? '').split(/\r?\n/));
  }
  if (Array.isArray(item?.bookContentClilocs) && item.bookContentClilocs.length > 0) {
    const lines = item.bookContentClilocs.map((id) => `#${id}`);
    const pages = [];
    for (let i = 0; i < lines.length; i += 8) pages.push(lines.slice(i, i + 8));
    return pages;
  }
  if (typeof item?.noteString === 'string' && item.noteString.trim()) {
    const lines = item.noteString
      .replace(/<br\s*\/?>/gi, '\n')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const pages = [];
    for (let i = 0; i < lines.length; i += 8) pages.push(lines.slice(i, i + 8));
    return pages;
  }
  return [[item?.name ?? item?.title ?? 'A book']];
}

function registerBook(api, item) {
  if (!api?.books || !item?.serial) return false;
  const title = String(item.title ?? item.name ?? 'a book');
  const author = String(item.author ?? 'Unknown');
  const pages = asPages(item);
  item.bookPageDetails = pages.map((lines, index) => ({
    page: index + 1,
    lines: lines.map((line) => String(line ?? '')),
  }));
  item.servuoClasses ??= ['BaseBook', 'BookHeader', 'BookPageDetails'];
  api.books.register(item.serial, {
    title,
    author,
    pages,
    pageDetails: item.bookPageDetails,
    writable: item.writable !== false && item.readOnly !== true,
  });
  return true;
}

export default function buildReadableBookScript(api) {
  return {
    name: 'readable-book',
    onCreate(_world, item) {
      registerBook(api, item);
    },
    onUse(_world, item, user) {
      if (!user?.client) return true;
      registerBook(api, item);
      if (!api.books?.open?.(user.client, item.serial)) {
        user.client.sendSystemMessage?.('The pages are blank.');
      }
      return true;
    },
    onDestroy(_world, item) {
      if (item?.serial) api.books?.unregister?.(item.serial);
    },
  };
}
