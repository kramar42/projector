import { ago, firstLine, gh } from '../sources/run.ts';
import { isUnavailable, unavailable, type Fetcher, type Tone, type Unavailable } from './types.ts';

/**
 * GitHub, through the `gh` CLI rather than the REST API directly, so it reuses
 * the credential already in the keyring and needs no token of its own.
 *
 * Every call here is a read: `pr view` and `api` GETs. There is no code path in
 * this file that mutates anything on GitHub.
 */

/** `gh:pr:ORG/repo#412` */
function parsePr(ref: string): { repo: string; number: string } | null {
  const m = ref.match(/^([^#]+)#(\d+)$/);
  return m ? { repo: m[1]!, number: m[2]! } : null;
}

/** `gh:branch:ORG/repo@ref` or `gh:commit:ORG/repo@sha` */
function parseAt(ref: string): { repo: string; rev: string } | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return null;
  return { repo: ref.slice(0, at), rev: ref.slice(at + 1) };
}

function stateTone(state: string, draft: boolean): Tone {
  if (draft) return 'neutral';
  if (state === 'MERGED') return 'accent';
  if (state === 'CLOSED') return 'bad';
  return 'good';
}

function checkTone(rollup: string): Tone {
  if (rollup === 'SUCCESS') return 'good';
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'bad';
  if (rollup === 'PENDING') return 'warn';
  return 'neutral';
}

interface PrJson {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  author?: { login?: string };
  headRefName?: string;
  reviewDecision?: string;
  statusCheckRollup?: { state?: string; conclusion?: string }[] | null;
  url: string;
}

function rollupOf(checks: PrJson['statusCheckRollup']): { label: string; tone: Tone } | null {
  if (!checks?.length) return null;
  const results = checks.map((c) => (c.conclusion || c.state || '').toUpperCase());
  const failed = results.filter((r) => r === 'FAILURE' || r === 'ERROR' || r === 'TIMED_OUT').length;
  const pending = results.filter((r) => r === 'PENDING' || r === 'IN_PROGRESS' || r === 'QUEUED').length;
  const passed = results.filter((r) => r === 'SUCCESS' || r === 'NEUTRAL' || r === 'SKIPPED').length;
  if (failed) return { label: `${failed} failing`, tone: checkTone('FAILURE') };
  if (pending) return { label: `${pending} running`, tone: checkTone('PENDING') };
  return { label: `${passed} passing`, tone: checkTone('SUCCESS') };
}

export const prFetcher: Fetcher = {
  ttl: 300,
  async fetch(ref) {
    const parsed = parsePr(ref);
    if (!parsed) return unavailable(`expected gh:pr:ORG/repo#123, got "${ref}"`);
    const res = await gh([
      'pr', 'view', parsed.number,
      '--repo', parsed.repo,
      '--json',
      'number,title,state,isDraft,additions,deletions,changedFiles,updatedAt,author,headRefName,reviewDecision,statusCheckRollup,url',
    ]);
    if (!res.ok) return ghFailure(res.stderr || res.stdout);

    let pr: PrJson;
    try {
      pr = JSON.parse(res.stdout) as PrJson;
    } catch {
      return unavailable('gh returned something that was not JSON');
    }

    const badges = [
      { label: pr.isDraft ? 'draft' : pr.state.toLowerCase(), tone: stateTone(pr.state, pr.isDraft) },
    ];
    const checks = rollupOf(pr.statusCheckRollup);
    if (checks) badges.push(checks);
    if (pr.reviewDecision === 'APPROVED') badges.push({ label: 'approved', tone: 'good' });
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') badges.push({ label: 'changes requested', tone: 'bad' });

    return {
      label: `#${pr.number}`,
      title: pr.title,
      badges,
      fields: [
        { k: 'repo', v: parsed.repo },
        { k: 'branch', v: pr.headRefName ?? '' },
        { k: 'author', v: pr.author?.login ?? '' },
        { k: 'changes', v: `+${pr.additions} −${pr.deletions} in ${pr.changedFiles} file(s)` },
        { k: 'updated', v: ago(pr.updatedAt) },
      ].filter((f) => f.v),
      url: pr.url,
    };
  },
};

export const branchFetcher: Fetcher = {
  ttl: 600,
  async fetch(ref) {
    const parsed = parseAt(ref);
    if (!parsed) return unavailable(`expected gh:branch:ORG/repo@name, got "${ref}"`);
    const res = await gh([
      'api',
      `repos/${parsed.repo}/branches/${encodeURIComponent(parsed.rev)}`,
      '--jq',
      '{sha:.commit.sha, msg:.commit.commit.message, author:.commit.commit.author.name, date:.commit.commit.author.date, protected:.protected}',
    ]);
    if (!res.ok) return ghFailure(res.stderr || res.stdout);
    let j: { sha: string; msg: string; author: string; date: string; protected: boolean };
    try {
      j = JSON.parse(res.stdout);
    } catch {
      return unavailable('gh returned something that was not JSON');
    }
    return {
      label: parsed.rev,
      title: firstLine(j.msg),
      badges: j.protected ? [{ label: 'protected', tone: 'warn' as Tone }] : [],
      fields: [
        { k: 'repo', v: parsed.repo },
        { k: 'head', v: j.sha.slice(0, 8) },
        { k: 'author', v: j.author },
        { k: 'committed', v: ago(j.date) },
      ].filter((f) => f.v),
      url: `https://github.com/${parsed.repo}/tree/${parsed.rev}`,
    };
  },
};

export const commitFetcher: Fetcher = {
  // A commit never changes, so there is nothing to revalidate.
  ttl: 0,
  async fetch(ref) {
    const parsed = parseAt(ref);
    if (!parsed) return unavailable(`expected gh:commit:ORG/repo@sha, got "${ref}"`);
    const res = await gh([
      'api',
      `repos/${parsed.repo}/commits/${encodeURIComponent(parsed.rev)}`,
      '--jq',
      '{sha:.sha, msg:.commit.message, author:.commit.author.name, date:.commit.author.date, add:.stats.additions, del:.stats.deletions}',
    ]);
    if (!res.ok) return ghFailure(res.stderr || res.stdout);
    let j: { sha: string; msg: string; author: string; date: string; add: number; del: number };
    try {
      j = JSON.parse(res.stdout);
    } catch {
      return unavailable('gh returned something that was not JSON');
    }
    return {
      label: j.sha.slice(0, 8),
      title: firstLine(j.msg),
      fields: [
        { k: 'repo', v: parsed.repo },
        { k: 'author', v: j.author },
        { k: 'committed', v: ago(j.date) },
        { k: 'changes', v: `+${j.add} −${j.del}` },
      ].filter((f) => f.v),
      url: `https://github.com/${parsed.repo}/commit/${j.sha}`,
    };
  },
};

/** Turn gh's stderr into something worth reading in a chip. */
function ghFailure(stderr: string): Unavailable {
  const s = stderr.toLowerCase();
  if (s.includes('could not resolve') || s.includes('not found') || s.includes('http 404')) {
    return unavailable('not found — check the org/repo and the number');
  }
  if (s.includes('authentication') || s.includes('gh auth login') || s.includes('http 401')) {
    return unavailable('gh is not authenticated for this repo — run `gh auth login`', true);
  }
  if (s.includes('command not found') || s.includes('spawn failed')) {
    return unavailable('the gh CLI is not on PATH', true);
  }
  return unavailable(firstLine(stderr) || 'gh failed');
}

export { isUnavailable };
