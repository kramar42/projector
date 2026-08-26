# Working on projector

This is the app itself, not a vault. For reading and writing notes in a vault, the `pj-about` skill is
the reference and the other three `.claude/skills/` do the work — none of that is repeated here.

## Commands

```bash
pnpm install
pnpm test           # node --test
pnpm typecheck
pnpm build          # vite build → dist/
pnpm serve          # 127.0.0.1:8092, serving dist/
pnpm dev:web        # hot-reloading UI on 5176, alongside pnpm serve
node src/cli/pj.ts  # the CLI, needs nothing running
```

**`pnpm serve` serves `dist/`, not `src/`.** A UI change is invisible in the browser until
`pnpm build` runs. A "the fix didn't take" reading at 8092 is almost always a stale bundle rather than
a wrong fix.

**`pnpm states` writes a vault carrying every state the app can draw** into `.vaults/states` —
every facet value, both ends of every bucket, a blocking chain, a link of every kind including two
that cannot resolve. The real vault only exercises the states real work happens to produce, so use
this one for anything visual. Register it before the server will open it:
`node src/cli/pj.ts vaults add .vaults/states --name states`.

## The docs are part of the test suite

`pnpm test` reads two of them. Editing them is not free-form:

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
| which token a component uses, or two components that diverged | [docs/COMPONENTS.md](docs/COMPONENTS.md) |
| decided against something, or deferred it | [docs/NEXT.md](docs/NEXT.md) |

[docs/README.md](docs/README.md) has the boundaries between them written out.

Two habits the docs are held to: **no number that decays by working** — a count of notes or of rules
goes stale silently, so either pin it in a test or leave it out — and **one place per answer.** If a
second document would have to restate something to be complete, link instead.

## Rules

- **Never commit without consent.** Never `git push`.
- The vault under `work/` is real work and is gitignored. Do not commit anything out of it, and
  prefer `.vaults/states` for anything you need to look at.
- Nothing in this repo writes to Jira, GitHub, Trello or Slack (`C2`). Adding a code path that does
  is not a refactor.
