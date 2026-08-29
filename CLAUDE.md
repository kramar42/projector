# Working on projector

This is the app itself, not a vault. For reading and writing notes in a vault, the `pj-about` skill is
the reference and the other four `.claude/skills/` do the work — none of that is repeated here.

## Commands

```bash
bun install
bun test
bun run typecheck
bun run build       # vite build → dist/
bun run serve       # 127.0.0.1:8092, serving dist/
bun run dev:web     # hot-reloading UI on 5176, alongside bun run serve
bun run pj -- ls    # the CLI, needs nothing running
bun run build:cli   # bun-only, like `bun test`: compiles the CLI to dist/pj (~60MB, instant startup)
```

**Bun is the default; Node 24+ is the floor.** Every project script invokes Bun directly, and Bun's
test runner (~10× faster than `node --test`) and startup time are part of the development loop — use
`bun test`, not `node --test`, unless Bun is genuinely absent. The code itself stays runtime-neutral:
`node --test`, `node src/server/serve.ts` and `node src/cli/pj.ts` all work, CI's node job proves it,
and that fallback is what runs in a shell where mise has not put Bun on PATH. Bun is the only
supported installer; there is no npm or pnpm lockfile.

**`bun run serve` serves `dist/`, not `src/`.** A UI change is invisible in the browser until
`bun run build` runs. A "the fix didn't take" reading at 8092 is almost always a stale bundle rather than
a wrong fix.

**`vaults/coverage` carries every state the app can draw** — every facet value, both ends of every
bucket, a blocking chain, a link of every kind including two that cannot resolve. The real vault only
exercises the states real work happens to produce, so use this one for anything visual. Its notes are
committed markdown; only the dates are derived, because `due` and `staleness` are computed against
today. So `bun run redate` first, then register it before the server will open it:
`bun run pj -- vaults add vaults/coverage --name coverage`.

## The docs are part of the test suite

`bun test` reads two of them. Editing them is not free-form:

- **[docs/DESIGN.md](docs/DESIGN.md)** — its frontmatter names the tokens, and the suite asserts they
  match the stylesheet and that every token reference resolves.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — its write-path table must list every write path
  and whether each is guarded, and its test table must name exactly the tests that exist. Adding a
  route or a test file means updating it in the same change.

## Invariants

`docs/ARCHITECTURE.md` opens with principles `C1`–`C11`. They are decided, the source cites them by
number, and most of the design is one of them being applied. Read them before adding a mechanism, and
cite the one you are applying in the comment. If a change seems to require breaking one, that is a
conversation, not a judgement call.

## Which document to update

| you changed | update |
|---|---|
| how a person uses it — a control, a flag, a key, the file format | [docs/MANUAL.md](docs/MANUAL.md) |
| a mechanism, a route, an invariant, the set of tests | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| a token, a colour, a rule about type or spacing | [docs/DESIGN.md](docs/DESIGN.md) |
| which token a component uses, or two components that diverged | [docs/DESIGN.md](docs/DESIGN.md) — *Named rules* |
| decided against something, or deferred it | [docs/NEXT.md](docs/NEXT.md) |

[docs/README.md](docs/README.md) has the boundaries between them written out.

Two habits the docs are held to: **no number that decays by working** — a count of notes or of rules
goes stale silently, so either pin it in a test or leave it out — and **one place per answer.** If a
second document would have to restate something to be complete, link instead.

## You are not the only session in this working tree

Several agents work in this repository at once, and that is the normal way it is used, not an
incident. Files you did not touch will change under you mid-task; the working tree will contain
work in progress that is not yours.

- **Do not report this as a problem.** A modified file you did not write needs no flag, no
  investigation and no paragraph in your summary. Leave it alone and carry on. Say what *you*
  changed; do not audit the rest of the tree.
- **Commit granularly and atomically** — one coherent change per commit, so somebody else's commit
  can land between yours without either needing untangling. Still never without consent, and never
  `git push`.
- **Never move the tree out from under another session.** No `git checkout`, no `switch`, no `stash`,
  no `reset`, no branch change, unless the user asks for it in so many words. These are the
  operations that destroy another agent's in-flight work, and they are silent when they do it.
- **Test counts and suite output include everyone's work.** If you need to speak precisely about
  what your change did, say so once and move on.

## Rules

- **Never commit without consent.** Never `git push`.
- The author's real vault lives outside this repository and nothing here describes it. Do not go
  looking for it, and prefer `vaults/coverage` for anything you need to look at.
- Nothing in this repo writes to Jira, GitHub, Trello or Slack (`C2`). Adding a code path that does
  is not a refactor.
