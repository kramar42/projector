/**
 * What the owner's kernel says about this vault's notes, as data.
 *
 * Pure, and safe in the browser: the panel draws a `KernelNote` and imports its
 * type from here, while reading and writing the kernel live beside it in
 * `read.ts` and `write.ts`, which spawn.
 *
 * **The kernel is the ledger of intentions; the vault is the truth for content
 * (C1).** Nothing here is stored in a note. The `kernel` axis is computed from
 * the kernel's own answer every time the index is rebuilt (C11), and every value
 * it takes is a status the kernel reported or a comparison of who gave the
 * latest verdict against the owner — never a judgment (C8).
 */

/** The computed axis that carries this. Its key in a view, a URL and `pj ls --filter`. */
export const KERNEL_AXIS = 'kernel';

/**
 * The values the axis takes, in the order a board draws them.
 *
 * Two values no kernel status spells, both waiting for you. `draft`: the
 * intent is still open, and its latest verdict — `met`, `missed` or `dropped` —
 * came from somebody other than the owner. `ask`: the note and its intent have
 * parted ways — the note's lifecycle is closed while the intent is open, or the
 * intent is closed while the note's lifecycle is not (`askOf`). Neither changes
 * the other; the owner is asked, which is the column a board grouped by this
 * axis exists to show.
 */
export const KERNEL_VALUES = ['open', 'ask', 'draft', 'met', 'missed', 'dropped'] as const;
export type KernelValue = (typeof KERNEL_VALUES)[number];

/** An intent's status, as the kernel's `vault-intents` query reports it. */
export type IntentStatus = 'open' | 'proposed' | 'met' | 'missed' | 'dropped' | 'superseded';
const STATUSES: readonly string[] = ['open', 'proposed', 'met', 'missed', 'dropped', 'superseded'];

/** The verdicts a draft can carry that the owner then accepts or overrules. */
const DRAFTABLE: readonly string[] = ['met', 'missed', 'dropped'];

/** The kernel's own alias for its owner. The CLI writes as the owner unless told otherwise. */
export const OWNER_ALIAS = 'kernel:owner';

/** Whether a verdict's author is the owner. `owner` is the owner entity's name, which a reader may print instead of its alias. */
export function isOwner(by: string | null | undefined): boolean {
  if (!by) return false;
  const who = by.trim().toLowerCase();
  return who === OWNER_ALIAS || who === OWNER_ALIAS.slice(OWNER_ALIAS.indexOf(':') + 1);
}

export interface Judgment {
  verdict: string;
  by: string | null;
  at: string | null;
  note: string | null;
  evidence: unknown;
}

export interface KernelIntent {
  id: string;
  status: IntentStatus;
  statement: string;
  horizon: string | null;
  about: string[];
  latest: Judgment | null;
  proposedBy: string | null;
}

/** One note's line in the kernel: the intent that speaks for it and what it says. */
export interface KernelNote {
  note: string;
  intent: string;
  status: IntentStatus;
  statement: string;
  horizon: string | null;
  latest: Judgment | null;
  /** The latest verdict is a draft: open, and given by someone other than the owner. */
  draft: boolean;
  /** The `kernel` axis value, or null for a status the axis does not draw. */
  value: KernelValue | null;
  /** Other intents about the same note, by id — superseded ones, usually. */
  others: string[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function judgment(v: unknown): Judgment | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const verdict = text(o.verdict);
  if (!verdict) return null;
  return {
    verdict: verdict.replace(/^:/, ''),
    by: text(o.by),
    at: text(o.at),
    note: text(o.note),
    evidence: o.evidence ?? null,
  };
}

/** A local `YYYY-MM-DD` for the instant a horizon is due, the day the kernel's own views print. */
function localDay(v: unknown): string | null {
  const t = text(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The kernel's `projector/vault-intents` answer, as intents.
 *
 * The query returns one row per intent and matching alias, with `""` where a
 * value is absent — no verdict yet, a standing intent, the owner's own intent —
 * and, for the latest verdict, one row per piece of evidence it cites. Rows are
 * folded back into one intent each, in the order the kernel returned them. A row
 * without an id, or with a status this module does not know, is skipped rather
 * than failing the whole answer, because one odd intent should cost one line,
 * not the board's axis.
 */
export function intentsOf(rows: Record<string, unknown>[]): KernelIntent[] {
  const by = new Map<string, { intent: KernelIntent; about: Set<string>; evidence: Set<string> }>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const id = text(r.intent);
    const status = text(r.status)?.replace(/^:/, '');
    if (!id || !status || !STATUSES.includes(status)) continue;
    let had = by.get(id);
    if (!had) {
      const latest = judgment({ verdict: r.verdict, by: r.by, at: r.at, note: r.note });
      had = {
        intent: {
          id,
          status: status as IntentStatus,
          statement: text(r.statement) ?? '',
          horizon: localDay(r.horizon),
          about: [],
          latest,
          proposedBy: text(r.proposer),
        },
        about: new Set(),
        evidence: new Set(),
      };
      by.set(id, had);
    }
    const alias = text(r.alias);
    if (alias) had.about.add(alias);
    const ev = text(r.evidence);
    if (ev) had.evidence.add(ev);
  }
  return [...by.values()].map(({ intent, about, evidence }) => ({
    ...intent,
    about: [...about].sort(),
    latest: intent.latest && { ...intent.latest, evidence: evidence.size },
  }));
}

/** What a verdict's standing is read from. */
type Standing = { status: IntentStatus; latest: Judgment | null };

/** An open intent whose latest verdict is somebody else's `met`, `missed` or `dropped`. */
export function hasDraft(i: Standing): boolean {
  return i.status === 'open' && !!i.latest && DRAFTABLE.includes(i.latest.verdict) && !isOwner(i.latest.by);
}

/**
 * The axis value for one intent.
 *
 * `proposed` and `superseded` draw nothing. A proposed intent is a draft of a
 * *commitment* — intake's card in `inbox/` is the UI's view of it, and the
 * `intake` axis already sorts those — and a superseded one has been replaced by
 * the intent that now speaks for the note.
 */
export function kernelValue(i: Standing): KernelValue | null {
  if (i.status === 'open') return hasDraft(i) ? 'draft' : 'open';
  if (i.status === 'met' || i.status === 'missed' || i.status === 'dropped') return i.status;
  return null;
}

/** Which intent speaks for a note when several are about it: the live one first. */
const RANK: Record<IntentStatus, number> = { open: 0, proposed: 1, met: 2, missed: 2, dropped: 2, superseded: 3 };

/**
 * Every note this vault's intents are about, keyed by note id.
 *
 * An intent is about a note when one of its aliases is `vault:<vault>:<id>` —
 * the alias the intake sink gives every note (`noteAlias`). When several intents
 * name one note the live one speaks for it: open, then proposed, then closed,
 * then superseded, the newest latest verdict breaking a tie and the id a tie
 * after that, so two reads of the same kernel draw the same board.
 */
export function notesOf(vault: string, intents: KernelIntent[]): Map<string, KernelNote> {
  const prefix = `vault:${vault}:`;
  const by = new Map<string, KernelIntent[]>();
  for (const i of intents) {
    for (const alias of i.about) {
      if (!alias.startsWith(prefix)) continue;
      const id = alias.slice(prefix.length);
      if (!id) continue;
      const list = by.get(id);
      if (list) {
        if (!list.includes(i)) list.push(i);
      } else by.set(id, [i]);
    }
  }
  const out = new Map<string, KernelNote>();
  for (const [note, list] of by) {
    list.sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] ||
        (b.latest?.at ?? '').localeCompare(a.latest?.at ?? '') ||
        a.id.localeCompare(b.id),
    );
    const i = list[0]!;
    out.set(note, {
      note,
      intent: i.id,
      status: i.status,
      statement: i.statement,
      horizon: i.horizon,
      latest: i.latest,
      draft: hasDraft(i),
      value: kernelValue(i),
      others: list.slice(1).map((o) => o.id),
    });
  }
  return out;
}

/**
 * What the owner is asked about a note whose lifecycle and intent part ways.
 *
 * `judge`: the note holds a closed value while its intent is open and nobody
 * has drafted a verdict — judge the intent? `close`: the intent is met, missed
 * or dropped while the note holds no closed value — close the note too? The
 * answer is the owner's, through the kernel's judge or the note's own write;
 * neither side ever writes the other.
 */
export type Ask =
  | { kind: 'judge'; value: string }
  | { kind: 'close'; verdict: 'met' | 'missed' | 'dropped'; axis: string; values: string[] };

/** The vault's lifecycle, as the panel reads it: the recorded axis and the values its facet calls closed. */
export interface Lifecycle {
  axis: string;
  closed: readonly string[];
}

/** The lifecycle the vault records (`kernel.status`), with its facet's closed values. Null when none is recorded. */
export function lifecycleOf(axis: string | null, facets: Readonly<Record<string, { closed?: readonly string[] }>>): Lifecycle | null {
  return axis ? { axis, closed: [...(facets[axis]?.closed ?? [])] } : null;
}

/** `axisValues`' `asks`, over the notes the index read. Undefined when the vault records no lifecycle. */
export function asking(
  life: Lifecycle | null,
  notes: ReadonlyMap<string, { facets: Record<string, string[]> }>,
): ((id: string, k: KernelNote) => boolean) | undefined {
  return life ? (id, k) => askOf(k, notes.get(id)?.facets[life.axis], life) !== null : undefined;
}

/** The ask for one note, given what it holds on the lifecycle axis. Null when they agree, or the vault names no closed value. */
export function askOf(k: KernelNote | null | undefined, held: readonly string[] | undefined, life: Lifecycle | null): Ask | null {
  if (!k || !life || !life.closed.length) return null;
  const closed = (held ?? []).find((v) => life.closed.includes(v));
  if (k.status === 'open' && !k.draft && closed) return { kind: 'judge', value: closed };
  if ((k.status === 'met' || k.status === 'missed' || k.status === 'dropped') && !closed) {
    return { kind: 'close', verdict: k.status, axis: life.axis, values: [...life.closed] };
  }
  return null;
}

/**
 * The axis, as the query compiler takes it: note id to its one value. `asks`,
 * when given, says which notes' lifecycle and intent part ways: those read
 * `ask` unless a draft already waits on them.
 */
export function axisValues(notes: Map<string, KernelNote>, asks?: (id: string, k: KernelNote) => boolean): Map<string, KernelValue> {
  const out = new Map<string, KernelValue>();
  for (const [id, k] of notes) {
    const value = k.value !== 'draft' && asks?.(id, k) ? 'ask' : k.value;
    if (value) out.set(id, value);
  }
  return out;
}

/** The short id the kernel prints, for a table a person reads. The full id is what gets written. */
export const shortId = (id: string): string => id.slice(0, 8);
