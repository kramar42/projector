// Reproducible post-import edits: Project A project config + the multi-layer card.
import { readFileSync } from 'node:fs';
const { patchKey } = await import('/Users/you/Code/work/cockpit/src/schema/frontmatter.ts');
const { writeCardFile } = await import('/Users/you/Code/work/cockpit/src/schema/card.ts');
const D = '/Users/you/Code/work/cockpit/data/cards';

// 1. Project A is a real project: repos and instructions its children inherit.
let f = `${D}/project-a.md`;
let t = readFileSync(f, 'utf8');
t = patchKey(t, 'project', {
  key: 'project-a', jira: 'PROJ', branch: 'project-a/{card}',
  repos: [
    { path: '~/Code/work/staging', base: 'main' },
    { path: '~/Code/work/live', base: 'main' },
  ],
});
t = t.replace('## Instructions\n\n_None recorded yet._', `## Instructions

- eu-dev/project-a is the only namespace safe to break. Never touch eu-test or prod from a card.
- Realm changes go through keycloak-config-cli, never hand-edited JSON.
- Prefer configuration over code; a change to acme-platform needs a reason.`);
writeCardFile(f, t);

// 2. The card that is unrepresentable in Trello: one card, two layers.
f = `${D}/l3-stuff-that-depends-l4.md`;
t = readFileSync(f, 'utf8');
t = patchKey(t, 'edges', [{ type: 'parent', to: 'project-a' }]);
t = patchKey(t, 'facets', { priority: ['now'], source: ['trello'], layer: ['layer-2', 'layer-3'] });
writeCardFile(f, t);

// 3. A blocks edge, so `ck next` has something real to withhold.
f = `${D}/fix-kpow-deployment.md`;
t = readFileSync(f, 'utf8');
t = patchKey(t, 'edges', [
  { type: 'parent', to: 'project-a' },
  { type: 'blocks', to: 'configure-conduktor-lenses-correct-msk-cluster' },
]);
t = patchKey(t, 'facets', { priority: ['now'], status: ['active'], source: ['trello'], tech: ['k8s', 'kafka'] });
writeCardFile(f, t);
console.log('demo edits applied');

// 4. Two levels of project config, so inheritance has something to union.
f = `${D}/project-b.md`;
t = readFileSync(f, 'utf8');
t = patchKey(t, 'project', {
  key: 'project-b', jira: 'SUPPORT',
  repos: [{ path: '~/Code/work/acme-platform', base: 'dev' }],
});
t = t.replace('## Instructions\n\n_None recorded yet._', `## Instructions

- Never change a realm in eu-prod without a ticket and a rollback plan.`);
writeCardFile(f, t);

f = `${D}/keycloak.md`;
t = readFileSync(f, 'utf8');
t = patchKey(t, 'project', {
  key: 'keycloak', branch: 'kc/{card}',
  repos: [{ path: '~/Code/work/infra', base: 'main' }],
});
t = t.replace('## Instructions\n\n_None recorded yet._', `## Instructions

- Realm config goes through keycloak-config-cli. Never hand-edit exported JSON.`);
writeCardFile(f, t);
console.log('two-level project chain configured');
