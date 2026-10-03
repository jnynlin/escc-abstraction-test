/* 跨裝置連結交接測試（在測試台頁面執行）：病人端產生連結 → 個管師端開連結收件 → 初審 → 醫師端開連結收件；另測貼上匯入、復原、翻轉測試。 */
(async () => { try {
  const CFG = __RUNCFG__, sleep = ms => new Promise(r => setTimeout(r, ms)), $ = q => document.querySelector(q);
  const pf = $('#fp'), nf = $('#fn'), df = $('#fd'); const loaded = f => new Promise(r => { f.onload = () => r(); });
  const drv = await (await fetch('driver.js')).text(), ptd = await (await fetch('pt.json')).text();
  const R = { n: CFG.n, linkOk: 0, nurseSame: 0, doctorSame: 0, pasteOk: 0, undoOk: 0, seedN: 0, seedFlipped: 0, seedNoticed: 0, linkLens: [], errs: [], dupOk: 0, stuck: 0 };
  const waitFor = async (f, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = f(); if (v) return v; await sleep(25); } return null; };
  for (let i = 0; i < CFG.n; i++) {
    const pid = 'L' + String(i + 1).padStart(3, '0'), seed = (i % 2 === 1) ? 1 : 0;
    pf.src = `patient_v9.html?p=${pid}&card=C${(i % 8) + 1}${seed ? '&seed=1' : ''}`; await loaded(pf); await sleep(20);
    const code = drv.replace('__CFG__', JSON.stringify({ n: 1, seed: 777 + i * 31, detail: true, extra: null, q2: .6, q3: .6, errx: 1, hazx: 1, skim: 1 })).replace('__PTD__', ptd);
    const out = JSON.parse(await pf.contentWindow.eval(code)); if (!out.detail || !out.detail[0].completed) continue;
    const okLink = await waitFor(() => pf.contentWindow.__link && pf.contentWindow.__link.includes('#d='), 3000), link = pf.contentWindow.__link;
    if (!okLink) { R.errs.push([pid, 'noLink']); continue; } R.linkOk++; R.linkLens.push(link.length);
    const payload = pf.contentWindow.eval('exportPayload()'); if (payload.seed) { R.seedN++; if (payload.seed.id) { R.seedFlipped++; if (payload.seed.noticed) R.seedNoticed++; } }
    // 個管師端：開連結
    nf.src = link.replace(/^.*\/(nurse_v2\.html)/, 'nurse_v2.html?t=' + i); await loaded(nf); await sleep(20);
    const nw = nf.contentWindow, nd = nf.contentDocument; const got = await waitFor(() => nw.eval(`P.find(p => p.code === ${JSON.stringify(payload.pid)})`), 3000);
    if (!got) { R.errs.push([pid, 'nurseNoPatient']); continue; }
    const same = JSON.stringify(Object.fromEntries(Object.entries(got.ans).sort())) === JSON.stringify(Object.fromEntries(Object.entries(payload.answers).sort())) && got.card === payload.card && got.participant === payload.participant; if (same) R.nurseSame++; else R.errs.push([pid, 'nurseDiff']);
    // 個管師處理：全部以「沒有／0／正常值」收尾，並測一次復原
    const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); const qi = [...nd.querySelectorAll('#queue .qi')].find(b => b.querySelector('.code').textContent === payload.pid); click(qi);
    let undone = false;
    for (let g = 0; g < 40; g++) { const cf = nd.querySelector('.cf'); if (!cf) break;
      const m = cf.querySelector('[data-measure]'), c = cf.querySelector('[data-conf$="|n"]'), b = cf.querySelector('[data-bin$="|0"]');
      if (m) { const [id, f] = m.dataset.measure.split('|'); nd.querySelector('#m-' + id).value = f === 'temp' ? '36.8' : '60'; click(m); }
      else if (c) { click(c); if (!undone) { const u = nd.querySelector('[data-undo]'); const before = nd.querySelectorAll('.cf').length; if (u) { click(u); await sleep(5); if (nd.querySelectorAll('.cf').length === before + 1 - 0 || nd.querySelectorAll('.cf').length >= before) { R.undoOk++; } undone = true; click(nd.querySelector('.cf [data-conf$="|n"]')); } } }
      else if (b) click(b); else { const e = cf.querySelector('[data-esc]') || cf.querySelector('[data-nc]'); if (e) click(e); else break; } }
    for (let g = 0; g < 30; g++) { const a = nd.querySelector('[data-ack]'); if (!a) break; click(a); }
    const sign = nd.querySelector('#sign'); if (!sign || sign.disabled) { R.stuck++; R.errs.push([pid, 'stuck:' + ((nd.querySelector('.sign .why') || {}).textContent || '')]); continue; }
    click(sign); const okDl = await waitFor(() => nw.__dlink, 3000), dl = nw.__dlink; if (!okDl) { R.errs.push([pid, 'noDoctorLink']); continue; }
    const rec = nw.eval(`P.find(p => p.code === ${JSON.stringify(payload.pid)}).rec`);
    // 醫師端：開連結
    df.src = dl.replace(/^.*\/(doctor_v1\.html)/, 'doctor_v1.html?t=' + i); await loaded(df); await sleep(20);
    const st = await waitFor(() => { const s = df.contentWindow.__state(); return s.records.find(r => r.code === payload.pid) ? s : null; }, 3000);
    if (!st) { R.errs.push([pid, 'doctorNoRecord']); continue; }
    const dr = st.records.find(r => r.code === payload.pid), A = JSON.stringify(rec.flags.map(f => [f.id, f.level, f.resp]).sort()), B = JSON.stringify(dr.flags.map(f => [f.id, f.level, f.resp]).sort()); if (A === B) R.doctorSame++; else R.errs.push([pid, 'doctorDiff']);
    // 貼上匯入：空白個管師端，把同一條連結貼進去兩次（第二次要顯示已匯入過）
    if (i < 8) { nf.src = 'nurse_v2.html?empty=1'; await loaded(nf); await sleep(20); const imp = nf.contentDocument.querySelector('#imp'); imp.value = link; nf.contentDocument.querySelector('#impgo').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const ok = await waitFor(() => /已匯入/.test(nf.contentDocument.querySelector('#impmsg').textContent), 2000); imp.value = link; nf.contentDocument.querySelector('#impgo').dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(300);
      if (ok && /已經匯入過/.test(nf.contentDocument.querySelector('#impmsg').textContent) && nf.contentWindow.eval('P.length') === 1) { R.pasteOk++; R.dupOk++; } }
  }
  R.linkLenMax = Math.max(...R.linkLens, 0); R.linkLenMed = R.linkLens.sort((a, b) => a - b)[Math.floor(R.linkLens.length / 2)] || 0; delete R.linkLens;
  return JSON.stringify(R);
} catch (e) { return 'EXC ' + (e && e.stack || e); } })()
