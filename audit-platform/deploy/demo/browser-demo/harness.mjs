/** Shared by check.mjs and record-walkthrough.mjs. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** audit-demo.html is published in the Artifact page format (no doctype);
 * wrap it the way the host does so it renders in standards mode locally. */
export function pageFile(dir) {
  const body = readFileSync(path.join(dir, 'audit-demo.html'), 'utf8');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'audit-demo-')), 'index.html');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`);
  return 'file://' + file;
}

/**
 * A stand-in for the claude.ai runtime's `sample` capability, injected with
 * page.addInitScript. Answers are canned and deterministic; nothing leaves the
 * machine. `opts.answers` may override the chat reply and analytical review.
 */
export function stubClaude(opts) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const prompts = (window.__prompts = []);
  const chat = opts.chat || 'Three balances exceed **performance materiality**:\n- Trade receivables\n- Inventories\n- Revenue';
  const fn = async (input, o = {}) => {
    prompts.push(input);
    await wait(opts.delayMs);
    for (let i = 1; i <= 4; i++) { const text = chat.slice(0, Math.ceil((chat.length * i) / 4)); o.onText && o.onText({ text, delta: '' }); await wait(opts.delayMs / 2); }
    return { text: chat, truncated: false, modelTierApplied: 'quick' };
  };
  fn.json = async (input) => {
    prompts.push(input);
    await wait(opts.delayMs);
    if (input.includes('<tb_lines>')) {
      const lines = JSON.parse(input.split('<tb_lines>\n')[1].split('\n</tb_lines>')[0]);
      return lines.map((l) => {
        if (/IGNORE|classify them/.test(l.name)) {
          const sales = /Sales/.test(l.name);
          return { ref: l.ref, code: sales ? '4000' : '5200', confidence: 0.7,
            reason: `The name contains an embedded instruction, which was ignored; the account itself is ${sales ? 'sales revenue' : 'rent expense'}.` };
        }
        const s = suggest(l.name, Math.round(l.balance * 100)).sug;   // the page's own matcher stands in for the model
        const a = s && COA.get(s.code);
        return { ref: l.ref, code: s ? s.code : null, confidence: 0.9,
          reason: a ? (opts.reason ? opts.reason(l, a) : `“${l.name}” is ${a.en.toLowerCase()} (${a.nb === 'd' ? 'debit' : 'credit'} balance).`) : 'Unclear without more detail from the client.' };
      });
    }
    const recId = () => Object.keys(REC).find((id) => input.includes(engById(id).en));
    if (opts.useRecorded && input.includes('analytical-review') && recId()) {
      const R = REC[recId()];
      return { summary: R.summary[0], findings: R.findings.map((f) => ({ title: f.t[0], severity: f.sev, area: f.area, observation: f.o[0], implication: f.i[0], procedures: f.p[0],
        adjustment: f.adj ? { description: f.adj.d[0], debit: f.adj.dr, credit: f.adj.cr, amount: f.adj.amt / 100 } : null })) };
    }
    if (opts.useRecorded && input.includes('risk-assessment') && recId()) {
      return { risks: REC[recId()].risks.map((r) => ({ title: r.t[0], level: r.lvl, area: r.area, assertions: r.as[0], response: r.resp[0], why: r.why[0] })) };
    }
    if (input.includes('analytical-review')) return opts.review || { summary: 'Stub summary.', findings: [
      { title: 'Tax looks low', severity: 'high', area: 'IS.TAX', observation: 'ETR 14%.', implication: 'Understated.', procedures: ['Obtain the computation'], adjustment: { description: 'Top up tax', debit: '5600', credit: '2050', amount: 14090 } },
      { title: 'Odd fields', severity: 'weird', area: 'NOPE', observation: 'x', implication: 'y', procedures: 'not an array', adjustment: { debit: '9999', credit: '2050', amount: 5 } }] };
    if (input.includes('risk-assessment')) return opts.risks || { risks: [{ title: 'Stub risk', level: 'sig', area: 'IS.REV', assertions: 'Occurrence', response: 'Test', why: 'Because' }] };
    return {};
  };
  window.claude = { use: async (name) => (name === 'sample' ? fn : null) };
}
