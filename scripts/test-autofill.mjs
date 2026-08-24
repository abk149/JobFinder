import { createRequire } from 'module';
globalThis.require = createRequire(import.meta.url);

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

(async () => {
  const { getContext } = await import('../lib/browser.js');
  const { autofillContext } = await import('../lib/autofill.js');
  const { recordAnswer, reviewAllPending } = await import('../lib/answerBank.js');
  const { retrieve, backfillEmbeddings } = await import('../lib/knowledge.js');
  const { run } = await import('../lib/db.js');

  const profileId = crypto.randomUUID();
  const profile = {
    id: profileId, name: 'Alex Tester', email: 'alex@test.dev',
    keywords: 'backend, distributed systems, golang', locations: 'Remote',
    filters: JSON.stringify({
      bio: '7 years building distributed payment systems at scale. Led a 5-engineer team rewriting the core ledger in Go.',
      llm_model: 'qwen2.5:7b-instruct',
    }),
  };
  const job = {
    id: 'test', profile_id: profileId, connector: 'test',
    title: 'Senior Backend Engineer', company: 'AcmeCorp', location: 'Remote',
    description: 'Build distributed systems handling 100k req/s. Go experience required.',
  };

  await run('INSERT INTO profiles (id, name, email, resume_path, keywords, locations, filters, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [profile.id, profile.name, profile.email, '', profile.keywords, profile.locations, profile.filters, Date.now()]);
  await recordAnswer(profileId, { field_key: 'years of experience', label: 'Years of experience', value: '7', type: 'text' });
  await recordAnswer(profileId, { field_key: 'notice period in days', label: 'Notice period in days', value: '30', type: 'text' });
  await recordAnswer(profileId, { field_key: 'expected salary', label: 'Expected salary (USD)', value: '180000', type: 'text' });
  // Newly captured answers land as 'pending', and retrieval reads approved rows only —
  // that gate is the whole point of the review queue. A test that skips it is testing
  // nothing, because every seeded answer would be invisible to retrieve().
  await reviewAllPending(profileId, 'approved');
  await new Promise(r => setTimeout(r, 3000));
  await backfillEmbeddings(profile);

  console.log('\n=== TEST 1: Semantic retrieval ===');
  const rephrased = 'How many years have you been writing software?';
  const { hits, exact } = await retrieve(profile, rephrased);
  console.log(`Q: "${rephrased}"`);
  console.log(`  exact-key hit: ${exact ? exact.value : '(none)'}`);
  for (const h of hits.slice(0, 3)) console.log(`  semantic ${h.score?.toFixed(3)}  ${h.label} → ${h.value}`);
  const sevenFound = hits.some((h) => h.value === '7');
  console.log(`  → "7" retrievable via paraphrase? ${sevenFound ? 'YES' : 'NO'}`);

  console.log('\n=== TEST 2: Autofill on real form ===');
  const html = `<!doctype html><html><body><form>
    <label for="yrs">Years of Experience</label><input id="yrs" name="experience" />
    <label for="notice">Notice Period (days)</label><input id="notice" name="notice" />
    <label for="comp">Compensation Expectation</label><input id="comp" name="comp" />
    <label for="why">Why are you interested in this role?</label><textarea id="why" rows="6" maxlength="1000"></textarea>
  </form></body></html>`;
  const tmpHtml = '/tmp/jobfinder-test-form.html';
  fs.writeFileSync(tmpHtml, html);

  const ctx = await getContext(profileId, 'test-conn', { headless: true, stealth: true });
  const page = await ctx.newPage();
  await page.goto('file://' + tmpHtml, { waitUntil: 'domcontentloaded' });
  const hasFill = await page.evaluate(() => typeof window.__jobfinderFill === 'function');
  console.log(`  __jobfinderFill injected? ${hasFill ? 'YES' : 'NO'}`);

  console.log('  running autofillContext (this calls LLM)...');
  const t0 = Date.now();
  const summary = await autofillContext(ctx, profile, job, { useLLM: true, overwrite: false });
  console.log(`  completed in ${Math.round((Date.now() - t0) / 1000)}s — summary:`, JSON.stringify(summary));

  const values = await page.evaluate(() => ({
    yrs: document.getElementById('yrs').value,
    notice: document.getElementById('notice').value,
    comp: document.getElementById('comp').value,
    why: document.getElementById('why').value,
  }));
  console.log('\nFilled values:');
  console.log(`  Years of Experience      → "${values.yrs}"`);
  console.log(`  Notice Period            → "${values.notice}"`);
  console.log(`  Compensation Expectation → "${values.comp}"`);
  console.log(`  Why interested (LLM)     → "${(values.why || '').slice(0, 220)}${values.why?.length > 220 ? '…' : ''}"`);

  await ctx.close();
  // Chrome keeps flushing profile files for a moment after the context closes, and a
  // file appearing mid-walk makes rmSync throw ENOTEMPTY even with recursive:true.
  // That threw AFTER every assertion had already passed, which made a green run look
  // like a failure. Retry briefly, and never let cleanup fail the test.
  const sessionPath = path.join(process.cwd(), 'data', 'sessions', profileId);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  await run('DELETE FROM answers WHERE profile_id = ?', [profileId]);
  await run('DELETE FROM profiles WHERE id = ?', [profileId]);

  // The salary field is filled by the LLM, not the bank: "Compensation Expectation" vs
  // "Expected salary (USD)" scores 0.414, under the verbatim bar, and the bar cannot be
  // lowered to catch it without readmitting false matches (which reach 0.458 on a real
  // bank). So compare the NUMBER, not its formatting — "$180,000" is the right answer
  // presented differently. Digits still have to match exactly, so a wrong figure fails.
  const digits = (v) => String(v || '').replace(/[^0-9]/g, '');
  const pass = sevenFound
    && values.yrs === '7'
    && values.notice === '30'
    && digits(values.comp) === '180000'
    && (values.why || '').length > 50;
  console.log('\n' + (pass ? '✅ PIPELINE WORKS END-TO-END' : '❌ Pipeline broken'));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
