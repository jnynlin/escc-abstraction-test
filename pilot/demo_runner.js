(async () => { try {
  const sleep = ms => new Promise(r => setTimeout(r, ms)), $ = q => document.querySelector(q);
  const pf = $('#fp'), nf = $('#fn'), df = $('#fd'); const MSG = [];
  $('#stat').textContent = '示範：3 位虛擬病人'; $('#ctl').style.display = 'none'; $('#res').style.display = 'none'; window.scrollTo(0, 0);
  window.addEventListener('message', e => MSG.push({ s: e.source, m: e.data }));
  const loaded = f => new Promise(r => { f.onload = () => r(); });
  const pd = () => pf.contentDocument, nd = () => nf.contentDocument, dd = () => df.contentDocument;
  const inner = el => { const w = el.ownerDocument.defaultView, r = el.getBoundingClientRect(); const y = r.top + w.scrollY - w.innerHeight / 2; w.scrollTo(0, Math.max(0, y)); };   // 只捲動框內，不捲外層頁面
  const click = (el, who) => { if (!el) throw new Error('missing ' + who); inner(el); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); };
  const P = async (sel, ms = 420) => { click(pd().querySelector(sel), sel); await sleep(ms); };
  const N = async (sel, ms = 420) => { click(nd().querySelector(sel), sel); await sleep(ms); };
  const waitMsg = async (src, type, pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const k = MSG.findIndex(x => !x.used && x.s === src && x.m && x.m.type === type && (!pred || pred(x.m))); if (k >= 0) { MSG[k].used = true; return MSG[k].m; } await sleep(20); } return null; };
  const send = async (frame, msg, ackType, key, dropFirst) => { for (let t = 1; t <= 4; t++) { if (dropFirst && t === 1) { cap('⚠ 這一包在傳送途中遺失（模擬），沒收到回覆 → 自動重送'); await sleep(1500); continue; } frame.contentWindow.postMessage(msg, '*'); const a = await waitMsg(frame.contentWindow, ackType, m => m[key] === msg._key, 800); if (a) return a; } return null; };
  async function patient(pid, label, plan) {
    MSG.length = 0; hl('p'); cap(`① 病人端：${label}`);
    pf.src = 'patient_v9.html?pid=' + pid; await loaded(pf); await sleep(500);
    const b = pd().querySelector('#birth'); b.value = '0315'; b.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);
    if (plan.tx) { for (const t of plan.tx) { await P(`[data-tx="${t}"]`, 350); } }
    await P('#go', 700);
    for (const step of plan.steps) { for (const s of step) { if (s.startsWith('type:')) { const ta = pd().querySelector('#note'); inner(ta); ta.value = s.slice(5); ta.dispatchEvent(new Event('input', { bubbles: true })); await sleep(700); } else await P(s, 380); }
      await sleep(250); pd().defaultView.scrollTo(0, 0); await P('#next', 800); }
    const sub = await waitMsg(pf.contentWindow, 'submit', null, 3000); return sub && sub.payload;
  }
  async function nurse(pid, chart, payload, nurseActs, dropFirst) {
    hl('n'); cap(`② 資料包送到個管師端（病人 ${pid}）`); await sleep(800);
    await send(nf, { type: 'ingest', payload, chart, _key: pid }, 'ingested', 'pid', dropFirst); await sleep(600);
    const qi = [...nd().querySelectorAll('#queue .qi')].find(b => b.querySelector('.code').textContent === pid); click(qi); cap(`② 個管師端：處理 ${pid}`); await sleep(900);
    for (const a of nurseActs) { if (a.cap) cap('② ' + a.cap); if (a.type) { const inp = nd().querySelector(a.input); inner(inp); inp.value = a.type; await sleep(500); } if (a.click) await N(a.click, a.ms || 800); }
    const sign = nd().querySelector('#sign'); cap('② 個管師完成初審，送交醫師'); await N('#sign', 900);
    return await waitMsg(nf.contentWindow, 'l2done', m => m.record && m.record.code === pid, 2000);
  }
  async function doctor(l2, pid, note) {
    hl('d'); cap(`③ 紀錄送到醫師端（${pid}）`); await sleep(800);
    await send(df, { type: 'l2done', record: l2.record, _key: pid }, 'received', 'code', false); await sleep(700);
    const dq = [...dd().querySelectorAll('#queue .qi')].find(b => b.querySelector('.code').textContent === pid); click(dq); cap(`③ 醫師端：${note}`); await sleep(2200);
    click(dd().querySelector('#l3')); cap(`③ 醫師確認（第三層）完成`); await sleep(1100);
  }
  nf.src = 'nurse_v2.html?empty=1'; df.src = 'doctor_v1.html'; await Promise.all([loaded(nf), loaded(df)]); await sleep(600);
  // ---- 病人 1：70 多歲，化療＋放療；發燒沒量體溫、血便不確定 ----
  let pl = await patient('D001', '70 多歲，化療＋放療。發燒但沒量體溫、血便「不確定」', { steps: [
    ['[data-a="fever|y"]', '[data-qa="fever|none"]', '[data-a="swallow|n"]', '[data-a="breath|n"]', '[data-a="weight|n"]', '[data-a="blood|u"]', '[data-a="hemo|n"]', '[data-a="weak|n"]'],
    ['[data-a="fatigue|y"]', '[data-s="fatigue|2"]', '[data-a="pain|y"]', '[data-s="pain|2"]', '[data-l="pain|abd"]', '#allno', '#allno-yes'],
    ['#allno', '#allno-yes'], ['type:晚上常拉肚子，擔心脫水'], ['#redok']] });
  let l2 = await nurse('D001', { age: '70 多歲', base_kg: 66, usual: 2 }, pl, [
    { cap: '輸入當日體重、院內體溫', input: '#w', type: '64.5', click: '[data-save="weight"]' }, { input: '#t', type: '38.4', click: '[data-save="temp"]', ms: 900 },
    { cap: '血便「不確定」→ 電話確認：沒有', click: '[data-conf="blood|n"]', ms: 1200 },
    { cap: '發燒 38.4 度 → 今日處理：通知醫師', click: '[data-ack="fever_38|通知醫師"]', ms: 900 }]);
  await doctor(l2, 'D001', '發燒 38 度以上，請先處理');
  // ---- 病人 2：免疫治療；肌肉沒力＋胸悶 ----
  pl = await patient('D002', '60 多歲，免疫治療。肌肉沒力、胸悶、頭暈「不確定」', { tx: ['io', 'chemo', 'rt'], steps: [
    ['[data-a="fever|n"]', '[data-a="swallow|n"]', '[data-a="breath|n"]', '[data-a="weight|n"]', '[data-a="blood|n"]', '[data-a="hemo|n"]', '[data-a="weak|y"]'],
    ['[data-a="chest|y"]', '[data-a="palp|n"]', '[data-a="dizzy|u"]', '[data-a="eyepain|n"]'],
    ['[data-a="fatigue|y"]', '[data-s="fatigue|2"]', '#allno', '#allno-yes'], ['#allno', '#allno-yes'], [], ['#redok']] });
  l2 = await nurse('D002', { age: '60 多歲', base_kg: 58, usual: 1 }, pl, [
    { cap: '輸入當日體重、院內體溫', input: '#w', type: '57.2', click: '[data-save="weight"]' }, { input: '#t', type: '36.8', click: '[data-save="temp"]', ms: 900 },
    { cap: '頭暈「不確定」→ 電話確認：有', click: '[data-conf="dizzy|y"]', ms: 1200 },
    { cap: '胸悶 → 通知醫師', click: '[data-ack="chest|通知醫師"]' }, { cap: '肌肉無力＋心臟症狀（肌炎＋心肌炎）→ 通知醫師', click: '[data-ack="myositis|通知醫師"]', ms: 900 }], true);
  await doctor(l2, 'D002', '肌炎＋心肌炎紅旗，請先處理');
  // ---- 病人 3：低風險 ----
  pl = await patient('D003', '50 多歲，化療。只有輕微疲倦', { tx: ['rt'], steps: [
    ['[data-a="fever|n"]', '[data-a="swallow|n"]', '[data-a="breath|n"]', '[data-a="weight|n"]', '[data-a="blood|n"]', '[data-a="hemo|n"]', '[data-a="weak|n"]'],
    ['[data-a="fatigue|y"]', '[data-s="fatigue|1"]', '#allno', '#allno-yes'], ['#allno', '#allno-yes'], [], ['#redok']] });
  l2 = await nurse('D003', { age: '50 多歲', base_kg: 61, usual: 1 }, pl, [
    { cap: '輸入當日體重、院內體溫', input: '#w', type: '60.5', click: '[data-save="weight"]' }, { input: '#t', type: '36.6', click: '[data-save="temp"]', ms: 900 }]);
  await doctor(l2, 'D003', '沒有需要先處理的項目');
  hl(null); cap('完成：3 位病人，資料沒有遺失、重複或改錯；醫師端只把需要先處理的放在最前面'); await sleep(2500);
  return 'demo-done';
} catch (e) { return 'EXC ' + (e && e.stack || e); } })()
