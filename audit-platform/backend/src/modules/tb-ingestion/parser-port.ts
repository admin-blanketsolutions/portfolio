import { z } from 'zod';

/**
 * Contract with the sandboxed parser (parser/tb_parser). The sandbox handles
 * hostile input, so its OUTPUT is treated as untrusted too: every field is
 * validated here, and the database independently re-checks the control totals
 * against the rows it receives before the import can close.
 */
const Money = z.string().regex(/^-?\d{1,20}\.\d{4}$/);
const NonNegMoney = z.string().regex(/^\d{1,20}\.\d{4}$/);

export const ParsedLineSchema = z.object({
  line_no: z.number().int().positive(),
  source_row: z.number().int().positive(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(512),
  name_norm: z.string().max(2048),
  opening: Money.nullable(),
  period_debit: NonNegMoney.nullable(),
  period_credit: NonNegMoney.nullable(),
  closing: Money,
  had_formula: z.boolean(),
});

export const ParseWarningSchema = z.object({
  code: z.string().regex(/^[a-z_]{1,64}$/),
  message: z.string().max(500),
  count: z.number().int().nonnegative(),
  rows: z.array(z.number().int().positive()).max(50),
});

export const ParseResultSchema = z.object({
  parser_version: z.string().regex(/^tb-parser@[0-9A-Za-z.+-]{1,32}$/),
  format: z.enum(['csv', 'xlsx']),
  sheet: z.string().max(255).nullable(),
  header_row: z.number().int().positive(),
  layout: z.enum(['closing_signed', 'closing_dr_cr', 'dr_cr_as_closing', 'opening_plus_movements']),
  columns: z.record(z.string().regex(/^[a-z_]{1,32}$/), z.string().regex(/^[A-Z]{1,3}$/)),
  lines: z.array(ParsedLineSchema).min(1).max(200_000),
  control: z.object({ line_count: z.number().int().positive(), sum_debit: NonNegMoney, sum_credit: NonNegMoney, net: Money }),
  warnings: z.array(ParseWarningSchema).max(100),
}).superRefine((r, ctx) => {
  if (r.control.line_count !== r.lines.length) ctx.addIssue({ code: 'custom', message: 'line_count mismatch' });
  r.lines.forEach((l, i) => {
    if (l.line_no !== i + 1) ctx.addIssue({ code: 'custom', message: 'line numbers must be 1..n' });
  });
});

export type ParseResult = z.infer<typeof ParseResultSchema>;
export type ParsedLine = z.infer<typeof ParsedLineSchema>;

export const ParseRejectionSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[a-z_]{1,64}$/),
    message: z.string().max(500),
    row: z.number().int().positive().optional(),
  }),
  parser_version: z.string().max(64).optional(),
});

/** The file was rejected for a reason the uploader can fix. */
export class TbParseRejected extends Error {
  constructor(readonly code: string, message: string, readonly row?: number) {
    super(message);
    this.name = 'TbParseRejected';
  }
}

export interface TbParseRequest {
  bytes: Uint8Array;
  format: 'csv' | 'xlsx';
}

export interface TbParserPort {
  /** Resolves with a validated result, or rejects with TbParseRejected (user-fixable) or any other Error (ours). */
  parse(req: TbParseRequest): Promise<ParseResult>;
}
