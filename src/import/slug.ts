const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'in', 'on', 'with']);

/**
 * Strip emoji, bullets and decoration from a Trello list or card name.
 *
 * Trello list names are decorated on both sides — `📂 backlog 📂`, `• lists •`,
 * `🕘 today 🕔`. The bullet forms sit in General Punctuation, well outside the
 * emoji blocks, so they need their own pass or a name like `• lists •` never
 * matches the list it names.
 */
export function clean(name: string): string {
  return name
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[\u{2022}\u{00B7}\u{2023}\u{25AA}-\u{25CF}\u{2013}\u{2014}]/gu, ' ')
    .replace(/[*_`~]/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Stripping trailing punctuation can orphan an opening bracket:
    // `Project F (internal platform)` → `Project F (internal platform`. Close it again.
    .replace(/^(.*)$/, (t) => {
      const opens = (t.match(/\(/g) ?? []).length;
      const closes = (t.match(/\)/g) ?? []).length;
      return opens > closes ? t + ')'.repeat(opens - closes) : t;
    });
}

/** A URL becomes host + first path segment, so research links get readable ids. */
function fromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/\.(com|io|org|net|dev|ai)$/, '');
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    return [host, seg].filter(Boolean).join('-');
  } catch {
    return null;
  }
}

export function slugify(text: string, maxWords = 6): string {
  const asUrl = /^https?:\/\//.test(text.trim()) ? fromUrl(text.trim()) : null;
  const source = asUrl ?? clean(text);
  const words = source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  const kept = words.filter((w, i) => i === 0 || !STOP.has(w)).slice(0, maxWords);
  const slug = (kept.length ? kept : words.slice(0, maxWords)).join('-').replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/** Make a slug unique against ids already taken, appending -2, -3, … */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}
