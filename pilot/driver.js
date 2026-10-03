const CFG=__CFG__;
const PTD=__PTD__;
/* 虛擬病人壓力測試：共用核心（2026-10-03）。由 run.sh 在前面接上 `const CFG=…; const PTD=…;` 之後與各頁的腳本串起來，在無頭 Edge 裡對「真的頁面」操作。
   不是在算公式：每一次點擊都是對真實 DOM 發出 click，點擊時間用該元素在畫面上的真實大小與兩次點擊間的真實距離（Fitts 定律），
   換頁防連點用的時間是虛擬時鐘（performance.now 被換掉），所以『人的速度』和『程式的速度』分開。
   人的行為參數（誤點率、漏點、趕著按、放棄率）都是假設，要用試填紀錄校正。 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const Q = q => document.querySelector(q), QA = q => [...document.querySelectorAll(q)];
function rng(seed){ let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const PERS = {  // w＝人口比例；cps 讀字速；dq 每題判斷秒；a,b Fitts；key 按鍵秒；ime 輸入法每字秒；err 每次點擊誤點率；fix 發現誤點後補救秒；haz 每分鐘放棄機率
                // find＝在卡片裡找到對應選項的機率；tapq＝會主動去點自己症狀的比例；sc＝全沒症狀的那頁會用「這一頁都沒有」的機率；hurry＝其實有症狀卻趕著按「都沒有」的機率；
                // unsure＝改按「不確定」的傾向；burst＝連點下一步的機率
  young: { w: .15, cps: 9.0, dq: .9, a: .10, b: .15, key: .35, ime: .6, err: .01, fix: 1.5, haz: .005, find: .95, tapq: .90, sc: .40, hurry: .06, unsure: .03, burst: .15 },
  adult: { w: .30, cps: 6.0, dq: 1.6, a: .15, b: .22, key: .6, ime: 1.0, err: .03, fix: 2.0, haz: .015, find: .90, tapq: .80, sc: .50, hurry: .04, unsure: .05, burst: .10 },
  elder: { w: .40, cps: 3.5, dq: 3.2, a: .30, b: .40, key: 1.2, ime: 2.2, err: .08, fix: 3.0, haz: .04, find: .80, tapq: .70, sc: .60, hurry: .02, unsure: .08, burst: .12 },
  lowv:  { w: .15, cps: 2.5, dq: 3.6, a: .35, b: .45, key: 1.4, ime: 2.5, err: .10, fix: 3.5, haz: .06, find: .70, tapq: .60, sc: .60, hurry: .01, unsure: .12, burst: .12 } };
const PKEYS = Object.keys(PERS);
const X = { err: CFG.errx || 1, haz: CFG.hazx || 1, skim: CFG.skim || 1 };   // 敏感度分析用的倍數
const pickPersona = r => { let x = r(), s = 0; for (const k of PKEYS) { s += PERS[k].w; if (x < s) return k; } return PKEYS[PKEYS.length - 1]; };
const lognorm = (r, s = .3) => { const u = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); return Math.exp(s * u - s * s / 2); };
const fitts = (p, D, W) => p.a + p.b * Math.log2(1 + D / Math.max(W, 1));
const shuffle = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nSym = r => { const x = r(); return x < .25 ? 0 : x < .65 ? 1 + Math.floor(r() * 3) : x < .90 ? 4 + Math.floor(r() * 5) : 9 + Math.floor(r() * 6); };   // 0 / 1–3 / 4–8 / 9–14 個症狀
const pct = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const wilson = (k, n) => { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]; };
// 虛擬時鐘：頁面程式裡的 performance.now() 讀這個
let VT = 1e7; performance.now = () => VT;
const advance = (T, s) => { T.sec += s; VT += s * 1000; };
// 點擊：用真實位置算 Fitts 時間，必要時加一次捲動；固定在畫面上的元素（下方按鈕、上方進度）不用捲
function mkTapper(p, vh) {
  const st = { x: 195, y: vh * .6, scroll: 0, taps: 0, scrolls: 0, widths: [], misses: 0 };
  st.tap = (T, el, opt = {}) => {
    const rc = el.getBoundingClientRect(), fixed = !!el.closest('#dock,.top');
    let cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2 + (fixed ? 0 : 0);
    let vy = cy;
    if (!fixed) { const docY = cy + 0; if (docY < st.scroll + 80 || docY > st.scroll + vh - 110) { st.scroll = docY - vh * .45; st.scrolls++; advance(T, p.cps > 5 ? 1.2 : 2.0); } vy = docY - st.scroll; }
    const D = Math.hypot(cx - st.x, vy - st.y), W = Math.min(rc.width, rc.height);
    advance(T, fitts(p, D, W) * lognorm(RR, .25)); st.x = cx; st.y = vy; st.taps++; st.widths.push(W);
    if (W < 44) { const nm = nameOf(el), e = SMALLALL[nm] || (SMALLALL[nm] = [999, 0, 0, 0]); e[0] = Math.min(e[0], Math.round(W)); e[1]++; e[2] = Math.round(rc.width); e[3] = Math.round(rc.height); if (W < 5 && !e[4]) e[4] = el.outerHTML.slice(0, 120) + ' | parent=' + (el.parentElement && el.parentElement.id) + ' | disp=' + getComputedStyle(el).display + ' | scrollY=' + scrollY + ' | rc=' + [rc.left, rc.top, rc.width, rc.height].map(Math.round); }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  return st;
}
let RR = Math.random;
const SMALLALL = {};   // 點到過、短邊小於 44px 的元素：名稱 → [最小短邊px, 被點次數, 寬, 高]
const nameOf = el => el.dataset.seg || el.dataset.r || el.dataset.pk || el.dataset.sys || el.dataset.a || el.dataset.s || el.id || el.tagName;   // 目前這位病人的亂數（供 tap 內使用）
function summarize(list, f) { const v = list.map(f).filter(x => x != null && !Number.isNaN(x)); return v; }
function pick1(r, a) { return a[Math.floor(r() * a.length)]; }
/* 病人端 v4 流程：1000 位虛擬病人逐屏作答。每位病人有真實症狀與嚴重度（地面真值），行為含：誤點相鄰按鈕、改按「不確定」、趕著按「這一頁都沒有」、
   連點下一步、中途按上一步、沒答完就按下一步、中途放棄。看頁面最後記錄下來的答案和真值差多少（資料保真），以及走了多久、點了幾下、有沒有跳屏。 */
(async () => {
try {
  Element.prototype.scrollIntoView = () => {}; window.scrollTo = () => {};
  for (let i = 0; i < 150 && !Q('#birth'); i++) await sleep(100);
  const errs = []; addEventListener('error', e => errs.push(String(e.message) + '@' + e.lineno));
  const N = CFG.n, SEED = CFG.seed, VH = innerHeight;
  const Q2 = (CFG.q2 == null ? .6 : CFG.q2), Q3 = (CFG.q3 == null ? .6 : CFG.q3);   // 看到確認畫面時『發現自己按錯』的機率（假設，要用真人校正）
  const HAS_LOC = typeof LOCABLE !== 'undefined';   // v5（位置版）才有；v4 沒有
  const SKIPLOC = { young: .10, adult: .15, elder: .25, lowv: .35 };   // 位置是選填：不填的機率（假設）
  const BODY = ['head', 'chest', 'abd', 'back', 'armR', 'armL', 'legR', 'legL'], ALLLOC = [...BODY, 'whole', 'unknown'];
  const viol = {}, bad = (k, x) => { viol[k] = (viol[k] || 0) + 1; if (!viol[k + '_ex']) viol[k + '_ex'] = x; };
  const HAS_Q = typeof qTxt === 'function';   // v9（量的題改分段按鈕）才有
  const QSKIP = { young: .05, adult: .08, elder: .15, lowv: .20 }, QADJ = { young: .08, adult: .12, elder: .18, lowv: .22 };   // 選填的量題不答的機率、估成相鄰一格的機率（假設）
  const QDIST = { fever: [['none', .15], ['lt375', .15], ['375_379', .25], ['38_389', .30], ['ge39', .15]], weight: [['none', .20], ['1_2', .20], ['3_4', .20], ['5_7', .20], ['8_12', .15], ['ge13', .05]],
    nausea: [['0', .20], ['1_2', .40], ['3_5', .30], ['ge6', .10]], diarrhea: [['0', .10], ['1_3', .40], ['4_6', .30], ['ge7', .20]] };
  const QTHR = { fever: [['38_389', 'ge39'], ['ge39']], diarrhea: [['ge7']], weight: [['ge13']] };   // 臨床門檻：發燒≥38、≥39；腹瀉多7次以上；體重掉兩成(約13公斤)
  const HAS_TX = typeof applyTx === 'function';   // v8（有治療別）才有
  const TXPOOL = [[['chemo', 'rt'], .40], [['chemo'], .15], [['rt'], .10], [['chemo', 'io'], .15], [['io'], .05], [['adc', 'chemo'], .10], [['adc'], .05]];
  const ADDON = { endo: 'io', cardiac: 'io', eye_io: 'io', eye_adc: 'adc', neuro: 'chemo', mouth: 'chemo', constipation: 'chemo', skin_rt: 'rt', voice: 'rt' };   // 現行題庫各頁的加掛治療別
  let IDS = ALL.map(x => x.id), REDIDS = RED.map(x => x.id);
  const clickEl = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const rows = [];
  for (let n = 0; n < N; n++) {
    const r = rng(SEED + n * 104729); RR = r;
    const pk = pickPersona(r), p = PERS[pk], PT = PTD.PT[pk], CN = PTD.CONST[pk];
    let txs = ['chemo', 'rt'];
    if (HAS_TX) { let xx = r(); txs = TXPOOL[TXPOOL.length - 1][0]; for (const [t, w] of TXPOOL) { if (xx < w) { txs = t; break; } xx -= w; } S.tx = new Set(txs); applyTx(); IDS = ALL.map(x => x.id); REDIDS = RED.map(x => x.id); }
    Object.assign(S, { q: {}, i: -1, a: {}, sev: {}, loc: {}, redOk: false, confirmAllNo: false, note: '', t0: VT, lastNav: -1e9, taps: 0, tapsByStep: {}, stepMs: {}, enter: VT, needHits: 0, done: false });
    VT += 5000; render();
    const gtIds = shuffle(IDS, r).slice(0, nSym(r)), gt = {}; gtIds.forEach(id => gt[id] = r() < .5 ? 1 : r() < .7 ? 2 : 3);
    const T = { sec: 0 }, tp = mkTapper(p, VH), A = -Math.log(1 - r()) / (p.haz * X.haz / 60);
    const intent = {}; let caught = 0, redFixed = 0, abandoned = false, abStep = null, maxJump = 0, lastI = -1, shortcutMask = 0, shortcutUsed = 0, backs = 0, bursts = 0, fixes = 0, wrongKept = 0;
    const chk = () => { if (!abandoned && T.sec > A) { abandoned = true; abStep = S.done ? 'done' : (S.i < 0 ? 'intro' : STEPS[S.i].k); } return abandoned; };
    const r2 = rng(SEED + n * 31 + 7), extra = ((CFG.extra && CFG.extra[pk]) || 0) * lognorm(r2, .3);   // 『先身體圖再清單』的疊加估計用，不影響本流程的亂數
    let revAt = null, doneAt = null, tRedAt = null;
    const gtQ = {}, drawQ = id => { let x = r(); for (const [k, w] of QDIST[id]) { if (x < w) return k; x -= w; } return QDIST[id][0][0]; };
    if (HAS_Q) for (const id of gtIds) if (ITEM[id] && ITEM[id].q) gtQ[id] = drawQ(id);   // 流程測試：每個真症狀都先定好量題真值
    const gtLoc = {}, genLoc = () => { const x = r(); if (x < .10) return ['whole']; if (x < .18) return ['unknown']; if (x < .40) { const a = pick1(r, BODY); let b = pick1(r, BODY); while (b === a) b = pick1(r, BODY); return [a, b]; } return [pick1(r, BODY)]; };
    const track = () => { const j = Math.abs(S.i - lastI); if (j > maxJump) maxJump = j; lastI = S.i; if (S.i === STEPS.length - 1 && revAt === null) revAt = VT; if (S.done && doneAt === null) doneAt = VT; if (tRedAt === null && REDIDS.every(id => S.a[id])) tRedAt = T.sec; };
    const quick = (sel) => { VT += 40 + r() * 80; const el = Q(sel); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); track(); };
    const tap = (sel) => { const el = Q(sel); if (!el) { bad('missingEl', sel); return false; } tp.tap(T, el); track(); return true; };
    // 一次按一個鍵，有誤點率：wrongSel 是旁邊的按鈕
    const press = (sel, wrongSels) => {
      if (wrongSels && wrongSels.length && r() < Math.min(.5, p.err * X.err)) {
        const w = wrongSels[Math.floor(r() * wrongSels.length)]; tap(w);
        if (r() < .5) { advance(T, p.fix); fixes++; tap(sel); return 'fixed'; } wrongKept++; return 'wrong';
      }
      tap(sel); return 'ok';
    };
    const answer = (id, intent0) => {
      const intent_ = intent0; intent[id] = intent_;
      const others = ['y', 'n', 'u'].filter(v => v !== intent_).map(v => `[data-a="${id}|${v}"]`);
      press(`[data-a="${id}|${intent_}"]`, others);
      if (S.a[id] === 'y') {                                                  // 展開嚴重度（血便、咳血、肌肉沒力這類安全列沒有）
        if (!ITEM[id].nosev) { advance(T, X.skim * 14 / p.cps + .7 * p.dq); let s = gt[id] || 1; if (r() < .3) s = Math.max(1, Math.min(3, s + (r() < .5 ? -1 : 1)));
        press(`[data-s="${id}|${s}"]`, [1, 2, 3].filter(v => v !== s).map(v => `[data-s="${id}|${v}"]`)); } else advance(T, .3);
        if (HAS_Q && ITEM[id].q && S.a[id] === 'y') qStep(id);
        if (HAS_LOC && LOCABLE.has(id) && S.a[id] === 'y') locStep(id);
      }
    };
    const qStep = id => {                                                     // 量的題：分段按鈕（選填）
      const opts = ITEM[id].q.opts.map(o => o[0]), truth = gtQ[id] || (gtQ[id] = drawQ(id)); let k = truth;   // 真值先定（沒填的也有真值，才算得到漏掉）
      const req = !!ITEM[id].q.req, ESC = { fever: 'none', diarrhea: 'unk' }[id];
      if (!req && r() < QSKIP[pk]) return;                                     // 必填的量題不能跳過
      if (req && ESC && r() < p.unsure) k = ESC;                               // 必填但沒量或說不準 → 選逃生選項（護理會再確認）
      else if (r() < QADJ[pk]) { const j = opts.indexOf(truth) + (r() < .5 ? -1 : 1); if (j >= 0 && j < opts.length) k = opts[j]; }   // 估成相鄰一格
      advance(T, X.skim * ITEM[id].q.title.length / p.cps + .7 * p.dq);
      press(`[data-qa="${id}|${k}"]`, opts.filter(o => o !== k).map(o => `[data-qa="${id}|${o}"]`));
    };
    const locStep = id => {                                                   // 「在哪裡？」選填
      if (r() < SKIPLOC[pk]) return;
      const truth = gtLoc[id] || (gtLoc[id] = genLoc()); advance(T, X.skim * 10 / p.cps + .8 * p.dq);
      for (const k of truth) {
        const sel = `[data-l="${id}|${k}"]`;
        if (r() < Math.min(.5, 1.5 * p.err * X.err)) { const w = ALLLOC.filter(z => z !== k)[Math.floor(r() * (ALLLOC.length - 1))]; tap(`[data-l="${id}|${w}"]`); if (r() < .5) { advance(T, p.fix); fixes++; tap(`[data-l="${id}|${w}"]`); tap(sel); } }
        else tap(sel);
      }
    };
    // 0 開始：輸入生日 4 碼、按開始
    advance(T, X.skim * 60 / p.cps + p.dq); const bi = Q('#birth'); tp.tap(T, bi); advance(T, 4 * p.key); bi.value = '0315'; bi.dispatchEvent(new Event('input', { bubbles: true })); tap('#go'); chk();
    let guard = 0;
    while (!S.done && !abandoned && guard++ < 60) {
      const k = key(), st = STEPS[S.i]; if (!st) { bad('badStep', S.i); break; }
      advance(T, X.skim * 14 / p.cps);
      if (st.items) {
        const ids = st.items.map(x => x.id), anyYes = ids.some(id => gt[id]);
        const canShort = st.short;
        if (canShort && !anyYes && r() < p.sc) { advance(T, p.dq * .6); tap('#allno'); shortcutUsed++; if (Q('#allno-yes')) { advance(T, X.skim * 12 / p.cps + .5 * p.dq); tap('#allno-yes'); } }
        else if (canShort && anyYes && r() < p.hurry) {                           // 其實有症狀卻趕著按「都沒有」
          advance(T, p.dq * .6); tap('#allno'); shortcutUsed++;
          if (Q('#allno-yes')) {                                                  // 有二次確認：看到「這一頁沒選的都選沒有嗎？」
            advance(T, X.skim * 12 / p.cps + .5 * p.dq);
            if (r() < Q2) { tap('#allno-cancel'); caught++; } else { tap('#allno-yes'); shortcutMask += ids.filter(i => gt[i]).length; }
          }
          else if (r() < .5) { advance(T, p.fix); fixes++; for (const id of ids.filter(i => gt[i])) { advance(T, X.skim * ITEM[id].n.length / p.cps); answer(id, 'y'); } }
          else shortcutMask += ids.filter(i => gt[i]).length;
        }
        if (r() < .05) { advance(T, p.dq * .5); tap('#next'); }                    // 沒答完就按下一步
        for (const id of ids) {
          if (chk()) break;
          if (S.a[id]) continue;
          const it = ITEM[id]; advance(T, X.skim * (it.n.length + it.d.length) / p.cps + .6 * p.dq * lognorm(r));
          const truth = gt[id] ? 'y' : 'n'; let want = truth; if (r() < p.unsure * (truth === 'y' ? 1.5 : .5)) want = 'u';
          answer(id, want);
        }
        if (chk()) break;
        if (r() < p.burst) { bursts++; tap('#next'); quick('#next'); quick('#next'); } else tap('#next');
        if (r() < .06 && S.i > 0 && key() !== 'done') { advance(T, 1); tap('#back'); backs++; advance(T, 1.5); tap('#next'); }
      } else if (k === 'note') {
        if (r() < .15) { const t = Q('#note'); tp.tap(T, t); advance(T, 20 * p.ime); t.value = '最近睡不好，有點擔心'; t.dispatchEvent(new Event('input', { bubbles: true })); } else advance(T, .5);
        if (r() < p.burst) { bursts++; tap('#next'); quick('#next'); quick('#next'); } else tap('#next');
      } else if (k === 'review') {
        advance(T, X.skim * 120 / p.cps);
        if (Q('#redok')) {                                                        // 有紅旗確認區：再讀一次、發現選錯就改、按「這 4 項都對」
          advance(T, X.skim * 40 / p.cps + p.dq);
          for (const id of REDIDS) if (intent[id] && S.a[id] !== intent[id] && r() < Q3) { advance(T, p.fix); redFixed++; press(`[data-a="${id}|${intent[id]}"]`, null); }
          advance(T, p.dq * .5); tap('#redok');
        }
        if (r() < p.burst) { bursts++; tap('#next'); quick('#next'); quick('#next'); } else tap('#next');
      }
      chk();
    }
    if (S.done) advance(T, 3);                                                    // 送出等待
    // 判定
    const completed = S.done && !abandoned;
    if (completed && IDS.some(id => !S.a[id])) bad('doneWithUnanswered', n);
    if (maxJump > 1) bad('stepSkip', n);
    if (S.done && revAt !== null && doneAt !== null && doneAt - revAt < 250) bad('submitWithoutReview', n);
    if (S.done && S.i !== STEPS.length - 1) bad('doneOffReview', n);
    const rec = id => S.a[id] || null;
    const fid = { tp: 0, fn: 0, fnUnsure: 0, fp: 0, tn: 0, unsureNeg: 0, sevExact: 0, sevNear: 0, sevN: 0, redPos: 0, redOk: 0, redOkStrict: 0 };
    for (const id of IDS) {
      const isY = !!gt[id], v = rec(id);
      if (isY) { if (v === 'y') { fid.tp++; if (!ITEM[id].nosev) { fid.sevN++; const sv = S.sev[id]; if (sv === gt[id]) fid.sevExact++; if (sv && Math.abs(sv - gt[id]) <= 1) fid.sevNear++; } } else { fid.fn++; if (v === 'u') fid.fnUnsure++; } }
      else { if (v === 'y') fid.fp++; else if (v === 'n') fid.tn++; else if (v === 'u') fid.unsureNeg++; }
    }
    const redYes = REDIDS.filter(id => gt[id]); if (redYes.length) { fid.redPos = 1; fid.redOk = redYes.every(id => rec(id) === 'y' || rec(id) === 'u') ? 1 : 0; fid.redOkStrict = redYes.every(id => rec(id) === 'y') ? 1 : 0; }
    // 現行流程的時間（同一位病人、同一個放棄時間）當對照
    const nz = {}; PTD.IDS.forEach(i => nz[i] = lognorm(r));
    const PARENT = { blood: 'diarrhea', hemo: 'swallow', weak: 'joint' };      // v4–v7 沒有 page 欄時的對照
    const pagesOf = id => [].concat(ITEM[id].page || PARENT[id] || id);
    const pageVis = pg => !ADDON[pg] || txs.includes(ADDON[pg]);
    const OLDIDS = PTD.IDS.filter(pg => PT[pg] && pageVis(pg));                // 現行題庫順序（panel 順序）的頁
    const pageYes = pg => IDS.some(id => gt[id] && pagesOf(id).includes(pg));
    const redPages = [...new Set(REDIDS.flatMap(pagesOf))].filter(pg => OLDIDS.includes(pg));
    const runOld = seq => { let t = CN.FIXED - 3 + CN.CC, tr = 0; for (const i of seq) { t += (pageYes(i) ? PT[i].follow : PT[i].gate) * (nz[i] || 1); if (redPages.includes(i)) tr = t; } return [t + CN.ADL + 3, tr]; };
    const [tOld, tOldRed] = runOld(OLDIDS), [, tOldRF] = runOld([...redPages, ...OLDIDS.filter(i => !redPages.includes(i))]);
    const redDone = REDIDS.every(id => S.a[id]);
    const qf = { n: 0, cap: 0, exact: 0, thr: 0, thrN: 0, thrMiss: 0, thrPos: 0, thrPosSkip: 0, thrEsc: 0 };
    if (HAS_Q) for (const id of IDS) if (ITEM[id].q && gt[id] && S.a[id] === 'y') { qf.n++; const rec = S.q[id], tr = gtQ[id]; if (rec) qf.cap++; if (rec && tr === rec) qf.exact++;
      for (const set of (QTHR[id] || [])) { if (tr) { qf.thrN++; const esc = rec === 'none' || rec === 'unk' /* 逃生選項＝交給護理確認，不算漏 */, t = set.includes(tr), g = rec ? set.includes(rec) : false; if (t) { qf.thrPos++; if (!rec) qf.thrPosSkip++; if (esc) qf.thrEsc++; } if (t === g) qf.thr++; else if (t && !g && !esc) qf.thrMiss++; } } }
    const lf = { n: 0, cap: 0, exact: 0, part: 0 };
    if (HAS_LOC) for (const id of IDS) if (LOCABLE.has(id) && gt[id] && S.a[id] === 'y') { lf.n++; let rec = S.loc[id] ? [...S.loc[id]] : []; if (BODY.every(k => rec.includes(k))) rec = ['whole'];   // 8 塊全選＝全身（v6 的「全身」會把圖上全部選起來）
      const tr = gtLoc[id] || null;
      if (rec.length) lf.cap++; if (tr && rec.length === tr.length && tr.every(k => rec.includes(k))) lf.exact++; if (tr && tr.some(k => rec.includes(k))) lf.part++; }
    const tRedNew = null;
    const naiveC = completed && (T.sec + extra <= A), naiveR = tRedAt !== null && (tRedAt + extra <= A);
    rows.push({ gt, gtQ, gtLoc, txs, qf, pk, txg: (txs.includes('io') || txs.includes('adc')) ? 'io' : 'std', lf, tOldRF, caught, redFixed, tRedAt, naiveC, naiveR, extra, k: gtIds.length, completed, abandoned, abStep, T: T.sec + (completed ? CN.ADL : 0), taps: tp.taps, scrolls: tp.scrolls, needHits: S.needHits, maxJump, shortcutMask, shortcutUsed, backs, bursts, fixes, wrongKept, fid, redDone, tOld, tOldRed, A, minW: Math.min(...tp.widths, 999) });
  }
  const agg = L => { const n = L.length; if (!n) return null;
    const rate = (f, d) => { const sub = d ? L.filter(d) : L, k = sub.filter(f).length, ci = wilson(k, sub.length); return { v: sub.length ? k / sub.length : null, lo: ci[0], hi: ci[1], n: sub.length }; };
    const comp = L.filter(s => s.completed), sum = key => L.reduce((a, s) => a + s.fid[key], 0);
    const sens = sum('tp') / Math.max(1, sum('tp') + sum('fn')), spec = sum('tn') / Math.max(1, sum('tn') + sum('fp') + sum('unsureNeg'));
    const cs = f => comp.reduce((a, s) => a + s.fid[f], 0);
    const ls = k => L.reduce((a, s) => a + s.lf[k], 0);
    const qs = k => L.reduce((a, s) => a + s.qf[k], 0);
    return { n, qN: qs('n'), qCapture: qs('cap') / Math.max(1, qs('n')), qExact: qs('exact') / Math.max(1, qs('n')), qThrOK: qs('thr') / Math.max(1, qs('thrN')), qThrMiss: qs('thrMiss') / Math.max(1, qs('thrN')), qThrSens: 1 - qs('thrMiss') / Math.max(1, qs('thrPos')), qThrPos: qs('thrPos'), qThrEscShare: qs('thrEsc') / Math.max(1, qs('thrPos')), qThrSkipShare: qs('thrPosSkip') / Math.max(1, qs('thrMiss')), oldRedFirstRedCaptured: rate(s => s.tOldRF <= s.A), caughtPerSession: mean(L.map(s => s.caught)), redFixedPerSession: mean(L.map(s => s.redFixed)), naiveCompletion: rate(s => s.naiveC), naiveRedCaptured: rate(s => s.naiveR), locN: ls('n'), locCapture: ls('cap') / Math.max(1, ls('n')), locExact: ls('exact') / Math.max(1, ls('n')), locPartial: ls('part') / Math.max(1, ls('n')), completion: rate(s => s.completed), oldCompletion: rate(s => s.tOld <= s.A),
      redCaptured: rate(s => s.redDone, s => s.fid.redPos === 1 || true), oldRedCaptured: rate(s => s.tOldRed <= s.A),
      redRecallStrictAmongPos: rate(s => s.fid.redOkStrict === 1, s => s.fid.redPos === 1 && s.completed), redRecallFlaggedAmongPos: rate(s => s.fid.redOk === 1, s => s.fid.redPos === 1 && s.completed),
      sensitivityCompleters: cs('tp') / Math.max(1, cs('tp') + cs('fn')), sensitivityFlagged: (cs('tp') + cs('fnUnsure')) / Math.max(1, cs('tp') + cs('fn')), falsePosPerSession: cs('fp') / Math.max(1, comp.length), unsureNegPerSession: cs('unsureNeg') / Math.max(1, comp.length),
      sevExact: cs('sevExact') / Math.max(1, cs('sevN')), sevNear: cs('sevNear') / Math.max(1, cs('sevN')),
      Tmed: pct(comp.map(s => s.T), .5) / 60, Tp90: pct(comp.map(s => s.T), .9) / 60, oldTmed: pct(L.map(s => s.tOld), .5) / 60, oldTp90: pct(L.map(s => s.tOld), .9) / 60,
      taps: { med: pct(comp.map(s => s.taps), .5), p90: pct(comp.map(s => s.taps), .9) }, scrolls: mean(comp.map(s => s.scrolls)),
      needHitsPerSession: mean(L.map(s => s.needHits)), maxJumpMax: Math.max(...L.map(s => s.maxJump)), skippedSessions: L.filter(s => s.maxJump > 1).length,
      shortcutMaskedSessions: L.filter(s => s.shortcutMask > 0).length, shortcutMaskedItems: L.reduce((a, s) => a + s.shortcutMask, 0), wrongKeptPerSession: mean(L.map(s => s.wrongKept)),
      burstsPerSession: mean(L.map(s => s.bursts)), abandonByStep: L.filter(s => s.abandoned).reduce((o, s) => (o[s.abStep] = (o[s.abStep] || 0) + 1, o), {}), minTargetPx: Math.min(...L.map(s => s.minW)) }; };
  if (CFG.detail) return JSON.stringify({ detail: rows.map(s => ({ pk: s.pk, completed: s.completed, abandoned: s.abandoned, abStep: s.abStep, gt: s.gt, gtQ: s.gtQ, gtLoc: s.gtLoc, txs: s.txs, T: s.T, taps: s.taps, redDone: s.redDone })) });
  const byP = {}; for (const k of PKEYS) byP[k] = agg(rows.filter(s => s.pk === k));
  const byTx = { io: agg(rows.filter(s => s.txg === 'io')), std: agg(rows.filter(s => s.txg === 'std')), io70: agg(rows.filter(s => s.txg === 'io' && s.pk === 'elder')), std70: agg(rows.filter(s => s.txg === 'std' && s.pk === 'elder')) };
  return JSON.stringify({ ui: 'patient_v4', n: N, vw: innerWidth, vh: innerHeight, cfg: CFG, all: agg(rows), byPersona: byP, byTx, small: Object.fromEntries(Object.entries(SMALLALL).sort((a, b) => b[1][1] - a[1][1]).slice(0, 14)), violations: viol, errorCount: errs.length, errors: errs.slice(0, 5) });
} catch (e) { return 'EXC ' + (e && e.stack || e); }
})()
