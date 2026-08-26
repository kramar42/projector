# The documents

Six documents, split by the question they answer. Each one is the only place its answer lives; where
two of them touch, the boundary is named below.

| | | |
|---|---|---|
| [MANUAL.md](MANUAL.md) | **how do I use it?** | the glossary, the model, the query language, the three shapes, links, intake, the CLI, the keymap, the file format, the toolchain |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **how does it work, and what must I not break?** | the principles `C1`–`C11`, the shape of the system, the query compiler, the index memo, the invariants, what it writes, the tests |
| [DESIGN.md](DESIGN.md) | **what should it look like?** | the palette, the type scale, surfaces, the component rules, and the exceptions that were accepted rather than fixed |
| [COMPONENTS.md](COMPONENTS.md) | **which token, in which arrangement, for which job?** | the tier between a token and a screen |
| [PRODUCT.md](PRODUCT.md) | **who reads this, and why?** | audience, purpose, positioning, the commitments that follow from them |
| [NEXT.md](NEXT.md) | **why isn't it doing X?** | where the model landed, and what is deliberately not being done |

[../README.md](../README.md) is the entry point — what this is, how to start it, and six words of
vocabulary. [../CLAUDE.md](../CLAUDE.md) is for an agent working on the app itself.

## Where the boundaries are

**MANUAL ends where the mechanism starts.** If a stranger needs it to *use* the app, it is in the
manual; if you need it to *change* the app without breaking it, it is in ARCHITECTURE. The manual
says a saved view is a query; ARCHITECTURE says why a URL, a `views/*.yaml` file and a set of `pj`
flags parse into one object.

**DESIGN names tokens, COMPONENTS spends them.** DESIGN owns the palette and the scale and the rules
that govern them. COMPONENTS owns the tier above: which of those tokens a count, a chip or a section
heading actually uses, and where two things that look alike are one pattern versus two that must stay
apart. A rule that turned out to be load-bearing after all is recorded in DESIGN's **Accepted
Exceptions**, not in COMPONENTS.

**The note format is written down once, and not here.** It lives in the `pj-about` skill, because its
audience is an agent editing files directly and an agent already loads that. MANUAL's *File format*
section shows a note and explains the parts a person needs; it is not the specification.

**NEXT.md is the register of things decided against.** A rejected idea goes there with its reason, so
it does not get re-proposed and does not clutter the document it was rejected from.

## Two of these are machine-checked

DESIGN's frontmatter and ARCHITECTURE's tables are read by the test suite: `bun test` fails if the
tokens named in DESIGN drift from the stylesheet, if a write path gains or loses a guard without
ARCHITECTURE's write-path table following, or if ARCHITECTURE names a test that does not exist. Edit
either of those two documents expecting the suite to have an opinion.

The other four are prose, and prose is what drifts.
