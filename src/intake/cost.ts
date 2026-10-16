import type { Cost } from './types.ts';

/**
 * What a model call cost, read and summed. The judge is the one part of a pass
 * that spends anything, and a pass that took two minutes and forty thousand
 * tokens looks, from the board, exactly like one that took two seconds — so
 * every channel line and the tick line carry it.
 */

/**
 * What a `claude -p --output-format json` run cost, read off its envelope.
 *
 * Every field is optional on the way in because the envelope has grown fields
 * over releases and a missing one must not turn a judged channel into a held
 * one. `ms` falls back to the caller's own clock.
 */
export function costFromEnvelope(env: Record<string, unknown>, elapsedMs: number): Cost {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const usage = (env.usage ?? {}) as Record<string, unknown>;
  const input =
    (num(usage.input_tokens) ?? 0) +
    (num(usage.cache_creation_input_tokens) ?? 0) +
    (num(usage.cache_read_input_tokens) ?? 0);
  const output = num(usage.output_tokens);
  const cost: Cost = { ms: num(env.duration_ms) ?? elapsedMs };
  if (input) cost.inputTokens = input;
  if (output !== undefined) cost.outputTokens = output;
  const usd = num(env.total_cost_usd);
  if (usd !== undefined) cost.costUsd = usd;
  const turns = num(env.num_turns);
  if (turns !== undefined) cost.turns = turns;
  return cost;
}

export function renderCost(c: Cost | undefined): string {
  if (!c) return '';
  const parts = [`${(c.ms / 1000).toFixed(1)}s`];
  if (c.inputTokens !== undefined || c.outputTokens !== undefined) {
    parts.push(`${k(c.inputTokens ?? 0)} in / ${k(c.outputTokens ?? 0)} out tok`);
  }
  if (c.turns !== undefined) parts.push(`${c.turns} turns`);
  if (c.costUsd !== undefined) parts.push(`$${c.costUsd.toFixed(3)}`);
  return parts.join(' · ');
}

function k(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function addCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const out: Cost = { ms: a.ms + b.ms };
  const i = sum(a.inputTokens, b.inputTokens);
  const o = sum(a.outputTokens, b.outputTokens);
  const u = sum(a.costUsd, b.costUsd);
  const t = sum(a.turns, b.turns);
  if (i !== undefined) out.inputTokens = i;
  if (o !== undefined) out.outputTokens = o;
  if (u !== undefined) out.costUsd = u;
  if (t !== undefined) out.turns = t;
  return out;
}
