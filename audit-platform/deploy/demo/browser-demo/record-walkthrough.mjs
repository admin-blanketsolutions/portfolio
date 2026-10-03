#!/usr/bin/env node
/**
 * Records a captioned walkthrough of DEMO-SCRIPT.md as a video, for rehearsal
 * or as an offline backup (run `python3 build.py` first):
 *
 *   node record-walkthrough.mjs [out.webm]      # CHROMIUM_PATH overrides the browser
 *
 * No real AI call is made: the AI answers are the prepared examples in the
 * page (and short canned replies for mapping and chat), and the video says so
 * on screen. In the live demo inside claude.ai, Claude writes them on the spot.
 */
import { renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile, stubClaude } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'demo-walkthrough.webm');
const { chromium } = await import(path.join(here, '../../../web/node_modules/playwright/index.mjs'));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const size = { width: 1280, height: 800 };
const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: path.dirname(out), size }, locale: 'en-US' });
const p = await ctx.newPage();
await p.route(/fonts\.g|cdnjs/, (r) => r.abort());
const CHAT_AR = `**ملخص للشريك — شركة النخيل التجارية (السنة المالية 2025)**
- ميزان المراجعة مقفل ومتوازن: 50 بنداً، جميعها مربوطة بدليل الحسابات.
- الإيرادات 2.74 مليون دينار، والربح قبل الضريبة 202,340 دينار (هامش 7.4%).
- قيد التسوية AJE-1 (استكمال مخصص ضريبة الدخل بمبلغ 14,090 دينار) مرحّل، وربح السنة بعد التسوية 159,850 دينار.
- المجالات الرئيسية: قابلية تحصيل الذمم والشيكات المؤجلة (68 يوماً من المبيعات)، وملكية البضاعة في الطريق (41,200 دينار).
- المطلوب: مراجعة أوراق العمل الجاهزة واعتماد مسودة القوائم المالية.`;
await p.addInitScript(stubClaude, { delayMs: 3500, useRecorded: true, chat: CHAT_AR });
await p.goto(pageFile(here));
await p.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await p.reload();

await p.evaluate(() => {
  const st = document.createElement('style');
  st.textContent = `#rec-cur{position:fixed;z-index:99;width:22px;height:22px;border-radius:50%;background:rgba(255,196,0,.55);border:2px solid #f59e0b;left:640px;top:400px;transform:translate(-50%,-50%);transition:left .7s ease,top .7s ease;pointer-events:none}
  #rec-cur.tap{animation:tap .45s ease}@keyframes tap{50%{transform:translate(-50%,-50%) scale(1.8)}}
  #rec-cap{position:fixed;z-index:98;left:16px;bottom:16px;max-width:760px;background:rgba(10,14,22,.88);color:#fff;border-radius:12px;padding:12px 16px;font:15px/1.45 Inter,system-ui,sans-serif;pointer-events:none;direction:ltr;text-align:left}
  #rec-cap b{display:block;color:#fcd34d;font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px}
  #rec-badge{position:fixed;z-index:98;left:50%;top:2px;transform:translateX(-50%);background:rgba(107,47,214,.92);color:#fff;border-radius:8px;padding:5px 10px;font:12px Inter,system-ui,sans-serif;pointer-events:none}`;
  document.head.appendChild(st);
  for (const id of ['rec-cur', 'rec-cap', 'rec-badge']) { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
  document.getElementById('rec-badge').textContent = 'Rehearsal recording · AI answers are prepared examples — live in claude.ai';
});
const wait = (ms) => p.waitForTimeout(ms);
const show = (step, text) => p.evaluate(([s, t]) => { const c = document.getElementById('rec-cap'); c.innerHTML = ''; const b = document.createElement('b'); b.textContent = s; c.append(b, t); }, [step, text]);
const hold = (text) => wait(Math.max(3200, text.split(/\s+/).length * 340));
async function say(step, text) { await show(step, text); await hold(text); }
async function click(sel, { pause = 700 } = {}) {
  const el = p.locator(sel).first();
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await wait(250);
  const b = await el.boundingBox();
  await p.evaluate(([x, y]) => { const c = document.getElementById('rec-cur'); c.style.left = x + 'px'; c.style.top = y + 'px'; }, [b.x + b.width / 2, b.y + b.height / 2]);
  await wait(800);
  await p.evaluate(() => { const c = document.getElementById('rec-cur'); c.classList.remove('tap'); void c.offsetWidth; c.classList.add('tap'); });
  await el.click();
  await wait(pause);
}
const scrollTo = (sel) => p.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'smooth' })).then(() => wait(900));

// 1
await say('1 · Sign-in', 'Each firm has its own private, isolated workspace and signs in with its own company login and two-factor authentication. Sign in as Sara Nasser, audit senior.');
await click('[data-u="senior"]');
// 2
await say('2 · Dashboard — lead with the AI', 'Point at the purple banner: an AI copilot built into every step — mapping, risks, analytical review, adjustments, questions. It never acts alone: reasoning shown, a person approves, everything logged.');
await say('2 · Dashboard', 'Below it: engagements, what is locked, what is waiting for approval. Now show the Arabic interface.');
await click('[data-a="lang"]', { pause: 2200 });
await click('[data-a="lang"]');
// 3
await say('3 · AI trial balance mapping', 'Open Al-Nakheel Trading → Trial balance → load the client’s Excel file exactly as they sent it.');
await click('[data-e="NKH"]'); await click('[data-t="tb"]'); await click('[data-a="sample"][data-s="nakheel"]', { pause: 1200 });
await say('3 · AI trial balance mapping', 'It found the columns and checked that debits equal credits. Firm rules and exact matches apply instantly. Everything else goes to the AI.');
await click('[data-a="aimap"]', { pause: 400 });
await say('3 · While the AI works', 'Talk through the wait: “It is reading every account — the client’s wording, the balance sign, both languages. How long does a junior spend mapping a new client today?”');
await p.waitForSelector('[data-a="aimap"]', { timeout: 60000 });
await scrollTo('table.tbl');
await say('3 · Reasons you can check', 'Every suggestion has a purple ✦ reason and a confidence score. Read one aloud. Doubtful items are flagged and cannot be bulk-accepted.');
await click('[data-a="bulk"]', { pause: 1200 });
await click('[data-a="lock"]', { pause: 1500 });
await say('3 · Lock', 'Accept the clean suggestions in one click, then lock. Only seniors and above can lock.');
// 4
await show('4 · Statements', 'Open Financial statements.');
await click('[data-t="fs"]', { pause: 1200 });
await say('4 · Statements', 'Statement of financial position and profit or loss, drafted instantly from the locked trial balance — and balanced. Every number drills down.');
await scrollTo('table.fs'); await click('tr.cap[data-k="BS.A.NCA.PPE"]', { pause: 2000 }); await click('tr.cap[data-k="BS.A.NCA.PPE"]');
await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await wait(800);
await click('[data-a="airev"]', { pause: 400 });
await say('4 · AI analytical review', 'While it works: “Now it does what a manager does on day one — reads the statements, ratios and materiality, and tells the team where to look.”');
await p.waitForSelector('.finding', { timeout: 60000 });
await scrollTo('.finding');
await say('4 · The findings', 'Top finding: income tax looks understated by about JOD 14,100 — above materiality. It quotes the figures, explains why it matters, lists procedures, and drafts the entry.');
await click('[data-a="aiaje"]', { pause: 1200 });
await say('4 · Proposal only', '“Propose this adjustment” posts nothing. It goes to a manager for approval.');
// 5
await show('5 · Human approval', 'Switch user → Omar Khalil (manager) → Al-Nakheel → Adjustments.');
await click('[data-a="signout"]'); await click('[data-u="manager"]'); await click('[data-e="NKH"]'); await click('[data-t="adj"]', { pause: 1200 });
await say('5 · Human approval', 'Switch to Omar Khalil, the manager. The entry is marked AI-suggested and waiting for approval. Post it.');
await click('[data-a="post"]', { pause: 800 });
await click('[data-t="fs"]', { pause: 800 });
await scrollTo('table.fs');
await say('5 · Statements update', 'The statements update at once: before adjustments, adjustments and final, side by side.');
// 6
await show('6 · Planning', 'Open Planning.');
await click('[data-t="planning"]', { pause: 1000 });
await say('6 · Planning', 'Materiality calculator from the client’s real numbers (ISA 320), then the risk register. Ask the AI for risks we have not listed.');
await click('[data-a="airisk"]', { pause: 400 });
await p.waitForSelector('[data-a="addrisk"]', { timeout: 60000 });
await scrollTo('[data-a="addrisk"]');
await click('[data-a="addrisk"]', { pause: 1200 });
await say('6 · People decide', 'Nothing enters the file until a person adds it — and the file records that it was AI-suggested and who accepted it.');
// 7
await show('7 · Ask the file', 'Click ✦ Ask AI in the bottom corner.');
await click('[data-a="chat"]', { pause: 800 });
await say('7 · Ask the file', 'Anyone can ask the file a question in plain language. Try: “Summarise this engagement for the partner in Arabic.”');
await click('[data-a="askq"][data-q="q2"]');
await p.waitForFunction(() => document.querySelector('.bubble.a') && !document.querySelector('.bubble.a .spin'), null, { timeout: 60000 });
await say('7 · Answer', 'It answers from this engagement’s own data — in Arabic or English. Then let the client ask his own question.');
await click('[data-a="chat"]');
// 8
await show('8 · Can the AI be tricked?', 'All engagements → Zahran Real Estate → Trial balance.');
await click('[data-a="go"][data-p="dash"]'); await click('[data-e="ZHR"]'); await click('[data-t="tb"]');
await say('8 · Can the AI be tricked?', 'Zahran → Trial balance → Other samples → Security test. These account names try to give the AI orders.');
await click('[data-a="sample"][data-s="security"]', { pause: 800 });
await click('[data-a="aimap"]', { pause: 400 });
await p.waitForSelector('[data-a="aimap"]', { timeout: 60000 });
await scrollTo('table.tbl');
await say('8 · Flagged and ignored', 'The two suspicious lines are flagged, the AI ignores the instructions and says so, and they cannot be accepted until a person reviews and confirms.');
// 9
await show('9 · Arabic end to end', 'All engagements → العربية → Petra Food Industries → Financial statements.');
await click('[data-a="go"][data-p="dash"]'); await click('[data-a="lang"]'); await click('[data-e="PETRA"]'); await click('[data-t="fs"]', { pause: 1200 });
await scrollTo('table.fs');
await say('9 · Arabic end to end', 'Petra: an Arabic trial balance, mapped and drafted into statements, fully in Arabic.');
await click('[data-a="lang"]');
// 10
await show('10 · Audit trail', 'Open Audit trail at the top.');
await click('[data-a="go"][data-p="trail"]', { pause: 1000 });
await say('10 · Audit trail', 'Every action is here — each AI suggestion, each question asked, who approved what. And it is tamper-evident.');
await click('[data-a="verify"]', { pause: 1500 });
await click('[data-a="tamper"]', { pause: 600 });
await click('[data-a="verify"]', { pause: 1500 });
await say('10 · Close', '“The full audit file you expect, plus an AI copilot that does the first pass at every stage, in Arabic and English, with your team in control.” Then propose a pilot on one of his real (anonymised) trial balances.');
await wait(1500);

const video = p.video();
await ctx.close();
renameSync(await video.path(), out);
await browser.close();
console.log(out);
