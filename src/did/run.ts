import { readVault } from '../intake/run.ts';
import type { Day } from './day.ts';
import { gitSource } from './git.ts';
import { ctxOf, scopeOf } from './scope.ts';
import { vaultSource } from './vault.ts';
import type { Activity, DidReport, SourceReport } from './types.ts';

/** Every source, in the order a reader wants them: the durable traces first. */
export const DID_SOURCES = ['vault', 'git'] as const;

/**
 * One day, every source. A source that fails is that source's news, not the
 * report's — the same rule the intake sweep keeps.
 */
export async function did(root: string, day: Day, only: string[] = []): Promise<DidReport> {
  const unknown = only.filter((s) => !(DID_SOURCES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(', ')}. Known: ${DID_SOURCES.join(', ')}`);
  const vault = readVault(root);
  const ctx = ctxOf(vault);
  const scope = scopeOf(vault);
  const wanted = only.length ? only : [...DID_SOURCES];

  const sources: SourceReport[] = [];
  for (const name of DID_SOURCES) {
    if (!wanted.includes(name)) continue;
    try {
      if (name === 'vault') sources.push(vaultSource(ctx, day));
      if (name === 'git') sources.push(gitSource(ctx, scope, day));
    } catch (err) {
      sources.push({ source: name, fetched: false, reason: (err as Error).message, activities: [] });
    }
  }
  return {
    day: day.day,
    start: day.start.toISOString(),
    end: day.end.toISOString(),
    scope: { roots: scope.roots, repos: scope.repos.map((r) => r.path) },
    sources,
  };
}

const time = (iso: string) => (/T(\d{2}:\d{2})/.exec(iso) ? new Date(iso).toTimeString().slice(0, 5) : '     ');

function line(a: Activity): string {
  const head = `  ${time(a.at)}  ${a.kind.padEnd(13)} ${a.title}`;
  const more = [
    a.where ? `where: ${a.where}` : '',
    a.ref ? `ref: ${a.ref}` : '',
    a.notes?.length ? `notes: ${a.notes.map((n) => `${n.id} (${n.why})`).join(', ')}` : '',
  ].filter(Boolean);
  return [head, ...[...more, ...(a.detail ?? [])].map((m) => `                       ${m}`)].join('\n');
}

export function renderDid(r: DidReport): string {
  const out = [`# ${r.day} — ${r.sources.reduce((n, s) => n + s.activities.length, 0)} trace(s)`];
  out.push(`scope: ${r.scope.repos.length} repo(s) under ${r.scope.roots.length ? r.scope.roots.join(', ') : 'declared repos only'}`);
  for (const s of r.sources) {
    out.push('', `## ${s.source} (${s.activities.length})${s.fetched ? '' : ' — not fetched'}`);
    if (s.reason) out.push(`  ${s.reason}`);
    for (const a of s.activities) out.push(line(a));
  }
  return out.join('\n');
}
