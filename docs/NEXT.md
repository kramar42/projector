# Next

What is deliberately not being done, and why. An entry carries its reason and, where there is one, the
condition that would change the answer — so an idea is re-opened by its trigger firing rather than by
being forgotten and re-proposed.

## Where the model landed

P6 removed what was stored twice, P7 collapsed relations into reference facets, P8 gave facets a type.
The result is described in [MANUAL.md](MANUAL.md) and [ARCHITECTURE.md](ARCHITECTURE.md); the phase
documents it was designed in are gone, because the design is the code now and a second place saying so
would only drift.

Nothing in the model is presently known to be wrong, and several of its mechanisms are finished but
**idle for lack of data**: `blocked_by` carries a single value across the whole vault, `owner` is set
on one note, `waiting_on` on almost nothing, and no deadlines are set anywhere. That is how the
since-removed `pj next` filtered on a deleted facet unnoticed for two days — with no data, an empty
answer looks plausible. Several entries below are parked on exactly this, and say so.

One decision worth remembering: **`parent` is `single: true`.** Nothing had ever created a second
parent, so it states what was already true. Flip the flag if a note genuinely needs to be part of two
things.

## Parked

- **Vault-wide instructions — a root `AGENTS.md` every note inherits.** Instructions now live in
  `AGENTS.md` beside a project note, and the vault root's copy is deliberately *not* read: inheritance
  flows along the `project` facet, and a root file is on no chain, so reading it would attach the
  vault's rules to every root-level project note and to no other note in the vault — a rule that
  applies to some notes for a reason nobody can see. The honest version is a separate mechanism:
  instructions that apply to the vault regardless of membership, resolved before the chain rather than
  as part of it. Worth doing when a second vault exists with rules that are genuinely about the vault
  rather than about one project — one vault's worth of evidence cannot tell those apart, and the
  natural place to write them today is the outermost project, which costs nothing and is honest about
  what it is inheriting. Note that a root `AGENTS.md` is already excluded from the note walk, so the
  file can be written now and simply not read yet.

- **A project that is one flat file cannot carry instructions.** `platform.md` with a `project:` block
  is still a project in every other respect — repos, `jira`, `branch`, membership, roll-ups — but there
  is nowhere beside it to put an `AGENTS.md` that is not the vault's own. The fix is to make it a
  folder, which is a `git mv` and nothing else, and the id does not change. Left as it is because the
  alternative is a second convention for the same file (`platform.AGENTS.md`, or a key pointing at a
  path), and one project having two spellings of its instructions is the thing this change removed.
  The panel's *make it a project* toggle therefore produces a project that cannot state how its work is
  done until it is moved; if that turns out to be a common dead end, the toggle creating the folder is
  the smaller change.

- **The aging view — who owes me what, and for how long.** A table filtered to `blocked: [waitingon]`,
  sorted by staleness descending, showing `waiting_on` and the project: a nudge list in the order the
  nudges are overdue. It needs no new mechanism — both axes compute, and it is one view file. Parked on
  the data problem above: shipped now it would read empty and teach that the axis is decorative, so set
  `waiting_on` for a fortnight of real weeks first. One design question when it lands: staleness is
  measured from the file's `updated`, not from when the waiting started, so editing the body resets the
  clock in exactly the case the view exists for. Either accept the approximation and say so, or
  `waiting_on` needs a date beside the person — a shape the vocabulary does not have.

- **Per-column summaries.** A built-in summary is a named aggregate — count, sum, average, min, max —
  which needs no parser, and `type: number` exists so the arithmetic ones would mean something. Two
  reasons to wait: it would not retire `projectRollups`, whose `direct`/`total` is a transitive walk
  over the membership graph rather than an aggregate over the visible set, so the mechanism would sit
  beside the special case instead of absorbing it; and there is nothing to aggregate — no numeric facet
  in use, no deadlines. **It now has one concrete customer.** `untriaged` left `projectRollups` with
  the `expected:` key it stood on, and nothing replaced it: a per-project count of half-filed notes is
  an aggregate over a query — `views/needs-status.yaml` grouped by `project` — which is exactly this
  and was not worth a bespoke config key on one rollup while its three siblings had none. Worth noting
  what that column could never count: a note with no project is not reachable from any project, so the
  unfiled notes were never in it.

- **`container: true`, when the proxy breaks.** Three semantics are inferred from `single: true` on a
  reference facet: which notes are siblings, which relation the bulk bar's "set …" button writes, and
  which axes `pj log` narrates. It is a good proxy — one value is what makes a container a container —
  with one failure: a vault declaring two single-valued relations gets the button by declaration order,
  arbitrarily. Add the key the first time a vault has two containers and the wrong one wins; adding it
  in advance is how the vocabulary grows keys nobody sets.

- **`subtitle: true`, the last per-facet affordance.** `RecordPicker` draws a note's project under its
  title by reading the built-in facet directly — legal, but the last place one axis has UI no other
  axis can have. Generalise it the moment a second axis wants it; until then it is a key with exactly
  one setter, which is the shape of a thing that drifts.

- **The keyboard's three leftovers.** `⌥j`/`⌥k` reordering within a column is cheap — a splice through
  `saveArrangement` — and idle until a saved view is the thing being worked in; on an ad-hoc query
  there is no file for the order to live in. A view's own `key:` (the fix facets already have, for
  `⌥1`–`⌥9` renumbering when a view is added) is not worth it until the rail's order actually churns.
  And focus restore on closing the panel: the cursor *is* that card and `j` picks up from it, so the
  cost is one Tab in the rare case.

- **The palette (`.`).** Bound in the grammar, acts on nothing. The shape was never the question — the
  bulk bar's state machine with `RecordPicker`'s type-to-filter over the front of it — but its job
  keeps shrinking: `gf` and `g⇧F` reach every axis whether or not it declares a letter, so the honest
  residual is the commands that are not axes — merge and save-as-view, both two keystrokes away in the
  rail, and delete, which is deliberately unbound and staying that way. Build it when the vocabulary
  has more axes worth reaching than there are letters, or when a third command has no rail row and no
  key — the moment it stops being a nicer way to do what a key already does. Earlier than that it is a
  second copy of every binding, and the first to drift is the one nobody presses.

- **An open axis still draws its whole vocabulary.** `FacetEditor` renders every declared value with
  the note's actual one merely lit, so a carried label axis is as tall as its vocabulary. The shape
  already exists twice — the `ref` and `date` branches open a `PopoverButton` — so a values-only
  readout expanding to the picker on click is the third case of a pattern. Do it when an `open: true`
  axis is in daily use, or when one declares more values than a row can hold.

- **The link field is documented by a placeholder**, which disappears on the first keystroke — the
  documentation goes away exactly when it is needed. A `+ link` control opening a kind picker would
  also label the genuinely awkward case, pasting an opaque `claude:local_…` id; `LINK_KINDS` already
  declares each kind with a glyph and a hue, so the picker's contents are data. Filed rather than fixed
  because the part that lost work is fixed — Escape stops at the field — and what remains is
  discoverability for a syntax the README also states.

- **Contrast is the rule prose still guards.** `test/theme.test.ts` refuses raw steps, stray hues and
  classes that resolve to no rule; it says nothing about whether two colours can be read against each
  other, and the one regression of that kind — a `dt` label receding to 3.16:1, under the floor — was
  found by measuring, not by testing. A ratio needs resolved colour: a browser, or resolving the custom
  properties in the test. The second is cheaper and bounded — tokens on `:root` plus one override
  block — and the next contrast regression is what makes it worth the afternoon.

- **The tier-1 ordering is emergent, and nothing pins it.** `project` and `parent` land first and
  adjacent among the reference facets because of two files' line order, not because any code says so.
  That is the right architecture, and silently undoable by a vocabulary edit. A test asserting what the
  reference tier's first rows are would pin the outcome without the panel naming a facet.

- **Native `confirm()` at the high-stakes moments.** The app draws its own checkboxes and selects on
  the grounds that a browser-drawn control is a seam, then hands the most consequential moments to the
  browser wholesale. Filed rather than fixed because a native dialog cannot be styled into looking
  dismissible, cannot be missed, and blocks — which is most of what a confirm is for. What changes the
  answer is the first prompt that needs to show something a string cannot: the project-block prompt
  already wants to be a list and settles for naming the kinds.

- **A body checkbox should toggle.** The rendered body draws each `- [ ]` as a real checkbox and
  nothing listens — the panel's one false affordance, found the way false affordances are found: by
  someone clicking it twice and concluding the app is broken. The fix is bounded and needs no new write
  path: map the box's ordinal to the nth task marker in the source — the orders agree, since only a
  real task item becomes a checkbox — flip that one character, and go through `write.body`, the same
  mtime-guarded write the editor uses (C10). Until it lands, the honest interim is rendering the boxes
  `disabled`, so the cursor says what a click will do.

- **Three small panel things.** `updated` sits in the workshop block without the `ƒ` that marks its
  neighbours as resolved rather than stored. `.refchip-title` ellipsises at `26ch` while a `.reflink`
  row takes a full line, so the same note reads shorter as a Part-of chip than as a Children row. And
  `+ record` cannot mint a note that does not exist yet — the only one of the three with a design
  question in it, since a picker has no board column to inherit a facet from, only the axis it was
  opened from and the note that opened it. `CommitInput` belongs to the same list: used in the rail and
  the canvas, used nowhere in the panel, whose remaining plain-Enter fields are exactly its shape.

- **`⏎` on a Tab-focused panel action.** The key map claims `⏎` as `open`, which activates a focused
  item only inside a `[data-navlist]`; the panel corner is not one, so tabbing to the trash or to Start
  and pressing `⏎` opens the cursor's note instead of pressing the button. It fails safe in both cases
  — a wart, not a bug. The fix is either the corner becoming a navlist (which would also put Delete in
  the `j`/`k` walk, and it is not obvious that it should be) or `open` pressing any focused panel
  button; neither is worth deciding while the buttons are also reachable by `!` and by mouse.

- **A second `pj intake rejudge` rewrites what the first one wrote.** Its facet half is idempotent — the
  same values validate to the same values — but its prose half is not: a model rewords, so a card
  titled *"TOS L3 workflow app: UI builder, not Temporal"* comes back *"TOS L3 workflow orchestration UI
  builder"* and the run reports it rewritten. Harmless in itself, but every rewrite stamps `updated`,
  and `updated` is what `staleness` is computed from — so rejudging fifty cards makes fifty cards look
  worked on today, which is exactly the reading that axis exists to give honestly.

  Not fixed because the obvious repairs are worse than the wart. Comparing prose loosely needs a
  threshold nobody can defend; leaving the title alone when it is "already good" needs "good" to be
  decidable. What would change the answer is `staleness` reading a stamp that only a person's edit
  moves — which is a second timestamp, and the reason `created` and `updated` are the only two is that a
  third has never earned itself.

- **The C4 guard knows two spellings and there is a third.** `no facet a vault declares is named in
  the code that serves every vault` catches a literal — `'source'` — and a property access —
  `rec.facets.source`. It does not catch an **unquoted key in a facet map**, which is how a facet map is
  actually written: `materialise` spells `{ source: [channel] }` and passes clean.

  That one is real rather than hypothetical — the sweep tags a note with the channel that found it, on
  an axis only the seeded vocabulary promises. It degrades honestly (a vault without the axis is simply
  not tagged) and `views/intake.yaml` groups by the same name, so the convention is at least consistent
  with itself. But it is a convention the code depends on, which is what C4 exists to stop.

  Not fixed by widening the pattern, which was tried: `status:` appears in a dozen interfaces and every
  probe object in `setup.ts`, so a key-shaped rule is mostly false positives, and the map that matters
  spans several lines where the guard reads one. The honest repair is to make the axis a vault setting
  with `source` as its default — then the code names a config key and a vault that calls it `origin`
  says so. Filed rather than done because it is a schema change for one call site, and worth doing when
  a second one wants the same thing.

- **The secrets rule is asked of a model, not applied by code.** Both prompts that reach one — the
  classifier's and the fetching agent's — say a credential's value must never be reproduced, and a test
  pins the wording. But the maxim under *Ideas from elsewhere* applies: never ask a model to honour a
  rule that can be applied deterministically. Full secret detection is not deterministic; the common
  shapes are — an AWS key id, a `ghp_` token, a PEM header — and a scrub at `materialise` time would
  sit on the one seam every unattended write crosses, catching the model that forgot. Known shapes
  only: redacting anything that merely looks entropic would eat commit hashes.

- **`pj work` does not resume a *finished* session in the workspace.** It reopens a live one and
  starts a new one otherwise, and a closed transcript in that directory stays history rather than
  becoming the thing the command lands you in. The reasoning is that "continue where I left off" and
  "start the next piece of work" are different intentions that produce the same keystroke, and
  guessing between them silently is what the reconnect was added to stop doing. Both are visible
  either way — the note's `workspace:` row lists every session the directory has held, live and
  closed, and each carries its own way back in. What changes the answer is wanting the *keystroke* to
  resume: then it needs to ask rather than pick, and a `confirm()` is already the wrong shape for that
  (see the native-dialog entry above).

## Decided against

- **`created` and `updated` as facets.** They are note fields, so `sort` accepts them and `filter` and
  `groupBy` do not. Making `updated` an app-owned facet was looked at properly and rejected: its values
  do not live in `rec.facets`, so it would be the first facet needing a branch in the engine's two
  reads; every facet in the map is editable by construction, so it needs a read-only key with exactly
  one setter; and the name is reserved precisely so one axis cannot have two sources. It would also
  move the asymmetry rather than remove it — `created` and `title` stand in the same place. **If it is
  ever picked up, the shape is a raw value on a computed axis**: `Computed` gains an optional `raw`, so
  `staleness` shows the date and filters the bucket — the rule an ordered facet already follows —
  `created` joins with no new machinery, and the static `Updated` column retires. Not now because
  `staleness` covers the common case and nothing has asked for the rest.

- **The expression language.** Moving the five computed axes into `facets.yaml` needs one, and the
  hardest case cannot be a per-note expression at all: `blocked` is an aggregate pass over every note's
  blocking references. The case has been weak since P8 anyway — each of the five computes over
  something a facet *cannot* describe, so `COMPUTED` is a coherent residual job rather than a holding
  pen.

- **Tokenizing spacing.** `font-size` and `border-radius` are tokens and the suite refuses a raw one;
  `padding`, `gap` and `letter-spacing` are deliberately not. A type step is a *scale* — one value,
  reused, where a new one is almost always a mistake. Spacing is two-axis measurements tuned against
  their own contents, and naming them would either invent a fake ladder or produce forty tokens with
  one user each — the clutter the naming was supposed to prevent. What changes the answer is a real
  repeat: the same padding pair in five unrelated components. Until then the guard covers type and
  shape but not rhythm, and says so rather than implying the stylesheet is fully policed.

- **A modal panel.** The panel critique wanted a focus trap, `inert` on the background and focus
  restore on close. It got the opposite, deliberately: the cursor is the only pointer, so an open panel
  *is* the cursor's card and `j` turns the page to the next one — a trap would break the single most
  useful thing the keyboard does. The panel is an `<aside>`, not a dialog, and the one genuinely open
  piece — focus restore — is filed under the keyboard leftovers above.

## Ideas from elsewhere

[Watchtower](https://github.com/Ruben-M-D/Watchtower) is a public MIT-licensed triage agent: it polls
Jira, Gmail, IMAP and GitHub read-only, scores every item with a local model, and pushes what clears a
threshold to a private bot. Its two big ideas — the durable queue, and calibrating the judgement from
the decisions a person already made — landed with intake. What follows is the smaller, separable
things it still does better.

- **A hard rule the source only asserts in a comment.** C2's whole enforcement is a docstring saying
  `Only GET is ever issued`. Watchtower's `audit_readonly.sh` fails the build on a non-GET verb in a
  source adapter — with a negative lookbehind so a local route decorator is not mistaken for an
  outbound write, and per-file patterns so a method name that is a write in one API is not flagged in a
  file that cannot call it. Its weakness — a hardcoded list of watched files — is exactly the half our
  write-path table already gets right. So the pairing is the work: assert that every file under
  `src/sources/` and `src/enrich/` appears in the table, then grep those files for a verb other than
  GET. One test, and C2 is checked rather than trusted.

  **The stakes went up after this was filed.** When it was written, the worst a mistake could do was a
  `POST` in a fetcher nobody would notice. The agent-fetched channels now hand an agent real tools in
  Slack and Gmail — the two services C2 names — and the only thing between that and a write is a list in
  a config file. Nothing checks that the listed tools are reads, nothing checks that the list is a list
  rather than a wildcard, and nothing fails a build if either changes. A grep over the adapters no
  longer covers the whole rule; the allowlist wants a check of its own.

- **A verb allow-list checked before the subprocess spawns.** A frozen set of safe git verbs, plus the
  flags that are writes wearing one — `branch -D`, `remote add`, `config --global` — refused before
  spawning. `src/agent/` runs git for worktrees and history and does not have this shape; worth having
  wherever a verb is assembled rather than literal.

- **Enforce the hard rule in code, then say that you did.** A deterministic floor is applied *after*
  the model returns rather than asked for in the prompt, and when it fires, the stored reason is
  prefixed with what caused it — so the override is visible where its effect shows. This is the maxim
  the secrets entry above leans on.

- **A prior per person, with a cold start that makes it honest.** Marked/skipped rates per sender,
  offered to the classifier as *"a prior, not a rule — override it when the content diverges"*, and
  returning nothing at all below a few observations so the base rubric applies cleanly. Parked for the
  data reason at the top: `owner` and `waiting_on` are nearly unset, so it would ship computing over an
  empty table and prove nothing.

- **A channel that declares its own configuration.** Watchtower sources declare their connect forms as
  JSON Schema, so a new source is one file — and a `help_url` links straight to where the credential is
  minted. Our `Channel` declares `name`, `defaultDays` and `collect`, while how-to-configure-it lives
  in `src/setup.ts` and the `/pj-setup` skill's prose. Declaring it on the channel would move that to
  the one place that already knows.

- **Two orthogonal columns instead of one overloaded status.** "Was surfaced" on its own timestamp,
  separate from the status the person owns, and the notifier never touches the latter. Quiet hours are
  then not a state at all — they leave the timestamp null, so the item stays visible, nothing re-pushes
  it, and nothing has to lie. The shape for any "surfaced" axis, if the queue ever needs one.

- **Optional integrations that are absent rather than broken.** Three distinct failures — not
  configured, configured but unreachable, and a structured upstream error carrying status, detail and
  URL — with unconfigured resolving to a feature that is simply off: no broken control, no console
  error. `pj intake`'s `fetched: false` with a `reason` is the same instinct; the three-way split is
  what the enrich fetchers and the Jira credential do not have.

- **A launcher that checks its own build.** Refuse a second instance and say why — two pollers double
  every notification and race on one SQLite file — and compare the UI sources' mtime against the built
  output before serving, because a stale build silently means API up, no dashboard. We document that
  footgun instead of closing it: a staleness check in `serve` would retire CLAUDE.md's stale-bundle
  paragraph. The only one of these that needs no design thought at all.
