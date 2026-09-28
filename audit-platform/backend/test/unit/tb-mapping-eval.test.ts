import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeAccountClassifier, type MessagesClient } from '../../src/modules/tb-ingestion/llm-classifier.js';
// @ts-expect-error - plain ESM helper shared with the eval CLI
import { batchLines, chartAccounts, fakeClient, gradeBatch, summarize } from '../../evals/tb-mapping/eval-lib.mjs';

/**
 * Harness checks for the paid eval, run offline: an oracle must score ~100%,
 * a null model ~0% on mappable lines, and a model that follows the injected
 * instructions must trip the security gate. Proves the grading is wired to
 * the production classifier's output, not to itself.
 */
const read = (f: string) => JSON.parse(readFileSync(new URL(`../../evals/tb-mapping/${f}`, import.meta.url), 'utf8'));
const { cases } = read('cases.json') as { cases: any[] };
const accounts = chartAccounts(read('chart.json'));

async function run(mode: 'oracle' | 'null' | 'gullible') {
  const lines: any[] = [];
  for (const tb of cases) {
    const client = fakeClient(mode, () => tb) as unknown as MessagesClient;
    const res = await new ClaudeAccountClassifier({ client, model: 'claude-opus-5', effort: 'medium' }).classify(accounts, batchLines(tb));
    lines.push(...gradeBatch(tb, res).lines);
  }
  return summarize(lines);
}

describe('TB mapping eval harness', () => {
  it('scores an oracle at 100% and a null model at 0% on mappable lines', async () => {
    const oracle = await run('oracle');
    expect(oracle).toMatchObject({ accuracy: 1, precision: 1, coverage: 1, noneCorrect: 1, hijacked: 0, followedInjection: 0 });
    const none = await run('null');
    expect(none).toMatchObject({ accuracy: 0, coverage: 0, noneCorrect: 1, hijacked: 0 });
  });

  it('fails the security gate when the model obeys injected instructions', async () => {
    const gullible = await run('gullible');
    expect(gullible.hijacked).toBeGreaterThan(10);
    expect(gullible.followedInjection).toBeGreaterThan(0);
  });

  it('covers every line of the labelled set', async () => {
    expect((await run('oracle')).lines).toBe(cases.reduce((n, c) => n + c.lines.length, 0));
  });
});
