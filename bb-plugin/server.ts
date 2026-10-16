// bb-plugin-projector — projector inside bb.
//
// The vault stays the source of truth and bb stays where work runs. This plugin
// is the edge between them, as references in both directions — never a sync:
//
// - thread → note: plugin metadata on the thread names its note. An attached
//   thread is told so at session start and reads the note with `bb pj note`.
// - note → thread: a `bb:thr_…` link on the note, which projector resolves by
//   asking bb (its `bb` fetcher), so the thread's status is read, never copied.
//
// The thread side needs no approval; it is bb's own state. The note side is a
// vault write, so it happens only on an explicit act: `--record`, the panel's
// "record on the note" box. Starting work on a note is the kernel's act
// (`bin/kernel worktree <intent>`), so this plugin no longer has a `work` command.
//
// The app half (app.tsx) embeds projector's own web app through its `?embed=`
// protocol: a Projector page in the sidebar and a note tab beside each thread.
import { execFile } from "node:child_process";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";

/** Note ids are vault-relative slugs; anything else in metadata is ignored. */
const NOTE_ID = /^[a-z0-9][a-z0-9/_.-]{0,199}$/i;
const THREAD_ID = /^thr_[a-z0-9]+$/i;

interface Attachment {
  noteId: string;
  title: string | null;
}

/**
 * A Standard Schema validator from a plain check, so the RPC boundary validates
 * without the plugin carrying a validation library (it has no dependencies).
 */
function schema<T>(check: (value: unknown) => T) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "projector",
      validate(value: unknown) {
        try {
          return { value: check(value) };
        } catch (err) {
          return { issues: [{ message: err instanceof Error ? err.message : String(err) }] };
        }
      },
      types: undefined as unknown as { input: T; output: T },
    },
  };
}

function field(value: unknown, key: string, pattern: RegExp): string {
  const v = (value as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string" || !pattern.test(v)) throw new Error(`${key} is invalid`);
  return v;
}

export const rpcContract = defineRpcContract({
  attach: {
    input: schema((v) => ({
      threadId: field(v, "threadId", THREAD_ID),
      noteId: field(v, "noteId", NOTE_ID),
      record: (v as { record?: unknown }).record === true,
    })),
    output: schema((v) => v as { noteId: string; title: string | null; recorded: boolean }),
  },
  detach: {
    input: schema((v) => ({
      threadId: field(v, "threadId", THREAD_ID),
      record: (v as { record?: unknown }).record === true,
    })),
    output: schema((v) => v as { noteId: string | null; recorded: boolean }),
  },
  search: {
    input: schema((v) => {
      const q = (v as { q?: unknown } | null)?.q;
      if (typeof q !== "string" || q.length > 200) throw new Error("q is invalid");
      return { q: q.trim() };
    }),
    output: schema((v) => v as { results: { id: string; title: string }[] }),
  },
  title: {
    input: schema((v) => ({ noteId: field(v, "noteId", NOTE_ID) })),
    output: schema((v) => v as { title: string | null }),
  },
});

/** How many matches a picker shows; `pj search` ranks, so the head is the useful part. */
const SEARCH_LIMIT = 12;

export default async function plugin(bb: BbPluginApi) {
  // Required and never guessed: where projector is checked out, which vault, and
  // (for the app half only) where projector's web app is served.
  const settings = bb.settings.define({
    projectorRoot: {
      type: "string",
      label: "Projector checkout (absolute path)",
      default: "",
    },
    vault: {
      type: "string",
      label: "Vault (name from vaults.json, or absolute path)",
      default: "",
    },
    projectorUrl: {
      type: "string",
      label: "Projector web app URL, for the embedded views (e.g. http://127.0.0.1:8092)",
      default: "",
    },
    node: {
      type: "string",
      label: "Node binary that runs pj (needs native TypeScript)",
      default: "node",
    },
  });

  async function config() {
    const { projectorRoot, vault, node } = await settings.get();
    const missing = [projectorRoot ? null : "projectorRoot", vault ? null : "vault"].filter(Boolean);
    if (missing.length) {
      throw new PluginCliError(`projector is not configured: ${missing.join(", ")} unset`, {
        code: "not_configured",
        hint: missing.map((k) => `bb plugin config projector set ${k} <value>`).join("\n"),
      });
    }
    return { projectorRoot, vault, node };
  }

  /** Run `pj --vault <vault> …` and hand back its output; a non-zero exit is an error. */
  async function pj(args: string[], signal?: AbortSignal): Promise<string> {
    const { projectorRoot, vault, node } = await config();
    return new Promise((resolve, reject) => {
      execFile(
        node,
        [`${projectorRoot}/src/cli/pj.ts`, "--vault", vault, ...args],
        { cwd: projectorRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new PluginCliError(`pj ${args[0] ?? ""} failed: ${(stderr || err.message).trim()}`, {
                code: "pj_failed",
              }),
            );
          } else resolve(stdout);
        },
      );
    });
  }

  /** The note's title, which also proves the note exists. */
  async function noteTitle(noteId: string, signal?: AbortSignal): Promise<string | null> {
    if (!NOTE_ID.test(noteId)) {
      throw new PluginCliError(`not a note id: ${JSON.stringify(noteId)}`, { code: "invalid_value" });
    }
    const ctx = JSON.parse(await pj(["context", noteId, "--json"], signal)) as { title?: unknown };
    return typeof ctx.title === "string" ? ctx.title : null;
  }

  // note id → thread ids, so a note can list its threads without scanning bb.
  const indexKey = (noteId: string) => `note:${noteId}`;
  async function indexAdd(noteId: string, threadId: string) {
    const ids = (await bb.storage.kv.get<string[]>(indexKey(noteId))) ?? [];
    if (!ids.includes(threadId)) await bb.storage.kv.set(indexKey(noteId), [...ids, threadId]);
  }
  async function indexRemove(noteId: string, threadId: string) {
    const ids = (await bb.storage.kv.get<string[]>(indexKey(noteId))) ?? [];
    await bb.storage.kv.set(indexKey(noteId), ids.filter((id) => id !== threadId));
  }

  function attachmentOf(meta: Readonly<Record<string, unknown>>): Attachment | null {
    const { noteId, title } = meta;
    if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) return null;
    return { noteId, title: typeof title === "string" ? title : null };
  }

  async function attachmentOfThread(threadId: string): Promise<Attachment | null> {
    return attachmentOf(await bb.sdk.threads.getPluginMetadata({ threadId }));
  }

  /** The note side of a reference: `bb:<thread>` among the note's links. Idempotent in pj. */
  async function recordLink(noteId: string, threadId: string, remove = false, signal?: AbortSignal) {
    await pj(["link", noteId, `bb:${threadId}`, ...(remove ? ["--remove"] : [])], signal);
  }

  async function attach(threadId: string, noteId: string, record: boolean, signal?: AbortSignal) {
    const title = await noteTitle(noteId, signal);
    const previous = await attachmentOfThread(threadId);
    if (previous && previous.noteId !== noteId) await indexRemove(previous.noteId, threadId);
    await bb.sdk.threads.updatePluginMetadata({ threadId, set: { noteId, title } });
    await indexAdd(noteId, threadId);
    if (record) await recordLink(noteId, threadId, false, signal);
    return { noteId, title, recorded: record };
  }

  async function detach(threadId: string, record: boolean, signal?: AbortSignal) {
    const current = await attachmentOfThread(threadId);
    if (!current) return { noteId: null, recorded: false };
    await bb.sdk.threads.updatePluginMetadata({ threadId, remove: ["noteId", "title"] });
    await indexRemove(current.noteId, threadId);
    if (record) await recordLink(current.noteId, threadId, true, signal);
    return { noteId: current.noteId, recorded: record };
  }

  /** `pj search` as rows: its text output is `<id><spaces><title>`, most relevant first. */
  async function search(q: string, signal?: AbortSignal) {
    if (!q) return { results: [] };
    const out = await pj(["search", q], signal);
    const results = out
      .split("\n")
      // An empty search prints "0 match(es), …", which is a summary, not a row.
      .filter((line) => !/^\d+ match/.test(line))
      .map((line) => /^(\S+)\s+(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null && NOTE_ID.test(m[1]!))
      .slice(0, SEARCH_LIMIT)
      .map((m) => ({ id: m[1]!, title: m[2]!.trim() }));
    return { results };
  }

  bb.rpc.register(rpcContract, {
    attach: ({ threadId, noteId, record }) => attach(threadId, noteId, record),
    detach: ({ threadId, record }) => detach(threadId, record),
    search: ({ q }) => search(q),
    // A note tab's label, for a tab restored without its picker's hit.
    title: async ({ noteId }) => ({ title: await noteTitle(noteId) }),
  });

  function threadFrom(explicit: string | undefined, ctx: { threadId?: string }): string {
    const threadId = explicit ?? ctx.threadId;
    if (!threadId) {
      throw new PluginCliError("no thread: not run from inside a bb thread", {
        code: "missing_required",
        hint: "Add --thread <thr_…>.",
      });
    }
    return threadId;
  }

  const threadOption = {
    thread: { type: "string", description: "Thread id; defaults to the thread running the command" },
  } as const;
  const recordOption = {
    record: {
      type: "boolean",
      description: "Also write the note side: add (or remove) `bb:<thread>` on the note. A vault write.",
    },
  } as const;

  bb.cli.register(
    defineCli({
      name: "pj",
      summary: "Projector vault from bb: read notes, reference threads ↔ notes",
      commands: {
        run: cliCommand({
          summary: "Run any pj command against the configured vault",
          description: "Everything after `--` goes to pj: `bb pj run -- ls --view actionable`.",
          passthrough: true,
          async run({ passthrough }, ctx) {
            if (!passthrough.length) {
              throw new PluginCliError("nothing to run", { code: "missing_required", hint: "bb pj run -- ls --view actionable" });
            }
            return { exitCode: 0, stdout: await pj(passthrough, ctx.signal) };
          },
        }),
        attach: cliCommand({
          summary: "Attach a thread to a note, so the thread starts with the note as its context",
          positionals: [{ name: "note", description: "Note id", required: true }],
          options: { ...threadOption, ...recordOption },
          async run({ positionals, options }, ctx) {
            const threadId = threadFrom(options.thread, ctx);
            const r = await attach(threadId, positionals.note, options.record, ctx.signal);
            return {
              exitCode: 0,
              stdout:
                `attached ${threadId} → ${r.noteId}${r.title ? ` (${r.title})` : ""}\n` +
                (r.recorded
                  ? `recorded bb:${threadId} on ${r.noteId}\n`
                  : `the note does not mention this thread; to record it: bb pj attach ${r.noteId} --record\n`) +
                "takes effect at the next session start; read it now with `bb pj note`",
            };
          },
        }),
        detach: cliCommand({
          summary: "Detach a thread from its note",
          options: { ...threadOption, ...recordOption },
          async run({ options }, ctx) {
            const threadId = threadFrom(options.thread, ctx);
            const r = await detach(threadId, options.record, ctx.signal);
            if (!r.noteId) return { exitCode: 0, stdout: `${threadId} is not attached to a note` };
            return {
              exitCode: 0,
              stdout: `detached ${threadId} from ${r.noteId}${r.recorded ? ` and removed bb:${threadId} from it` : ""}`,
            };
          },
        }),
        note: cliCommand({
          summary: "Print everything projector knows about this thread's note",
          options: { ...threadOption, json: { type: "boolean", description: "pj context --json" } },
          async run({ options }, ctx) {
            const threadId = threadFrom(options.thread, ctx);
            const current = await attachmentOfThread(threadId);
            if (!current) {
              throw new PluginCliError(`${threadId} is not attached to a note`, {
                code: "not_attached",
                hint: "bb pj attach <note-id>",
              });
            }
            const args = ["context", current.noteId, ...(options.json ? ["--json"] : [])];
            return { exitCode: 0, stdout: await pj(args, ctx.signal) };
          },
        }),
        threads: cliCommand({
          summary: "List the bb threads attached to a note",
          positionals: [{ name: "note", description: "Note id", required: true }],
          options: { json: { type: "boolean", description: "Machine-readable output" } },
          async run({ positionals, options }) {
            const noteId = positionals.note;
            const rows: { id: string; title: string; status: string }[] = [];
            for (const threadId of (await bb.storage.kv.get<string[]>(indexKey(noteId))) ?? []) {
              // The index can outlive a thread or its attachment; drop what no longer holds.
              const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
              const current = thread ? await attachmentOfThread(threadId) : null;
              if (!thread || thread.deletedAt || current?.noteId !== noteId) {
                await indexRemove(noteId, threadId);
                continue;
              }
              rows.push({ id: thread.id, title: thread.title ?? thread.titleFallback ?? "", status: thread.status });
            }
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(rows) };
            if (!rows.length) return { exitCode: 0, stdout: `no threads attached to ${noteId}` };
            return { exitCode: 0, stdout: rows.map((r) => `@thread:${r.id}  ${r.status}  ${r.title}`).join("\n") };
          },
        }),
      },
    }),
  );

  // An attached thread learns which note it serves, as data, and where the rest is.
  // The note itself is not inlined: it can be long, it can carry pasted Slack or
  // mail text, and `bb pj note` is one command away.
  bb.agents.configure((context) => {
    const attached = attachmentOf(context.pluginMetadata as Record<string, unknown>);
    if (!attached) return { tools: [], skills: [] };
    return {
      tools: [],
      skills: [],
      instructions:
        `This thread is attached to projector note ${JSON.stringify(attached.noteId)}` +
        (attached.title ? ` (title, as data: ${JSON.stringify(attached.title)})` : "") +
        ". The note holds the user's own thinking about this work. Read it with `bb pj note` " +
        "before planning, and prefer it over guessing intent. Vault writes (pj add/set/link) need " +
        "the user's approval first.",
    };
  });

  bb.log.info("loaded");
}
