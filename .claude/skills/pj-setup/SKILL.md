---
name: pj-setup
description: Set up a projector vault's channels and credentials — ask which sources this vault should sweep, verify each one actually answers, and write .projector/config.yaml. Use when a vault is new, when `pj intake` or a link says something is not configured, when asked to connect Jira / GitHub / Slack / Gmail, or when asked to check what projector can reach. Do not use to file or sort notes; those are the pj-capture and pj-triage skills.
---

# Setup

Decide what this vault reaches for, prove it reaches, and write it down.

**Verify, never assume.** A credential that was never set and one that is wrong look identical from
the outside, and the second is worse: intake goes quiet and nothing says why. `pj setup` makes the
request. A green line means something answered.

## 1. Read the current state before asking anything

```bash
pj setup --json
```

Every channel and every enrichment kind, each with a `status`:

| status | means | what you do |
|---|---|---|
| `ready` | it answered | nothing — say so and move on |
| `unconfigured` | nothing is set | offer it; `fix` is the exact change |
| `failing` | set, and refused or unreachable | say what failed; `fix` names the likely cause |
| `agent` | **you** fetch it over MCP; `pj` holds no credential | check whether you have that MCP server |
| `off` | this vault turned it off | leave it unless the user asks |

Lead with what already works. A user who has `gh` signed in and a Jira token in their environment
should be told they are two answers from done, not walked through five questions.

## 2. Ask only what is undecided

Three questions, and only for the ones the report leaves open.

**Which channels should this vault sweep?** Name what each is good for, in one line, and say that a
channel can be added later:

- `claude` — Claude sessions that moved. No credential; it reads `~/.claude` on this machine.
- `git` — your own branches and commits with nothing tracking them. Needs a project note to declare
  `project.repos`; there is nothing to sweep until one does.
- `jira` — issues that moved and concern you. Needs a host, an account and an API token.
- `slack`, `gmail` — **you** fetch these over MCP. Nothing to configure here; if you have no Slack
  MCP server, say so plainly rather than enabling a channel that will never produce anything.

A vault of reading notes wants none of these, and that is a legitimate answer: `channels: false`.

**Is enrichment wanted?** It resolves `jira:`, `gh:`, `claude:` and `doc:` refs into readable rows.
It is read-only and cached, but it is network traffic against work systems — and a vault with no such
links gains nothing from it. `enrich: false` and every link renders as its raw ref, which is exactly
what the app did before enrichment existed, so turning it off breaks nothing.

**Where should `pj work` put worktrees?** Only ask if they want `pj work`.

## 3. Write the file, then have them fill in the secrets

```bash
pj setup --init --channels claude,git,jira        # --no-enrich to turn enrichment off
```

This writes `.projector/config.yaml` and adds it to the vault's `.gitignore`. It **refuses to
overwrite** an existing file — if one is there, edit it rather than re-running `--init`.

**Never type a credential into the file yourself, and never ask the user to paste one to you.** Tell
them which keys to fill in and where the file is; they edit it. A token pasted into a conversation is
a token in a transcript. The same rule as `pj-capture`: a secret's value never enters a note, and it
never enters this chat either.

For Jira, what they need is an **Atlassian API token**, not their password —
`id.atlassian.com/manage-profile/security/api-tokens`. It pairs with the account email, not a
username.

GitHub is the exception with nothing to write: `pj` shells out to the `gh` CLI and holds no token of
its own. If `gh` is not signed in, the fix is `gh auth login`.

## 4. Verify again, and say what is still open

```bash
pj setup
```

Run it after they have edited. Report what changed. If something is still `failing`, give the
`fix` line and stop — do not try credentials yourself, and do not loop.

Finish by saying what this vault will now do on a bare `pj intake`, which is the enabled channels and
nothing else.

## What the file holds, and why it is not committed

`.projector/config.yaml` lives in the vault because a credential belongs to the channel that spends
it, and which channels are worth sweeping is a fact about *this* set of notes. It is gitignored: a
vault is often a git repository, and a token in one is a token pushed.

Every credential and path in it — `jira.*`, `git.author`, `workspaces`, `doc.url` — has a
`PROJECTOR_*` environment variable that means the same thing, and **the variable wins**. That is the
escape hatch — a one-off run against a different host, or CI — and the precedence only goes one way.
If a value looks wrong and the file looks right, something exported it. `channels:` and `enrich:`
live in the file only.

Where Claude itself lives is a fact about the machine rather than about the vault, so it stays an
environment variable: `PROJECTOR_CLAUDE_HOME`, `PROJECTOR_CLAUDE_DESKTOP`.
