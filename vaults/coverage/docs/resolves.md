# A doc link that resolves

`doc:` paths are relative to the vault root, so `doc:docs/resolves.md` finds this file and
renders its first heading as the title line under the label, which stays the filename. Its
sibling `doc:docs/absent.md` deliberately does not
exist, so the two failure paths sit side by side on one note.

This file has no frontmatter, so it is a note the app derived a name for. Its title is the
heading above; its id is `resolves`, from the filename.
