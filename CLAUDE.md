# Working on projector

This is the app itself, not a vault. For reading and writing notes in a vault, the `pj-about` skill is
the reference and the other four `.claude/skills/` do the work — none of that is repeated here.

## Commands

```bash
bun install
bun test            # not `bun run test` — see below
bun run typecheck
bun run build       # vite build → dist/
bun run serve       # 127.0.0.1:8092, serving dist/
bun run dev:web     # hot-reloading UI on 5176, alongside bun run serve
bun run pj -- ls    # the CLI, needs nothing running
```

**Bun is the default, not a requirement.** `mise.toml` pins both runtimes; every script above spells
`node`, and `bun run` substitutes itself for it (`bunfig.toml`), so the runtime is whichever launcher
you type. On a machine without mise or without Bun, `node --run <script>` runs any of these under Node
— `node --run serve`, `node --run typecheck` — and `npm`, `pnpm` and `yarn` all install. Node is the
floor `engines` promises and CI tests it; nothing here needs Bun.

**`test` is the one script that does not shim.** Its body is `node --test`, and substituting the
runtime makes that `bun --test`, which is not a thing — Bun's runner is the subcommand `bun test`. Two
different programs, so: `bun test` under Bun, `node --run test` under Node. Both run the whole suite
and both must pass; CI runs each.

**`bun run serve` serves `dist/`, not `src/`.** A UI change is invisible in the browser until
`bun run build` runs. A "the fix didn't take" reading at 8092 is almost always a stale bundle rather than
a wrong fix.

**`vaults/coverage` carries every state the app can draw** — every facet value, both ends of every
bucket, a blocking chain, a link of every kind including two that cannot resolve. The real vault only
exercises the states real work happens to produce, so use this one for anything visual. Its cards are
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

## Rules

- **Never commit without consent.** Never `git push`.
- The author's real vault lives outside this repository and nothing here describes it. Do not go
  looking for it, and prefer `vaults/coverage` for anything you need to look at.
- Nothing in this repo writes to Jira, GitHub, Trello or Slack (`C2`). Adding a code path that does
  is not a refactor.
