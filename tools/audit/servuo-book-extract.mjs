import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BOOKS_ROOT = path.join(ROOT, 'templates', 'ServUO', 'Scripts', 'Items', 'Books');
const OUT = path.join(ROOT, 'apps', 'scripts', 'src', 'data', 'world', 'books.servuo.generated.json');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else if (entry.isFile() && entry.name.endsWith('.cs')) out.push(child);
  }
  return out;
}

function rel(abs) {
  return path.relative(ROOT, abs).replaceAll('\\', '/');
}

function splitWords(input) {
  return String(input ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\\/]+/g, ' ')
    .trim();
}

function kebab(input) {
  return splitWords(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function decodeCString(raw) {
  return String(raw)
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function stringLiterals(text) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(text))) out.push(decodeCString(match[1]));
  return out;
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractCallBody(text, marker, from = 0) {
  const idx = text.indexOf(marker, from);
  if (idx < 0) return null;
  const open = text.indexOf('(', idx + marker.length);
  if (open < 0) return null;
  const close = findMatchingParen(text, open);
  if (close < 0) return null;
  return { body: text.slice(open + 1, close), end: close + 1 };
}

function classBlocks(text) {
  const re = /\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/g;
  const out = [];
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf('{', match.index);
    const close = findMatchingBrace(text, open);
    if (close < 0) continue;
    out.push({ name: match[1], body: text.slice(open + 1, close) });
  }
  return out;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractBookContent(block) {
  const content = extractCallBody(block, 'new BookContent');
  if (!content) return null;
  const strings = stringLiterals(content.body);
  if (strings.length < 2) return null;
  const pages = [];
  let cursor = 0;
  while (true) {
    const page = extractCallBody(content.body, 'new BookPageInfo', cursor);
    if (!page) break;
    const lines = stringLiterals(page.body);
    if (lines.length) pages.push(lines);
    cursor = page.end;
  }
  return {
    title: strings[0],
    author: strings[1] || 'Unknown',
    pages,
  };
}

function commentAfterReturn(block, prop) {
  const re = new RegExp(`${prop}\\s*\\{[\\s\\S]*?return\\s+([0-9]+)\\s*;[\\s\\S]*?\\}\\s*//\\s*([^\\r\\n]+)`);
  const m = re.exec(block);
  if (!m) return null;
  return { id: Number(m[1]), text: m[2].trim() };
}

function stringReturn(block, prop) {
  const re = new RegExp(`${prop}\\s*\\{[\\s\\S]*?return\\s+"((?:\\\\.|[^"\\\\])*)"\\s*;`);
  const m = re.exec(block);
  return m ? decodeCString(m[1]) : null;
}

function intArrayReturn(block, prop) {
  const re = new RegExp(`${prop}\\s*\\{[\\s\\S]*?return\\s+new\\s+int\\[\\]\\s*\\{([\\s\\S]*?)\\}`);
  const m = re.exec(block);
  if (!m) return [];
  return [...m[1].matchAll(/\b([0-9]{6,})\b/g)].map((x) => Number(x[1]));
}

function noteString(block) {
  const m = /m_Content\s*=\s*"((?:\\.|[^"\\])*)"/.exec(block);
  if (m) return decodeCString(m[1]);
  const ctor = /:\s*base\s*\(\s*([0-9]{6,})\s*\)/.exec(block);
  if (ctor) return `#${ctor[1]}`;
  return null;
}

function itemIdFor(block) {
  const ctorBase = /:\s*base\s*\(\s*(?:Utility\.Random\s*\(\s*)?(0x[0-9A-Fa-f]+|\d+)/.exec(block);
  if (ctorBase) {
    const value = Number(ctorBase[1]);
    if (value > 0 && value <= 0xFFFF) return value;
  }
  return 0x0FBE;
}

function hueFor(block) {
  const m = /\bHue\s*=\s*(0x[0-9A-Fa-f]+|\d+)/.exec(block);
  return m ? Number(m[1]) : undefined;
}

function extractLocalizedBook(cls) {
  const title = commentAfterReturn(cls.body, 'Title');
  const author = stringReturn(cls.body, 'Author') ?? 'Unknown';
  const contents = intArrayReturn(cls.body, 'Contents');
  const note = noteString(cls.body);
  if (!title && !contents.length && !note) return null;
  const pages = note
    ? note.replace(/<br\s*\/?>/gi, '\n').split(/\r?\n/).reduce((acc, line, idx) => {
      const page = Math.floor(idx / 8);
      acc[page] ||= [];
      if (line.trim()) acc[page].push(line.trim());
      return acc;
    }, [])
    : [];
  return {
    title: title?.text ?? cls.name,
    author,
    pages: pages.length ? pages : undefined,
    bookContentClilocs: contents.length ? contents : undefined,
  };
}

function extractBooks() {
  const out = [];
  for (const file of walk(BOOKS_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const cls of classBlocks(text)) {
      const content = extractBookContent(cls.body) ?? extractLocalizedBook(cls);
      if (!content) continue;
      const tagId = `servuo-book-${kebab(cls.name)}`;
      out.push({
        id: itemIdFor(cls.body),
        tagId,
        name: content.title,
        title: content.title,
        author: content.author ?? 'Unknown',
        pages: content.pages ?? [],
        bookContentClilocs: content.bookContentClilocs,
        hue: hueFor(cls.body),
        script: 'readable-book',
        servuoClass: cls.name,
        servuoPath: rel(file),
      });
    }
  }
  out.sort((a, b) => a.servuoClass.localeCompare(b.servuoClass));
  return out;
}

const records = extractBooks();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`);
console.log(`[servuo-books] wrote ${rel(OUT)} (${records.length} books)`);
