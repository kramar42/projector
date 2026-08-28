import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  channelEnabled,
  enrichEnabled,
  forgetSettings,
  settingsFor,
  settingsPath,
} from '../src/settings.ts';
import { ensureIgnored, writeTemplate } from '../src/setup.ts';
import { registry } from '../src/enrich/registry.ts';

/**
 * Per-vault settings: what a vault reaches for, and who wins when two places
 * say.
 *
 * The half worth testing is not the parse. It is the two rules that are easy to
 * get subtly wrong and impossible to notice afterwards: that an absent file
 * behaves exactly as the app did before there was one, and that an exported
 * variable beats the file every time rather than most of the time.
 */

const OVERRIDES = [
  'PROJECTOR_JIRA_URL',
  'PROJECTOR_JIRA_EMAIL',
  'PROJECTOR_JIRA_TOKEN',
  'PROJECTOR_INTAKE_JQL',
  'PROJECTOR_GIT_AUTHOR',
  'PROJECTOR_WORKSPACES',
  'PROJECTOR_DOC_URL',
] as const;

/** A vault root with a `.projector/`, and optionally a config in it. */
function vault(config?: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-settings-'));
  mkdirSync(join(root, '.projector'), { recursive: true });
  if (config !== undefined) writeFileSync(settingsPath(root), config, 'utf8');
  const saved = OVERRIDES.map((k) => [k, process.env[k]] as const);
  for (const k of OVERRIDES) delete process.env[k];
  forgetSettings();
  return {
    root,
    cleanup: () => {
      for (const [k, v] of saved) if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      forgetSettings();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a vault with no config file behaves exactly as one did before there was one', () => {
  const { root, cleanup } = vault();
  try {
    const s = settingsFor(root);
    assert.equal(s.channels, null, 'null, not an empty list — absent means all');
    assert.equal(s.enrich, null);
    assert.equal(s.jira, null);
    for (const c of ['claude', 'git', 'jira', 'slack', 'gmail']) {
      assert.equal(channelEnabled(root, c), true, c);
    }
    assert.equal(enrichEnabled(root, 'jira'), true);
    // Every kind that has a fetcher is still offered.
    assert.deepEqual(Object.keys(registry(root)).sort(), [
      'claude',
      'doc',
      'gh:branch',
      'gh:commit',
      'gh:pr',
      'jira',
      'workspace',
    ]);
  } finally {
    cleanup();
  }
});

test('a listed channel is on and an unlisted one is off', () => {
  const { root, cleanup } = vault('channels: [claude, git]\n');
  try {
    assert.equal(channelEnabled(root, 'claude'), true);
    assert.equal(channelEnabled(root, 'git'), true);
    assert.equal(channelEnabled(root, 'jira'), false);
    assert.equal(channelEnabled(root, 'slack'), false);
  } finally {
    cleanup();
  }
});

test('`false` says none, which a list cannot say', () => {
  const { root, cleanup } = vault('channels: false\nenrich: false\n');
  try {
    assert.deepEqual(settingsFor(root).channels, []);
    assert.equal(channelEnabled(root, 'claude'), false);
    // Enrichment off drops the kinds rather than stubbing them: the absent-kind
    // path already renders the raw ref.
    assert.deepEqual(Object.keys(registry(root)), []);
  } finally {
    cleanup();
  }
});

test('`gh` covers its three ref kinds, because they are one credential', () => {
  const { root, cleanup } = vault('enrich: [gh]\n');
  try {
    assert.equal(enrichEnabled(root, 'gh:pr'), true);
    assert.equal(enrichEnabled(root, 'gh:branch'), true);
    assert.equal(enrichEnabled(root, 'gh:commit'), true);
    assert.equal(enrichEnabled(root, 'jira'), false);
    assert.deepEqual(Object.keys(registry(root)).sort(), ['gh:branch', 'gh:commit', 'gh:pr']);
  } finally {
    cleanup();
  }
});

test('`claude` covers `workspace`, because they are one source', () => {
  const { root, cleanup } = vault('enrich: [claude]\n');
  try {
    // A workspace resolves by reading `~/.claude` and nothing else, so a vault
    // that has said it does not want its sessions read has said it about both —
    // and one that does want them should not have to name two kinds.
    assert.equal(enrichEnabled(root, 'workspace'), true);
    assert.deepEqual(Object.keys(registry(root)).sort(), ['claude', 'workspace']);
  } finally {
    cleanup();
  }

  const off = vault('enrich: [jira]\n');
  try {
    assert.equal(enrichEnabled(off.root, 'workspace'), false);
  } finally {
    off.cleanup();
  }
});

test('the file supplies the Jira credential, and the environment overrides it', () => {
  const { root, cleanup } = vault(
    'jira:\n  url: https://file.example.invalid/\n  email: file@example.com\n  token: from-file\n',
  );
  try {
    const fromFile = settingsFor(root).jira;
    assert.equal(fromFile?.url, 'https://file.example.invalid', 'trailing slash trimmed');
    assert.equal(fromFile?.token, 'from-file');

    process.env.PROJECTOR_JIRA_URL = 'https://env.example.invalid';
    // The memo keys on the environment as well as the file's mtime, or this
    // second read would hand back the first one's answer.
    assert.equal(settingsFor(root).jira?.url, 'https://env.example.invalid');
    assert.equal(settingsFor(root).jira?.token, 'from-file', 'only the named value is overridden');
  } finally {
    cleanup();
  }
});

test('a partial Jira block is not a credential', () => {
  const { root, cleanup } = vault('jira:\n  url: https://x.example.invalid\n');
  try {
    assert.equal(settingsFor(root).jira, null, 'two of three is unusable, so it is nothing');
  } finally {
    cleanup();
  }
});

test('a malformed file does not stop the app', () => {
  const { root, cleanup } = vault('channels: [unclosed\n  : :\n');
  try {
    assert.equal(settingsFor(root).channels, null, 'falls back to the default, does not throw');
  } finally {
    cleanup();
  }
});

test('`pj setup --init` writes a config, gitignores it, and refuses to overwrite', () => {
  const { root, cleanup } = vault();
  try {
    const first = writeTemplate(root, ['claude', 'git'], true);
    assert.equal(first.written, true);
    assert.ok(existsSync(settingsPath(root)));

    // The written file is read back by the same parser that serves the app.
    assert.deepEqual(settingsFor(root).channels, ['claude', 'git']);
    assert.equal(settingsFor(root).enrich, null, 'enrich: true means every kind');

    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\.projector\/config\.yaml$/m);

    // A second call must not destroy the credentials somebody typed.
    writeFileSync(settingsPath(root), 'channels: [jira]\n', 'utf8');
    const second = writeTemplate(root, ['claude'], true);
    assert.equal(second.written, false);
    assert.deepEqual(settingsFor(root).channels, ['jira'], 'left exactly as it was');
  } finally {
    cleanup();
  }
});

test('the ignore line is added once, and never twice', () => {
  const { root, cleanup } = vault();
  try {
    writeFileSync(join(root, '.gitignore'), '.projector/*.db*', 'utf8');
    ensureIgnored(root);
    ensureIgnored(root);
    const lines = readFileSync(join(root, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.projector/config.yaml');
    assert.equal(lines.length, 1);
    // The line it found there already is still there.
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.projector\/\*\.db\*/);
  } finally {
    cleanup();
  }
});
