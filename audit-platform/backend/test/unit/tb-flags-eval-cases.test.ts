import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nameFlags } from '../../src/modules/tb-ingestion/flags.js';

/**
 * The injection flag decides which suggestions a reviewer must open one by
 * one, so it needs both properties on the hand-labelled eval set
 * (evals/tb-mapping/cases.json): every injection attempt is flagged, and no
 * genuine account name is (a false flag trains reviewers to ignore it).
 */
interface Line { id: string; name: string; category: string }
const cases = JSON.parse(readFileSync(new URL('../../evals/tb-mapping/cases.json', import.meta.url), 'utf8')) as { cases: Array<{ lines: Line[] }> };
const lines = cases.cases.flatMap((c) => c.lines);
const flagged = (l: Line) => nameFlags(l.name).includes('possible_instruction_text');

describe('injection flag on the eval cases', () => {
  it('flags every injection attempt', () => {
    const missed = lines.filter((l) => l.category === 'injection' && !flagged(l)).map((l) => `${l.id}: ${l.name}`);
    expect(missed).toEqual([]);
  });

  it('never flags a genuine account name', () => {
    const falseFlags = lines.filter((l) => l.category !== 'injection' && flagged(l)).map((l) => `${l.id}: ${l.name}`);
    expect(falseFlags).toEqual([]);
  });
});
