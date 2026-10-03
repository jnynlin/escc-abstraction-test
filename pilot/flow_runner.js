/* 三視窗流程自動測試（2026-10-03）：在測試台頁面（cockpit.html）裡跑。
   每位虛擬病人：① 病人端填寫（用壓力測試的虛擬病人行為，有真實症狀清單）→ 送出資料包 → ② 測試台轉送（可丟包、重複）→ 個管師端收件、處理、初審 → ③ 醫師端收件、確認。
   三個對照標準：資料包 = 病人畫面答案；個管師端與醫師端的紅旗 = 另一套獨立寫的規則；醫師端紅旗 = 真實症狀應有的紅旗（漏掉的歸因到哪一層）。 */
(async () => {
try {
  const CFG = __RUNCFG__;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = q => document.querySelector(q);
  const pf = $('#fp'), nf = $('#fn'), df = $('#fd');
  const MSG = []; const who = s => s === pf.contentWindow ? 'p' : s === nf.contentWindow ? 'n' : s === df.contentWindow ? 'd' : '?';
  window.addEventListener('message', e => { MSG.push({ f: who(e.source), m: e.data, t: Math.round(performance.now()) }); });
  const waitMsg = async (f, type, pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const k = MSG.findIndex(x => !x.used && x.f === f && x.m && x.m.type === type && (!pred || pred(x.m))); if (k >= 0) { MSG[k].used = true; return MSG[k].m; } await sleep(8); } return null; };
  const loaded = f => new Promise(r => { f.onload = () => r(); });
  const log = t => { const el = $('#log'); el.textContent = t + '\n' + el.textContent.slice(0, 1200); };
  const stat = t => { $('#stat').innerHTML = t; };
  let seed = CFG.seed >>> 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const drv = await (await fetch('driver.js')).text(), ptd = await (await fetch('pt.json')).text();
  // 載入個管師端、醫師端各一次
  const PP = CFG.pp || 'patient_v9.html', PN = CFG.pn || 'nurse_v2.html', PD = CFG.pd || 'doctor_v1.html';
  nf.src = PN + '?empty=1'; df.src = PD; await Promise.all([loaded(nf), loaded(df)]); await sleep(300);
  const nw = () => nf.contentWindow, nd = () => nf.contentDocument, dw = () => df.contentWindow, dd = () => df.contentDocument;
  // ===== 獨立的規則（依題庫 hard_red_flags 另寫一次，用來對照兩個畫面的計算）=====
  const BIN_T = { lt375: 37.2, '375_379': 37.7, '38_389': 38.4, ge39: 39.4 };
  function oracle(ans, staff, conf, note) {
    const F = {}, eff = id => (conf[id] === 'y' || conf[id] === 'n') ? conf[id] : (ans[id] || {}).a, A = id => ans[id] || {}, sev = id => A(id).sev || 0;
    if (staff.temp != null) { if (staff.temp >= 39) F.fever_high = 'today'; else if (staff.temp >= 38) F.fever_38 = 'today'; }
    else if (eff('fever') === 'y') { const q = A('fever').q; if (q === 'ge39') F.fever_high = 'today'; else if (q === '38_389') F.fever_38 = 'today'; }
    [['blood', 'blood_stool'], ['hemo', 'hemoptysis'], ['eyepain', 'eye_pain']].forEach(([id, f]) => { if (eff(id) === 'y') F[f] = 'today'; });
    const heart = eff('chest') === 'y' || eff('palp') === 'y'; if (heart) F.chest = 'today';
    if (eff('weak') === 'y' && heart) F.myositis = 'today'; else if (eff('weak') === 'y') F.weak = 'act';
    if (eff('dizzy') === 'y') F.adrenal = 'act';
    if (eff('diarrhea') === 'y' && A('diarrhea').q === 'ge7') F.diarrhea_7 = 'today';
    if (staff.weight != null && staff.base_kg && (staff.base_kg - staff.weight) / staff.base_kg * 100 >= 20) F.weight_20 = 'today';
    if (eff('swallow') === 'y') F[sev('swallow') >= 3 ? 'cant_swallow' : 'swallow'] = sev('swallow') >= 3 ? 'today' : 'act';
    if (eff('breath') === 'y' && sev('breath') >= 3) F.dyspnea = 'today';
    if (eff('skin_rt') === 'y' && sev('skin_rt') >= 3) F.skin_rt_severe = 'today';
    Object.keys(conf).forEach(id => { if (conf[id] === 'escalate') F['unconf_' + id] = 'today'; });
    if (note) F.note = 'read';
    return F;
  }
  const same = (a, b) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]); };
  const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]);
  const ROOT = { blood_stool: ['blood'], hemoptysis: ['hemo'], eye_pain: ['eyepain'], chest: ['chest', 'palp'], myositis: ['weak', 'chest', 'palp'], fever_38: ['fever'], fever_high: ['fever'], diarrhea_7: ['diarrhea'], weight_20: ['weight'], cant_swallow: ['swallow'], dyspnea: ['breath'], skin_rt_severe: ['skin_rt'] };
  const TODAY = Object.keys(ROOT);
  // ===== 轉送（可丟包、重複；有重送就是至少一次送達，靠 pid／code 去重）=====
  const net = { sent: 0, dropped: 0, dups: 0, retries: 0, lost: 0 };
  async function relay(frame, fkey, msg, ackType, ackKey) {
    for (let tries = 1; tries <= 6; tries++) {
      const drop = rnd() < CFG.drop, dupl = rnd() < CFG.dup; (net.tl = net.tl || []).push([msg._key, tries, Math.round(performance.now())]);
      if (drop) net.dropped++; else { frame.contentWindow.postMessage(msg, '*'); net.sent++; if (dupl) { frame.contentWindow.postMessage(msg, '*'); net.sent++; net.dups++; } }
      const ack = await waitMsg(fkey, ackType, m => m[ackKey] === msg._key, 120);
      if (ack) return ack;
      if (!CFG.retry) { net.lost++; return null; }
      net.retries++;
    }
    net.lost++; return null;
  }
  const rows = []; const t00 = Date.now();
  for (let i = 0; i < CFG.n; i++) {
    const pid = 'F' + String(i + 1).padStart(4, '0'), row = { i, pid };
    // ① 病人端
    MSG.forEach(m => { if (m.f === 'p') m.used = true; });   // 前一位病人留下的訊息作廢
    pf.src = PP + '?pid=' + pid; await loaded(pf); await sleep(20);
    const code = drv.replace('__CFG__', JSON.stringify({ n: 1, seed: CFG.seed + i * 7919, detail: true, extra: null, q2: .6, q3: .6, errx: 1, hazx: 1, skim: 1 })).replace('__PTD__', ptd);
    const out = JSON.parse(await pf.contentWindow.eval(code));
    if (typeof out === 'string' || !out.detail) { row.err = 'driver:' + String(out).slice(0, 80); rows.push(row); continue; }
    const d = out.detail[0]; row.pk = d.pk; row.txs = d.txs; row.completed = d.completed; row.gt = d.gt; row.gtQ = d.gtQ;
    const sub = await waitMsg('p', 'submit', m => m.payload && m.payload.pid === pid, 300);   // 有送出訊息才算填完（以頁面實際送出為準）
    if (!sub) { row.abandoned = true; row.completed = false; row.abStep = d.abStep; rows.push(row); continue; }
    row.completed = true;
    const payload = sub.payload, S = pf.contentWindow.eval('JSON.stringify({a:S.a,sev:S.sev,q:S.q,loc:Object.fromEntries(Object.entries(S.loc).map(([k,v])=>[k,[...v]])),note:S.note,tx:[...S.tx]})');
    const st = JSON.parse(S);
    // 對照①：資料包 = 病人畫面
    let h1 = []; const ids = new Set([...Object.keys(st.a), ...Object.keys(payload.answers)]);
    ids.forEach(id => { const pa = payload.answers[id], sa = st.a[id]; if (!sa || !pa) { if (sa || pa) h1.push('missing:' + id); return; }
      if (pa.a !== sa) h1.push('a:' + id); if ((pa.sev || 0) !== (st.sev[id] || 0)) h1.push('sev:' + id); if ((pa.q || '') !== (st.q[id] || '')) h1.push('q:' + id);
      const sl = st.loc[id] && st.loc[id].length ? (st.loc[id].length >= 8 ? ['whole'] : st.loc[id]) : []; if (JSON.stringify((pa.loc || []).slice().sort()) !== JSON.stringify(sl.slice().sort())) h1.push('loc:' + id); });
    if (payload.pid !== pid) h1.push('pid'); if (payload.note !== st.note) h1.push('note');
    row.hop1 = h1;
    // 真實測量值（醫院量得到的）
    const base = 50 + Math.floor(rnd() * 36), usual = 1 + Math.floor(rnd() * 3);
    let trueTemp = 36.3 + rnd() * .8; if (d.gt.fever) { const bin = d.gtQ.fever; trueTemp = BIN_T[bin] != null ? BIN_T[bin] + (rnd() - .5) * .4 : pick(Object.values(BIN_T)) + (rnd() - .5) * .4; }
    let loss = rnd() * 1.5; if (d.gt.weight) { const b = d.gtQ.weight; const R = { none: [0, 15], '1_2': [1, 2], '3_4': [3, 4], '5_7': [5, 7], '8_12': [8, 12], ge13: [13, 18] }[b] || [0, 15]; loss = R[0] + rnd() * (R[1] - R[0]); }
    const trueW = Math.round((base - loss) * 10) / 10; trueTemp = Math.round(trueTemp * 10) / 10;
    row.trueTemp = trueTemp; row.trueW = trueW; row.base = base;
    // ② 個管師端
    const ack1 = await relay(nf, 'n', { type: 'ingest', payload, chart: { age: '', base_kg: base, usual }, _key: pid }, 'ingested', 'pid');
    if (!ack1) { row.lostNurse = true; rows.push(row); continue; }
    if (ack1.err) { row.err = 'nurseIngest:' + ack1.err; rows.push(row); continue; }
    await sleep(10);
    let clicks = 0, typed = 0; const click = el => { clicks++; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); };
    const qi = [...nd().querySelectorAll('#queue .qi')].find(b => b.querySelector('.code').textContent === pid); if (!qi) { row.err = 'noQueue'; rows.push(row); continue; } click(qi);
    if (CFG.routine) { const w = nd().querySelector('#w'); w.value = String(trueW); click(nd().querySelector('[data-save="weight"]')); typed++; const t = nd().querySelector('#t'); t.value = String(trueTemp); click(nd().querySelector('[data-save="temp"]')); typed++; }
    const gt = d.gt, gtQ = d.gtQ, yes = id => !!gt[id]; let nc = 0, esc = 0, phone = 0;
    for (let g = 0; g < 40; g++) {
      const cf = nd().querySelector('.cf'); if (!cf) break;
      const mB = cf.querySelector('[data-measure]'), cB = cf.querySelector('[data-conf]'), bB = cf.querySelector('[data-bin]'), eB = cf.querySelector('[data-esc]'), nB = cf.querySelector('[data-nc]');
      const id = (mB ? mB.dataset.measure : cB ? cB.dataset.conf : bB ? bB.dataset.bin : nB.dataset.nc).split('|')[0];
      if (eB && rnd() < .5) { click(eB); esc++; continue; }                   // 第二次也聯絡不到 → 交給醫師
      if (!eB && rnd() < CFG.ncP) { click(nB); nc++; continue; }              // 這次聯絡不到
      if (mB) { const f = mB.dataset.measure.split('|')[1], inp = nd().querySelector('#m-' + id); inp.value = String(f === 'temp' ? trueTemp : trueW); typed++; click(mB); }
      else if (bB) { const bins = ['0', '1_3', '4_6', 'ge7']; let b = yes('diarrhea') ? (gtQ.diarrhea || '1_3') : '0'; if (rnd() > CFG.phoneAcc) b = bins[Math.max(0, Math.min(3, bins.indexOf(b) + (rnd() < .5 ? -1 : 1)))]; phone++; click(nd().querySelector(`[data-bin="${id}|${b}"]`)); }
      else if (cB) { let ans = yes(id) ? 'y' : 'n'; if (rnd() > CFG.phoneAcc) ans = ans === 'y' ? 'n' : 'y'; phone++; click(nd().querySelector(`[data-conf="${id}|${ans}"]`)); }
    }
    const NOTIFY = new Set(['fever_38', 'fever_high', 'weight_20', 'blood_stool', 'hemoptysis', 'chest', 'myositis', 'eye_pain', 'cant_swallow']);
    for (let g = 0; g < 30; g++) { const a = nd().querySelector('[data-ack]'); if (!a) break; const fid = a.dataset.ack.split('|')[0]; const want = (NOTIFY.has(fid) || /^unconf_/.test(fid)) ? '通知醫師' : '看診時處理'; click(nd().querySelector(`[data-ack="${fid}|${want}"]`)); }
    const sign = nd().querySelector('#sign'); row.nurseClicks = clicks + 1; row.typed = typed; row.phone = phone; row.nc = nc; row.esc = esc;
    if (!sign || sign.disabled) { row.stuck = true; row.stuckWhy = (nd().querySelector('.sign .why') || {}).textContent; rows.push(row); continue; }
    click(sign); const l2 = await waitMsg('n', 'l2done', m => m.record && m.record.code === pid, 1500); if (!l2) { row.err = 'noL2'; rows.push(row); continue; }
    const rec = l2.record; row.nurseClicks = clicks;
    // 對照②：個管師端的紅旗 = 獨立規則
    const cmap = {}; rec.conf.forEach(c => { if (c.res === 'y' || c.res === 'n' || c.res === 'escalate') cmap[c.id] = c.res; });
    const ex = oracle(rec.ans, rec.staff, cmap, rec.note), got = {}; rec.flags.forEach(f => { got[f.id] = f.level; });
    row.hop2 = diffKeys(ex, got);
    // ③ 醫師端
    const ack2 = await relay(df, 'd', { type: 'l2done', record: rec, _key: pid }, 'received', 'code'); // _key 要放在訊息上，ack 用 code 對
    if (!ack2) { row.lostDoctor = true; rows.push(row); continue; }
    await sleep(10);
    const dq = [...dd().querySelectorAll('#queue .qi')].find(b => b.querySelector('.code').textContent === pid); if (!dq) { row.err = 'noDocQueue'; rows.push(row); continue; }
    dq.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(5);
    const dstate = JSON.parse(dw().eval('JSON.stringify(__state())')).records.find(r => r.code === pid);
    const dgot = {}; dstate.flags.forEach(f => { dgot[f.id] = f.level; });
    row.hop3 = diffKeys(got, dgot);   // 個管師送出的 vs 醫師端收到的
    const urgentExp = rec.flags.filter(f => f.level === 'today' && (f.resp === '通知醫師' || /^unconf_/.test(f.id))).map(f => f.id).sort(), routineExp = rec.flags.filter(f => f.level === 'today' && f.resp === '看診時處理').map(f => f.id).sort();
    row.hop3p = (JSON.stringify(urgentExp) === JSON.stringify(dstate.urgent.slice().sort()) && JSON.stringify(routineExp) === JSON.stringify(dstate.routine.slice().sort())) ? [] : ['partition'];
    dd().querySelector('#l3').dispatchEvent(new MouseEvent('click', { bubbles: true })); const l3 = await waitMsg('d', 'l3done', m => m.code === pid, 1000); row.l3 = !!l3;
    // 端到端：真實症狀應有的紅旗 vs 醫師端看到的
    const tAns = {}; Object.keys(d.gt).forEach(id => { tAns[id] = { a: 'y', sev: d.gt[id], q: d.gtQ[id] }; });
    const tF = oracle(tAns, { temp: trueTemp, weight: trueW, base_kg: base }, {}, ''); const truth = {}; TODAY.forEach(f => { if (tF[f] === 'today') truth[f] = 1; });
    const seen = {}; dstate.flags.forEach(f => { if (f.level === 'today') seen[f.id] = 1; });
    const uncSeen = id => (ROOT[id] || []).some(r => seen['unconf_' + r]);
    row.e2e = {};
    const pa = payload.answers, A = id => pa[id] || {};
    const sig = f => { const fe = A('fever'), di = A('diarrhea'), we = A('weight');   // 病人有沒有給出可追蹤的訊號（答有或不確定，且量題沒有明確說在門檻以下）
      if (f === 'fever_38') return fe.a === 'u' || (fe.a === 'y' && (!fe.q || ['none', '38_389', 'ge39'].includes(fe.q)));
      if (f === 'fever_high') return fe.a === 'u' || (fe.a === 'y' && (!fe.q || ['none', 'ge39'].includes(fe.q)));
      if (f === 'diarrhea_7') return di.a === 'u' || (di.a === 'y' && (!di.q || ['ge7', 'unk'].includes(di.q)));
      if (f === 'weight_20') return we.a === 'u' || (we.a === 'y' && (!we.q || ['none', 'ge13'].includes(we.q)));
      if (['cant_swallow', 'dyspnea', 'skin_rt_severe'].includes(f)) { const r = ROOT[f][0]; return A(r).a === 'u' || (A(r).a === 'y' && (A(r).sev || 0) >= 3); }
      if (f === 'myositis') return (A('weak').a === 'y' || A('weak').a === 'u') && ['chest', 'palp'].some(r => A(r).a === 'y' || A(r).a === 'u');
      return ROOT[f].some(r => A(r).a === 'y' || A(r).a === 'u'); };
    TODAY.forEach(f => { const t = !!truth[f], s = !!seen[f], u = uncSeen(f);
      if (t && s) row.e2e[f] = 'TP'; else if (t && u) row.e2e[f] = 'UNC';   // 沒能確認，但有交給醫師
      else if (t) row.e2e[f] = sig(f) ? 'FN_nurse' : 'FN_patient';          // 病人沒給訊號＝病人端漏；給了訊號卻沒到醫師＝個管師端漏
      else if (s) row.e2e[f] = 'FP'; });
    row.done = true; rows.push(row);
    if (i % 10 === 9) stat(`已跑 <b>${i + 1}</b> / ${CFG.n}　送達 ${rows.filter(r => r.done).length}`);
  }
  // ===== 彙整 =====
  const done = rows.filter(r => r.done), comp = rows.filter(r => r.completed), ab = rows.filter(r => r.abandoned);
  const cnt = (f) => rows.filter(f).length, sumE = {}; TODAY.concat([]).forEach(f => { sumE[f] = { TP: 0, UNC: 0, FN_patient: 0, FN_nurse: 0, FP: 0 }; });
  done.forEach(r => Object.entries(r.e2e).forEach(([f, k]) => { sumE[f][k]++; }));
  const tot = { TP: 0, UNC: 0, FN_patient: 0, FN_nurse: 0, FP: 0 }; Object.values(sumE).forEach(o => Object.keys(tot).forEach(k => { tot[k] += o[k]; }));
  const pctl = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const nstate = JSON.parse(nw().eval('JSON.stringify(__state())')), dstate = JSON.parse(dw().eval('JSON.stringify(__state())'));
  const out = {
    cfg: CFG, n: CFG.n, ms: Date.now() - t00, completed: comp.length, abandoned: ab.length, delivered: done.length,
    errors: rows.filter(r => r.err).map(r => [r.pid, r.err]).slice(0, 8), stuck: rows.filter(r => r.stuck).map(r => [r.pid, r.stuckWhy]).slice(0, 5), stuckN: cnt(r => r.stuck), lostNurse: cnt(r => r.lostNurse), lostDoctor: cnt(r => r.lostDoctor),
    hop1Bad: done.filter(r => r.hop1.length).length, hop1Ex: done.filter(r => r.hop1.length).slice(0, 3).map(r => [r.pid, r.hop1.slice(0, 4)]),
    hop2Bad: done.filter(r => r.hop2.length).length, hop2Ex: done.filter(r => r.hop2.length).slice(0, 3).map(r => [r.pid, r.hop2]),
    hop3Bad: done.filter(r => r.hop3.length || r.hop3p.length).length, hop3Ex: done.filter(r => r.hop3.length || r.hop3p.length).slice(0, 3).map(r => [r.pid, r.hop3, r.hop3p]),
    l3: done.filter(r => r.l3).length, net, nurseQueue: nstate.patients.length, doctorRecords: dstate.records.length, doctorDupes: dstate.dupes,
    dupNurse: nstate.patients.length - new Set(nstate.patients.map(p => p.code)).size, signedNurse: nstate.patients.filter(p => p.l2).length,
    e2e: sumE, e2eTot: tot,
    nurse: { clicksMed: pctl(done.map(r => r.nurseClicks), .5), clicksP90: pctl(done.map(r => r.nurseClicks), .9), typedMed: pctl(done.map(r => r.typed), .5), phoneMed: pctl(done.map(r => r.phone), .5), withPhone: done.filter(r => r.phone > 0).length, ncPatients: done.filter(r => r.nc > 0).length, escPatients: done.filter(r => r.esc > 0).length },
    byPersona: Object.fromEntries(['young', 'adult', 'elder', 'lowv'].map(k => [k, { n: rows.filter(r => r.pk === k).length, completed: rows.filter(r => r.pk === k && r.completed).length, delivered: done.filter(r => r.pk === k).length }]))
  };
  delete net.tl;
  out.rowsLost = rows.filter(q => q.lostNurse).map(q => q.pid).slice(0, 5);
  stat(`完成 <b>${CFG.n}</b> 位　送達醫師端 <b>${done.length}</b>`);
  return JSON.stringify(out);
} catch (e) { return 'EXC ' + (e && e.stack || e); }
})()
