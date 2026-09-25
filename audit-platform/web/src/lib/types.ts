/** Shapes returned by the API (backend/src/modules/tb-ingestion). Amounts are decimal strings. */
export type ImportStatus = 'received' | 'processing' | 'imported' | 'failed';
export type MappingSource = 'carried_forward' | 'rule' | 'exact' | 'fuzzy' | 'embedding' | 'llm' | 'manual';
export type Flag = 'possible_instruction_text' | 'formula_like_text' | 'sign_mismatch' | 'concentration' | 'low_confidence';
export type LineFilter = 'all' | 'open' | 'pending' | 'accepted' | 'unmapped';

export interface Me {
  tenant: string;
  userId: string;
  kind: 'staff' | 'client_contact' | 'service';
  isFirmAdmin: boolean;
  displayName: string | null;
  displayNameAr: string | null;
  rank: string | null;
}

export interface Engagement {
  id: string;
  code: string;
  stage: string;
  periodStart: string;
  periodEnd: string;
  reportingCurrency: string;
}

export interface ParseWarning { code: string; message: string; count: number; rows: number[] }

export interface TbImport {
  id: string;
  engagementId: string;
  status: ImportStatus;
  kind: string;
  asOfDate: string;
  currency: string;
  filename: string;
  format: 'csv' | 'xlsx';
  sizeBytes: number;
  sha256: string;
  trialBalanceId: string | null;
  failure: { code: string; message: string } | null;
  report: { control?: { line_count: number }; warnings?: ParseWarning[] } | null;
  mappingSummary: { suggested: Record<string, number>; unmatched: number; llm: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TrialBalance {
  id: string;
  engagementId: string;
  kind: string;
  version: number;
  asOfDate: string;
  currency: string;
  status: 'importing' | 'imported' | 'locked' | 'superseded';
  sourceFilename: string;
  control: { lineCount: number; sumDebit: string; sumCredit: string };
  lockedAt: string | null;
  mapping: { accepted: number; pendingSuggestion: number; unmapped: number };
}

export interface ReviewLine {
  id: string;
  lineNo: number;
  code: string;
  name: string;
  closing: string;
  hadFormula: boolean;
  flags: Flag[];
  accepted: { mappingId: string; coaCode: string; coaNameEn: string; coaNameAr: string; source: MappingSource } | null;
  suggestion: {
    mappingId: string; coaCode: string; coaNameEn: string; coaNameAr: string; source: MappingSource;
    confidence: number | null; modelRef: string | null; rationale: string | null; flags: Flag[];
  } | null;
}

export interface LinesPage { trialBalanceId: string; lines: ReviewLine[]; nextAfterLine: number | null }

export interface CoaAccount {
  id: string; code: string; path: string; nameEn: string; nameAr: string; accountClass: string;
  normalBalance: 'debit' | 'credit'; isPostable: boolean;
}
