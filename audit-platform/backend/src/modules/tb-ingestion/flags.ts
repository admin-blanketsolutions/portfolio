/**
 * Plausibility flags shown to the reviewer next to each suggestion
 * (docs/01 section 3.2). They never change a mapping; they decide what a
 * reviewer must look at individually: flagged suggestions are excluded from
 * bulk acceptance.
 */
export type MappingFlag =
  | 'possible_instruction_text'  // imperative / prompt-like wording, URLs, markup: possible injection attempt
  | 'formula_like_text'          // starts with = + - @ (CSV/formula injection if exported)
  | 'sign_mismatch'              // balance sign opposite to the account's normal balance
  | 'concentration'              // unusually many lines mapped to one account
  | 'low_confidence';

const INSTRUCTION_EN = /\b(ignore|disregard|forget|override|instructions?|prompt|system|assistant|you are|you must|respond|reply|output|json|map (every|all|each|everything)|classify (every|all|each))\b/i;
const INSTRUCTION_AR = /(تجاهل|تعليمات|أنت الآن|انت الان|قم بتصنيف|صنف كل|اربط كل)/u;
const URL_LIKE = /(https?:\/\/|www\.|\.(com|net|io|ai)\b)/i;
const MARKUP = /[{}<>`]|\[\[|\]\]/;
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]\s*[\d.,]+$/;
const MAX_PLAUSIBLE_NAME = 150;

export function nameFlags(name: string): MappingFlag[] {
  const flags: MappingFlag[] = [];
  if (INSTRUCTION_EN.test(name) || INSTRUCTION_AR.test(name) || URL_LIKE.test(name) || MARKUP.test(name)
      || name.length > MAX_PLAUSIBLE_NAME) {
    flags.push('possible_instruction_text');
  }
  if (FORMULA_START.test(name) && !PLAIN_NUMBER.test(name)) flags.push('formula_like_text');
  return flags;
}

export interface FlagInput {
  name: string;
  /** Signed closing balance as a decimal string (debit +, credit -). */
  closing: string;
  normalBalance?: 'debit' | 'credit' | null;
  confidence?: number | null;
  concentrated?: boolean;
}

export function mappingFlags(input: FlagInput): MappingFlag[] {
  const flags = nameFlags(input.name);
  const sign = Math.sign(Number(input.closing));   // only the sign is used: no precision concern
  if (input.normalBalance && sign !== 0 && ((input.normalBalance === 'debit') !== (sign > 0))) flags.push('sign_mismatch');
  if (input.concentrated) flags.push('concentration');
  if (input.confidence !== undefined && input.confidence !== null && input.confidence < 0.6) flags.push('low_confidence');
  return flags;
}

/** An account receiving at least 5 lines AND more than a quarter of the TB is unusual. */
export function concentratedAccounts(countsByAccount: Map<string, number>, totalLines: number): Set<string> {
  const out = new Set<string>();
  for (const [account, n] of countsByAccount) {
    if (n >= 5 && n / Math.max(totalLines, 1) > 0.25) out.add(account);
  }
  return out;
}

/** Flags that stop a suggestion from being bulk-accepted. */
export function blocksBulkAccept(flags: readonly MappingFlag[]): boolean {
  return flags.length > 0;
}
