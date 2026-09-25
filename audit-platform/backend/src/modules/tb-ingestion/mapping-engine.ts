import { normalizeCode, normalizeForMatching } from './normalize.js';

/**
 * Deterministic stages of the mapping cascade (docs/01 section 3.2):
 *
 *   0  carried_forward  same code, accepted on a previous version of this TB
 *                       or in the client's prior-year engagement
 *   1  rule             firm rules (code prefix / code range / name contains)
 *   2  exact            normalised name equals a chart-of-accounts name, or a
 *                       name this client's lines were accepted under before
 *
 * Only history of the SAME CLIENT is consulted: another client's account
 * names never influence (or leak into) this engagement.
 * Stages 3-4 (embedding, LLM) handle what remains; see llm-classifier.ts.
 * Every output is a suggestion. Acceptance is a human act (V0005).
 */

export interface CoaOption {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  accountClass: string;
  normalBalance: 'debit' | 'credit';
}

export interface EngineLine {
  id: string;
  lineNo: number;
  code: string;
  name: string;
  nameNorm: string;
  closing: string;
}

export interface MappingRule {
  kind: 'code_prefix' | 'code_range' | 'name_contains';
  pattern: string;
  patternTo: string | null;
  coaAccountId: string;
  priority: number;
}

export interface HistoryHit {
  code: string;
  nameNorm: string;
  coaAccountId: string;
  /** true: an earlier version of this engagement's TB; false: a prior-year engagement. */
  sameEngagement: boolean;
}

export type MappingSource = 'carried_forward' | 'rule' | 'exact' | 'llm';

export interface Suggestion {
  lineId: string;
  coaAccountId: string;
  source: MappingSource;
  confidence: number;
  modelRef: string | null;
  rationale: string;
}

const DIGITS = /^\d+$/;

export function codeInRange(code: string, from: string, to: string): boolean {
  if (DIGITS.test(code) && DIGITS.test(from) && DIGITS.test(to)) {
    const c = BigInt(code);
    return c >= BigInt(from) && c <= BigInt(to);
  }
  return code >= from && code <= to;
}

export function ruleMatches(rule: MappingRule, line: EngineLine): boolean {
  const code = normalizeCode(line.code);
  switch (rule.kind) {
    case 'code_prefix':
      return code.startsWith(normalizeCode(rule.pattern));
    case 'code_range':
      return rule.patternTo !== null && codeInRange(code, normalizeCode(rule.pattern), normalizeCode(rule.patternTo));
    case 'name_contains': {
      const needle = normalizeForMatching(rule.pattern);
      return needle.length > 0 && line.nameNorm.includes(needle);
    }
  }
}

function describeRule(rule: MappingRule): string {
  switch (rule.kind) {
    case 'code_prefix': return `Firm rule (priority ${rule.priority}): account code starts with ${rule.pattern}.`;
    case 'code_range': return `Firm rule (priority ${rule.priority}): account code in ${rule.pattern}-${rule.patternTo}.`;
    case 'name_contains': return `Firm rule (priority ${rule.priority}): account name contains "${rule.pattern}".`;
  }
}

export interface DeterministicResult {
  suggestions: Suggestion[];
  residual: EngineLine[];
}

export function deterministicSuggestions(
  lines: readonly EngineLine[],
  coa: readonly CoaOption[],
  rules: readonly MappingRule[],
  history: readonly HistoryHit[],
): DeterministicResult {
  const postable = new Map(coa.map((c) => [c.id, c]));

  // History is ordered by the caller: same engagement (newest version) first, then prior years (newest first).
  const byCode = new Map<string, HistoryHit>();
  const byName = new Map<string, HistoryHit>();
  for (const h of history) {
    if (!postable.has(h.coaAccountId)) continue;   // account since retired or turned into a header
    const code = normalizeCode(h.code);
    if (!byCode.has(code)) byCode.set(code, h);
    if (h.nameNorm && !byName.has(h.nameNorm)) byName.set(h.nameNorm, h);
  }

  // COA names -> account; names claimed by two accounts are ambiguous and skipped.
  const coaByName = new Map<string, CoaOption | null>();
  for (const c of coa) {
    for (const n of [normalizeForMatching(c.nameEn), normalizeForMatching(c.nameAr)]) {
      if (!n) continue;
      const prior = coaByName.get(n);
      coaByName.set(n, prior === undefined || prior?.id === c.id ? c : null);
    }
  }

  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);
  const suggestions: Suggestion[] = [];
  const residual: EngineLine[] = [];

  for (const line of lines) {
    const target = (s: Omit<Suggestion, 'lineId' | 'modelRef'>): void => {
      suggestions.push({ lineId: line.id, modelRef: null, ...s });
    };
    const cf = byCode.get(normalizeCode(line.code));
    if (cf) {
      target({
        coaAccountId: cf.coaAccountId, source: 'carried_forward', confidence: cf.sameEngagement ? 0.95 : 0.9,
        rationale: cf.sameEngagement
          ? `Same account code was accepted as ${postable.get(cf.coaAccountId)!.code} on the previous version of this trial balance.`
          : `Same account code was accepted as ${postable.get(cf.coaAccountId)!.code} in the prior-year engagement.`,
      });
      continue;
    }
    const rule = sortedRules.find((r) => postable.has(r.coaAccountId) && ruleMatches(r, line));
    if (rule) {
      target({ coaAccountId: rule.coaAccountId, source: 'rule', confidence: 0.85, rationale: describeRule(rule) });
      continue;
    }
    if (line.nameNorm) {
      const seen = byName.get(line.nameNorm);
      if (seen) {
        target({
          coaAccountId: seen.coaAccountId, source: 'exact', confidence: 0.9,
          rationale: `The same account name was accepted as ${postable.get(seen.coaAccountId)!.code} for this client before.`,
        });
        continue;
      }
      const byCoa = coaByName.get(line.nameNorm);
      if (byCoa) {
        target({
          coaAccountId: byCoa.id, source: 'exact', confidence: 0.8,
          rationale: `The account name matches chart-of-accounts account ${byCoa.code}.`,
        });
        continue;
      }
    }
    residual.push(line);
  }
  return { suggestions, residual };
}
