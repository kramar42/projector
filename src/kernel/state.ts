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
 * latest verdict against the owner — never a judgement (C8).
 */

/** The computed axis that carries this. Its key in a view, a URL and `pj ls --filter`. */
export const KERNEL_AXIS = 'kernel';

/**
 * The values the axis takes, in the order a board draws them.
 *
 * `proposed-verdict` is the one value no kernel status spells: the intent is
 * still open, and its latest verdict — `met`, `missed` or `dropped` — came from
 * somebody other than the owner. That is a draft waiting for you, which is the
 * column a board grouped by this axis exists to show.
 */
export const KERNEL_VALUES = ['open', 'proposed-verdict', 'met', 'missed', 'dropped'] as const;
export type KernelValue = (typeof KERNEL_VALUES)[number];

/** An intent's status, as `bin/kernel intents --json` reports it. */
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

export interface Observation {
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
  latest: Observation | null;
  proposedBy: string | null;
}

/** One note's line in the kernel: the intent that speaks for it and what it says. */
export interface KernelNote {
  note: string;
  intent: string;
  status: IntentStatus;
  statement: string;
  horizon: string | null;
  latest: Observation | null;
  /** The latest verdict is a draft: open, and given by someone other than the owner. */
  proposed: boolean;
  /** The `kernel` axis value, or null for a status the axis does not draw. */
  value: KernelValue | null;
  /** Other intents about the same note, by id — superseded ones, usually. */
  others: string[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function observation(v: unknown): Observation | null {
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

/**
 * `bin/kernel intents --json`, read leniently: a row without an id or with a
 * status this module does not know is skipped rather than failing the whole
 * answer, because one odd intent should cost one line, not the board's axis.
 * Anything that is not a JSON array is an error, which the reader reports.
 */
export function parseIntents(json: string): KernelIntent[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('kernel intents --json did not print an array');
  const out: KernelIntent[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = text(r.id);
    const status = text(r.status)?.replace(/^:/, '');
    if (!id || !status || !STATUSES.includes(status)) continue;
    out.push({
      id,
      status: status as IntentStatus,
      statement: text(r.statement) ?? '',
      horizon: text(r.horizon),
      about: Array.isArray(r.about) ? r.about.filter((a): a is string => typeof a === 'string') : [],
      latest: observation(r.latest),
      proposedBy: text(r.proposed_by),
    });
  }
  return out;
}

/** What a verdict's standing is read from. */
type Standing = { status: IntentStatus; latest: Observation | null };

/** An open intent whose latest verdict is somebody else's `met`, `missed` or `dropped`. */
export function hasProposedVerdict(i: Standing): boolean {
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
  if (i.status === 'open') return hasProposedVerdict(i) ? 'proposed-verdict' : 'open';
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
      proposed: hasProposedVerdict(i),
      value: kernelValue(i),
      others: list.slice(1).map((o) => o.id),
    });
  }
  return out;
}

/** The axis, as the query compiler takes it: note id to its one value. */
export function axisValues(notes: Map<string, KernelNote>): Map<string, KernelValue> {
  const out = new Map<string, KernelValue>();
  for (const [id, k] of notes) if (k.value) out.set(id, k.value);
  return out;
}

/** The short id the kernel prints, for a table a person reads. The full id is what gets written. */
export const shortId = (id: string): string => id.slice(0, 8);
