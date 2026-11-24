(() => {
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ==================== Theme & Storage ==================== */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('corpx:' + k); return v ? JSON.parse(v) : d; }
    catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('corpx:' + k, JSON.stringify(v)); } catch {}
  },
  del(k) {
    try { localStorage.removeItem('corpx:' + k); } catch {}
  },
};

function applyTheme(th) {
  store.set('theme', th);
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
  $$('#themeChips .chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.th === th));
}
applyTheme(store.get('theme', 'auto'));

/* ==================== IndexedDB (Data + Non-extractable Vault Key) ==================== */
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('corpx', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = (stName, m, f) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction(stName, m);
    const st = t.objectStore(stName);
    const q = f(st);
    t.oncomplete = () => res(q && q.result);
    t.onerror = () => rej(t.error);
  }));
  return {
    get: k => tx('kv', 'readonly', s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)).then(() => true).catch(() => false),
    del: k => tx('kv', 'readwrite', s => s.delete(k)).catch(() => {}),
    getKey: () => tx('vault', 'readonly', s => s.get('key')).catch(() => undefined),
    setKey: obj => tx('vault', 'readwrite', s => s.put(obj, 'key')).then(() => true).catch(() => false),
    delKey: () => tx('vault', 'readwrite', s => s.delete('key')).catch(() => {}),
  };
})();
let IDB_OK = true;

/* ==================== WebCrypto AES-256-GCM Vault ==================== */
const CANARY = 'CORPX-VAULT-OK-V1';
let VAULT_META = null;
let VAULT_KEY = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function deriveVaultKey(password, saltB64, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable!
    ['decrypt']
  );
}

async function verifyKey(key, vault) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(vault.checkIv) },
      key,
      b64ToBytes(vault.checkCt)
    );
    return new TextDecoder().decode(pt) === CANARY;
  } catch {
    return false;
  }
}

async function fetchAndDecryptJson(name) {
  const res = await fetch(`./data/${name}.enc?v=${encodeURIComponent(VAULT_META.salt.slice(0, 8))}`);
  if (!res.ok) throw new Error(`${name}.enc 불러오기 실패 (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const gzBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, VAULT_KEY, ct);
  const ds = new Blob([gzBuf]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(ds).text();
  return JSON.parse(text);
}

async function lockAppNow() {
  await idb.delKey();
  VAULT_KEY = null;
  location.reload();
}

/* ==================== Core State & Constants ==================== */
const CORP_COLOR = ['var(--kospi)', 'var(--kosdaq)', 'var(--konex)', 'var(--etc)'];
const CORP_SHORT = ['코스피', '코스닥', '코넥스', '기타법인'];
const MEMO_STAGES = ['접촉중', '제안중', '계약', '보류'];
let META, MAP, ROWS = [], N = 0;
let NAMEK, NAMEC, ALLK, TELD, ADDRK, HOMEK;
let FAV = new Set(store.get('fav', []));
let MEMOS = store.get('memos', {}); // { bizNo10: { stage, text, updated } }
let BAKED = null;
let BAKED_STATUS = null;
let APP_BOOTED = false;

/* ---------- AI 도입 적합도 모델 ---------- */
const AICAT = [
  ['고객상담·콜센터', /콜센터|텔레마케팅|고객.?상담/, 50, ['AI 보이스봇·챗봇으로 1차 상담 자동화', '상담 내용 자동 요약·분류(STT+LLM)', '상담 품질(QA) 자동 평가'], '상담 인력 비용이 크고 통화 데이터가 이미 쌓여 있어 효과가 바로 보이는 분야'],
  ['제조', /제조/, 45, ['AI 비전 품질검사(불량 자동 판별)', '설비 센서 기반 예지보전', '수요예측·생산계획 최적화'], '불량률·설비 정지가 곧 비용 — 스마트공장 바우처 등 정부지원과 연계 쉬움'],
  ['물류·운송', /운송|창고|택배|물류|화물|하역|보관/, 45, ['배차·경로 최적화', '물동량·입출고 예측', '창고 CCTV 기반 안전·재고 모니터링'], '유류비·인건비 절감액을 숫자로 바로 보여줄 수 있음'],
  ['시설관리·보안', /시설.*관리|부동산 관리|경비|보안|청소|사업지원|인력 공급|건물.*관리/, 40, ['AI CCTV 이상행동·침입 감지 관제', '순찰·근태 자동화', '민원 접수 챗봇'], '영상·출입 데이터가 이미 있어 AI CCTV·관제 상품과 바로 연결'],
  ['유통·도소매', /소매|슈퍼마켓|편의점|백화점|전자상거래|도매|상품 중개/, 40, ['수요예측·자동 발주', '개인화 상품 추천·마케팅 문구 생성', '매장 AI CCTV 고객동선·도난 분석'], '재고·판매 데이터가 풍부해 단기 성과(재고 감소)를 내기 좋음'],
  ['금융(영업)', /은행|보험|증권|신용카드|저축|신용조합|대부/, 40, ['이상거래(FDS) 탐지', '대출·보험 심사 서류 자동 판독', 'AI 상담·불완전판매 모니터링'], '규제 대응·심사 업무가 많아 문서 AI 수요가 큼'],
  ['의료·제약', /병원|의원|의료|요양|약학|의약|보건/, 35, ['예약·문의 응대 자동화', '의무기록 요약·청구 자동화', '의료영상 판독 보조'], '접수·행정 업무 부담이 크고 인력난이 심한 분야'],
  ['에너지·유틸리티', /발전|전기 공급|가스|수도|에너지|증기/, 35, ['발전량·수요 예측', '설비 이상탐지', '현장 안전 AI 모니터링'], '설비 가동률과 안전사고 감축이 핵심 지표'],
  ['건설·엔지니어링', /건설|공사업|엔지니어링|토목/, 30, ['현장 안전 AI CCTV(안전모·위험구역)', '공정 사진 기반 진척 관리', '견적·설계 문서 자동화'], '중대재해처벌법 대응으로 현장 안전 AI 수요가 높음'],
  ['숙박·외식·레저', /호텔|숙박|음식|주점|골프장|여행|레저|휴양/, 30, ['예약·문의 챗봇', '수요예측 기반 가격·인력 운영', '리뷰 분석·응대 자동화'], '고객 응대량이 많고 성수기 인력 운영 부담이 큼'],
  ['교육', /교육|학원|훈련/, 30, ['맞춤형 학습 콘텐츠 생성', '상담·출결 자동화', '채점·피드백 보조'], '콘텐츠 제작 비용 절감 효과가 큼'],
  ['IT·소프트웨어', /소프트웨어|정보|통신|데이터|시스템 통합|컴퓨터|프로그래밍|포털/, 30, ['제품에 생성형 AI 기능 내재화', '개발 생산성(코딩 AI) 도입', '고객지원 자동화'], '기술 수용도가 높아 PoC가 빠름 — 경쟁사 협업 가능성도 검토'],
  ['전문서비스', /컨설팅|회계|세무|법무|변호|광고|연구개발|디자인|시장 조사/, 30, ['보고서·제안서 초안 생성', '문서 검토·요약', '리서치 자동화'], '문서 업무 비중이 높아 생성형 AI 체감 효과가 큼'],
  ['투자·SPC', /금융|투자|신탁|여신|지주회사|자산 운용/, 5, ['(투자·특수목적 법인 성격 — 직접 도입 수요 낮음)'], '실제 운영 조직이 작거나 없는 경우가 많아 우선순위 낮음'],
  ['부동산 개발·임대', /부동산|임대|건물 개발|공급업/, 8, ['(개발·임대 법인 — 직접 도입 수요 낮음)', '임대 관리 법인이면 시설관리 AI 검토'], 'SPC·PFV가 많아 우선순위 낮음'],
  ['기타', /.*/, 25, ['사내 문서·규정 검색 AI(사내 GPT)', '고객 문의 응대 자동화'], '업종별 세부 확인 필요'],
];

let AI_S, AI_C, IND_CAT;
function buildAI() {
  IND_CAT = META.industries.map(n => AICAT.findIndex(c => c[1].test(n)));
  AI_S = new Uint8Array(N);
  AI_C = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = ROWS[i];
    const c = IND_CAT[r[12]];
    AI_C[i] = c;
    AI_S[i] = aiParts(r, c, i).reduce((a, b) => a + b, 0);
  }
}
function sizePts(i, r) {
  const v = typeof revEok === 'function' ? revEok(i) : NaN;
  const e = typeof empOf === 'function' ? empOf(i) : NaN;
  if (v === v) return [v >= 10000 ? 30 : v >= 1000 ? 27 : v >= 300 ? 22 : v >= 100 ? 18 : v >= 30 ? 13 : 8, '규모(매출)'];
  if (e === e) return [e >= 1000 ? 30 : e >= 300 ? 26 : e >= 100 ? 21 : e >= 50 ? 17 : e >= 10 ? 12 : 7, '규모(직원)'];
  return [[30, 25, 18, 10][r[5]], '규모(상장)'];
}
function aiParts(r, c, i) {
  const a = age(r[13]);
  return [AICAT[c][2], i === undefined ? [30, 25, 18, 10][r[5]] : sizePts(i, r)[0], a === null ? 4 : a >= 10 ? 10 : a >= 5 ? 7 : 4, r[10] ? 10 : 0];
}

const S = {
  q: '', name: '', sido: '', sggs: [], dongs: [], addr: '', tel: '', home: '', hasHome: false,
  ind: [], from: '', to: '', corp: [], fm: '', fav: false, hasMemo: false, memoSt: [],
  ai: 0, aicat: '', cust: [], stat: [], br: [], revB: [], empB: [], prof: false, grow: false, hire: false,
  tags: [], salB: [], outMin: 0, fut: false, netup: false, nip: false, indKw: '',
  leadG: '', cred: '', nozb: false, pat: [], hr: [], rpeMin: 0, sort: 'rel',
};
let RES = new Int32Array(0), SHOWN = 0, CUR = -1;

/* ---------- utils ---------- */
const fmt = n => n.toLocaleString('ko-KR');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function cho(s) {
  let o = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xAC00 && c <= 0xD7A3) o += CHO[((c - 0xAC00) / 588) | 0];
    else if (/[0-9a-zA-Z]/.test(ch)) o += ch.toLowerCase();
  }
  return o;
}
const isCho = s => /^[ㄱ-ㅎ]+$/.test(s);
const norm = s => s.toLowerCase().replace(/\(주\)|주식회사|㈜|\s+/g, '');
const digits = s => String(s || '').replace(/\D/g, '');
const estStr = v => v ? `${String(v).slice(0, 4)}.${String(v).slice(4, 6)}.${String(v).slice(6, 8)}` : '-';
const TODAY = (() => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
const age = v => v ? Math.floor((TODAY - v) / 10000) : null;
function toast(t) {
  const e = $('#toast');
  e.textContent = t;
  e.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => e.classList.remove('on'), 2000);
}
async function copy(t, msg) {
  try { await navigator.clipboard.writeText(t); toast(msg || '복사했습니다'); }
  catch { toast('복사가 허용되지 않는 환경입니다'); }
}
const homeUrl = h => !h ? '' : (/^https?:\/\//i.test(h) ? h : 'http://' + h);
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const memoOf = i => MEMOS[digits(ROWS[i][6])] || null;

/* ==================== Load Encrypted Bundles ==================== */
async function loadData() {
  const bar = $('#lbar'), txt = $('#ltxt');
  bar.style.width = '10%';
  txt.textContent = '메타·지도 복호화 중…';
  const [meta, map] = await Promise.all([fetchAndDecryptJson('meta'), fetchAndDecryptJson('map')]);
  META = meta;
  MAP = map;
  bar.style.width = '24%';

  let done = 0;
  const totalTasks = meta.chunks.length + 2;
  const step = label => {
    done++;
    bar.style.width = (24 + (done / totalTasks) * 58) + '%';
    txt.textContent = `${label} (${done}/${totalTasks})`;
  };

  const chunkPs = meta.chunks.map((_, k) =>
    fetchAndDecryptJson('c' + k).then(j => { step('기업 데이터 복호화'); return j; })
  );
  const enrichP = fetchAndDecryptJson('enrich').then(j => { step('재무·국민연금 복호화'); return j; }).catch(() => null);
  const statusP = fetchAndDecryptJson('status').then(j => { step('사업자상태 복호화'); return j; }).catch(() => null);

  const parts = await Promise.all(chunkPs);
  ROWS = parts.flat();
  N = ROWS.length;
  BAKED = await enrichP;
  BAKED_STATUS = await statusP;

  buildAI();
  txt.textContent = '검색 색인 만드는 중…';
  bar.style.width = '88%';
  await new Promise(r => setTimeout(r, 15));

  NAMEK = new Array(N);
  NAMEC = new Array(N);
  ALLK = new Array(N);
  TELD = new Array(N);
  ADDRK = new Array(N);
  HOMEK = new Array(N);
  for (let i = 0; i < N; i++) {
    const r = ROWS[i];
    NAMEK[i] = norm(r[0] + '|' + r[2]);
    NAMEC[i] = cho(r[0].replace(/\(주\)|주식회사|㈜/g, ''));
    ALLK[i] = (NAMEK[i] + '|' + r[1].toLowerCase().replace(/\s+/g, '') + '|' + r[4].replace(/\s+/g, '') + '|' + r[3].trim() + '|' + digits(r[6]));
    TELD[i] = digits(r[8]);
    ADDRK[i] = r[7].replace(/\s+/g, '').toLowerCase();
    HOMEK[i] = r[10].toLowerCase();
  }
  bar.style.width = '100%';
}

/* ==================== Filters UI ==================== */
let IND_CNT;
function initFilters() {
  $('#srcTxt').textContent = `${fmt(N)}개 기업 · ${META.source}`;
  const sel = $('#fSido');
  META.sido.forEach(s => sel.insertAdjacentHTML('beforeend', `<option value="${s.sd}">${s.n}</option>`));
  sel.insertAdjacentHTML('beforeend', `<option value="xx">해외·미분류</option>`);
  const fm = $('#fFm');
  for (let m = 1; m <= 12; m++) fm.insertAdjacentHTML('beforeend', `<option value="${m}">${m}월</option>`);
  $('#corpChips').innerHTML = META.corp.map((c, i) => `<button class="chip" data-c="${i}" aria-pressed="false"><span class="dot" style="background:${CORP_COLOR[i]}"></span>${c}</button>`).join('');
  $('#memoChips').innerHTML = MEMO_STAGES.map(st => `<button class="chip" data-ms="${st}" aria-pressed="false">${st}</button>`).join('');
  $('#memoChips').onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const v = b.dataset.ms;
    S.memoSt = S.memoSt.includes(v) ? S.memoSt.filter(x => x !== v) : [...S.memoSt, v];
    run();
  };

  IND_CNT = new Int32Array(META.industries.length);
  for (let i = 0; i < N; i++) IND_CNT[ROWS[i][12]]++;

  const bind = (id, key, ev = 'input', fn = e => e.target.value.trim()) => $(id).addEventListener(ev, debounce(e => { S[key] = fn(e); run(); }, 180));
  bind('#fName', 'name'); bind('#fAddr', 'addr'); bind('#fTel', 'tel'); bind('#fHome', 'home');
  $('#fHasHome').addEventListener('change', e => { S.hasHome = e.target.checked; run(); });
  $('#fFav').addEventListener('change', e => { S.fav = e.target.checked; run(); });
  $('#fHasMemo').addEventListener('change', e => { S.hasMemo = e.target.checked; run(); });

  const cc = new Int32Array(AICAT.length);
  for (let i = 0; i < N; i++) cc[AI_C[i]]++;
  AICAT.forEach((c, k) => $('#fAiCat').insertAdjacentHTML('beforeend', `<option value="${k}">${c[0]} (${fmt(cc[k])})</option>`));
  $('#fAiCat').addEventListener('change', e => { S.aicat = e.target.value; run(); });
  $('#aiChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; S.ai = +b.dataset.s; if (S.ai && S.sort === 'rel') S.sort = 'ai'; run(); });
  $('#aiPreset').onclick = () => { S.ai = 70; S.sort = 'ai'; run(); openFilter(false); if (isMobile()) setView('list'); toast(`AI 도입 유망(70점+) ${fmt(RES.length)}개 · 적합도순`); };
  $('#fFm').addEventListener('change', e => { S.fm = e.target.value; run(); });
  $('#fSido').addEventListener('change', e => { S.sido = e.target.value; fillSgg(); run(); });
  $('#fSgg').addEventListener('change', e => { const v = e.target.value; if (v !== '' && !S.sggs.includes(+v)) S.sggs.push(+v); e.target.value = ''; run(); });
  $('#sggChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { toggleSgg(+b.dataset.r); run(); } });
  $('#dongChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { S.dongs = S.dongs.filter(x => x !== +b.dataset.d); run(); } });
  initDong();
  $('#fFrom').addEventListener('change', e => { S.from = e.target.value; clearPreset(); run(); });
  $('#fTo').addEventListener('change', e => { S.to = e.target.value; clearPreset(); run(); });
  $('#corpChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; const c = +b.dataset.c; S.corp = S.corp.includes(c) ? S.corp.filter(x => x !== c) : [...S.corp, c]; run(); });
  $('#estPreset').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const on = b.getAttribute('aria-pressed') === 'true'; clearPreset();
    if (on) { S.from = S.to = ''; } else {
      b.setAttribute('aria-pressed', 'true');
      const p = b.dataset.p, y = new Date().getFullYear(), md = new Date().toISOString().slice(4, 10);
      const d = n => `${y - n}${md}`;
      if (p === '3') { S.from = d(3); S.to = ''; }
      else if (p === '10') { S.from = d(10); S.to = ''; }
      else if (p === '10-30') { S.from = d(30); S.to = d(10); }
      else if (p === '30+') { S.from = ''; S.to = d(30); }
      else if (p === '50+') { S.from = ''; S.to = d(50); }
    }
    $('#fFrom').value = S.from; $('#fTo').value = S.to; run();
  });

  // industry suggest
  const ii = $('#fIndIn'), il = $('#indList'); let act = -1, opts = [];
  const show = () => {
    const v = ii.value.trim().replace(/\s+/g, ''); const out = [];
    META.industries.forEach((n, i) => { if (S.ind.includes(i)) return; if (!v || n.replace(/\s+/g, '').includes(v) || cho(n).includes(v)) out.push(i); });
    out.sort((a, b) => IND_CNT[b] - IND_CNT[a]); opts = out.slice(0, 40); act = -1;
    il.innerHTML = opts.length ? opts.map(i => `<button role="option" data-i="${i}"><span>${esc(META.industries[i])}</span><span class="tiny num">${fmt(IND_CNT[i])}</span></button>`).join('') : '<div class="tiny" style="padding:10px 12px">일치하는 업종이 없습니다</div>';
    il.classList.add('open');
  };
  ii.addEventListener('input', show); ii.addEventListener('focus', show);
  ii.addEventListener('keydown', e => {
    const bs = [...il.querySelectorAll('button')];
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, bs.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter') { const b = bs[act < 0 ? 0 : act]; if (b) { addInd(+b.dataset.i); e.preventDefault(); } return; }
    else if (e.key === 'Escape') { il.classList.remove('open'); return; } else return;
    bs.forEach((b, k) => b.classList.toggle('act', k === act)); bs[act] && bs[act].scrollIntoView({ block: 'nearest' });
  });
  il.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (b) { e.preventDefault(); addInd(+b.dataset.i); } });
  ii.addEventListener('blur', () => setTimeout(() => il.classList.remove('open'), 120));
  $('#indChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { S.ind = S.ind.filter(x => x !== +b.dataset.i); run(); } });
  function addInd(i) { if (!S.ind.includes(i)) S.ind.push(i); ii.value = ''; il.classList.remove('open'); run(); }

  // global search
  const q = $('#q');
  q.addEventListener('input', debounce(() => { S.q = q.value.trim(); $('#searchBox').classList.toggle('has', !!S.q); run(); }, 160));
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { q.blur(); if (isMobile()) setView('list'); } });
  $('#qclr').onclick = () => { q.value = ''; S.q = ''; $('#searchBox').classList.remove('has'); run(); q.focus(); };
  $('#sort').onchange = e => { S.sort = e.target.value; run(); };
  $('#resetAll').onclick = resetAll;
  $('#dlCsv').onclick = () => exportResults('csv');
  $('#copyRes').onclick = () => exportResults('copy');
  $('#openF').onclick = () => openFilter(true);
  $('#closeF').onclick = () => openFilter(false);
}

function clearPreset() { $$('#estPreset .chip').forEach(b => b.setAttribute('aria-pressed', 'false')); }
function toggleSgg(id) {
  if (S.sggs.includes(id)) { S.sggs = S.sggs.filter(x => x !== id); S.dongs = S.dongs.filter(d => META.dongs[d][0] !== id); }
  else S.sggs.push(id);
}
const regName = id => { const r = MAP.regions[id]; return MAP.sidos.find(s => s.sd === r.sd).s + ' ' + r.n; };
function dongScope() {
  const sg = S.sggs.length ? new Set(S.sggs) : null;
  const sd = S.sido && S.sido !== 'xx' ? S.sido : '';
  const out = [];
  META.dongs.forEach((d, i) => { if (sg ? sg.has(d[0]) : (!sd || MAP.regions[d[0]].sd === sd)) out.push(i); });
  return out;
}
function initDong() {
  const ii = $('#fDongIn'), il = $('#dongList'); let act = -1;
  const show = () => {
    const parts = ii.value.split(/[,，\s]+/); const v = (parts[parts.length - 1] || '').trim();
    const sc = dongScope();
    let out = sc.filter(i => !S.dongs.includes(i) && (!v || META.dongs[i][1].includes(v) || cho(META.dongs[i][1]).startsWith(v)));
    out.sort((a, b) => { const A = META.dongs[a], B = META.dongs[b]; return (v && (B[1].startsWith(v) - A[1].startsWith(v))) || B[2] - A[2]; });
    out = out.slice(0, 50); act = -1;
    const multi = parts.filter(Boolean).length > 1;
    il.innerHTML = (multi ? `<button data-all="1"><span><b>입력한 ${parts.filter(Boolean).length}개 동 모두 추가</b></span><span class="tiny">Enter</span></button>` : '') +
      (out.length ? out.map(i => `<button role="option" data-d="${i}"><span>${esc(META.dongs[i][1])} <span class="tiny">${esc(regName(META.dongs[i][0]))}</span></span><span class="tiny num">${fmt(META.dongs[i][2])}</span></button>`).join('') : '<div class="tiny" style="padding:10px 12px">범위 안에 일치하는 읍·면·동이 없습니다</div>');
    il.classList.add('open');
  };
  const addAll = () => {
    const names = ii.value.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean); if (!names.length) return false;
    const sc = dongScope(); let added = 0, miss = [];
    names.forEach(n => {
      const nn = n.replace(/\d+(?=동$)/, '');
      const hit = sc.filter(i => { const d = META.dongs[i][1]; return d === nn || d === nn + '동' || (nn.length >= 2 && !/[동읍면]$/.test(nn) && d.startsWith(nn)); });
      if (!hit.length) miss.push(n); hit.forEach(i => { if (!S.dongs.includes(i)) { S.dongs.push(i); added++; } });
    });
    ii.value = ''; il.classList.remove('open'); run();
    toast(`${added}개 읍·면·동 추가 · ${fmt(RES.length)}개 기업` + (miss.length ? ` · 없음: ${miss.join(', ')}` : ''));
    return true;
  };
  ii.addEventListener('input', show); ii.addEventListener('focus', show);
  ii.addEventListener('keydown', e => {
    const bs = [...il.querySelectorAll('button')];
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, bs.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); const b = act >= 0 ? bs[act] : null; if (b && b.dataset.d) { S.dongs.push(+b.dataset.d); ii.value = ''; il.classList.remove('open'); run(); } else addAll(); return; }
    else if (e.key === 'Escape') { il.classList.remove('open'); return; } else return;
    bs.forEach((b, k) => b.classList.toggle('act', k === act)); bs[act] && bs[act].scrollIntoView({ block: 'nearest' });
  });
  il.addEventListener('mousedown', e => {
    const b = e.target.closest('button'); if (!b) return; e.preventDefault();
    if (b.dataset.all) addAll();
    else { S.dongs.push(+b.dataset.d); const parts = ii.value.split(/[,，]/); parts.pop(); ii.value = parts.length ? parts.join(',') + ',' : ''; run(); show(); }
  });
  ii.addEventListener('blur', () => setTimeout(() => il.classList.remove('open'), 150));
}
function setSido(sd, sgg) { S.sido = sd; S.sggs = (sgg === '' || sgg == null) ? [] : [+sgg]; S.dongs = []; $('#fSido').value = sd; fillSgg(); }
function fillSgg() {
  const sd = S.sido; const s = $('#fSgg'); s.innerHTML = '<option value="">+ 시·군·구 추가</option>';
  if (sd && sd !== 'xx') { MAP.regions.filter(r => r.sd === sd).sort((a, b) => a.n.localeCompare(b.n, 'ko')).forEach(r => s.insertAdjacentHTML('beforeend', `<option value="${r.id}">${r.n}</option>`)); }
  s.disabled = !sd || sd === 'xx'; s.value = '';
}
function resetAll() {
  Object.assign(S, {
    q: '', name: '', sido: '', sggs: [], dongs: [], addr: '', tel: '', home: '', hasHome: false,
    ind: [], from: '', to: '', corp: [], fm: '', fav: false, hasMemo: false, memoSt: [],
    ai: 0, aicat: '', cust: [], stat: [], br: [], revB: [], empB: [], prof: false, grow: false, hire: false,
    tags: [], salB: [], outMin: 0, fut: false, netup: false, nip: false, indKw: '',
    leadG: '', cred: '', nozb: false, pat: [], hr: [], rpeMin: 0,
  });
  $('#fAiCat').value = '';
  ['#q', '#fName', '#fAddr', '#fTel', '#fHome', '#fFrom', '#fTo', '#fFm'].forEach(s => $(s).value = '');
  $('#fHasHome').checked = false; $('#fFav').checked = false; $('#fHasMemo').checked = false;
  $('#searchBox').classList.remove('has'); setSido('', ''); clearPreset(); run();
}

/* ==================== Query Engine ==================== */
function run() {
  const q = S.q.toLowerCase(), qn = norm(S.q), qc = isCho(S.q.replace(/\s/g, '')) ? S.q.replace(/\s/g, '') : '', qd = digits(S.q);
  const nm = norm(S.name), nmc = isCho(S.name.replace(/\s/g, '')) ? S.name.replace(/\s/g, '') : '';
  const ads = S.addr.split(/[,，]/).map(x => x.replace(/\s+/g, '').toLowerCase()).filter(Boolean), tel = digits(S.tel), hm = S.home.toLowerCase();
  const ind = S.ind.length ? new Set(S.ind) : null, corp = S.corp.length ? new Set(S.corp) : null;
  const from = S.from ? +S.from.replace(/-/g, '') : 0, to = S.to ? +S.to.replace(/-/g, '') : 0;
  const sdIdx = S.sido && S.sido !== 'xx' ? META.sido.findIndex(s => s.sd === S.sido) : -2;
  let indKwM = null;
  if (S.indKw) {
    const ks = S.indKw.split(',').map(x => x.replace(/\s/g, '')).filter(Boolean);
    indKwM = new Uint8Array(META.industries.length);
    META.industries.forEach((n, k) => { const nn = n.replace(/\s/g, ''); if (ks.some(x => nn.includes(x))) indKwM[k] = 1; });
  }
  const custSet = S.cust.length ? new Set(S.cust) : null;
  const statSet = S.stat.length ? new Set(S.stat) : null;
  const brSet = S.br.length ? new Set(S.br) : null;
  const memoSet = S.memoSt.length ? new Set(S.memoSt) : null;
  const fm = S.fm ? +S.fm : 0, aicat = S.aicat === '' ? -1 : +S.aicat;
  const dongSet = S.dongs.length ? new Set(S.dongs) : null, dongRid = new Set(S.dongs.map(d => META.dongs[d][0]));
  const sggOnly = new Set(S.sggs.filter(r => !dongRid.has(r)));
  const regionOn = !!(dongSet || sggOnly.size);
  const out = [], score = [];

  for (let i = 0; i < N; i++) {
    const r = ROWS[i];
    if (corp && !corp.has(r[5])) continue;
    if (ind && !ind.has(r[12])) continue;
    if (regionOn) { if (!((dongSet && dongSet.has(r[17])) || sggOnly.has(r[15]))) continue; }
    else if (S.sido === 'xx') { if (r[15] >= 0) continue; }
    else if (sdIdx >= 0 && r[16] !== sdIdx) continue;
    if (fm && r[14] !== fm) continue;
    if (from && (!r[13] || r[13] < from)) continue;
    if (to && (!r[13] || r[13] > to)) continue;
    if (S.hasHome && !r[10]) continue;
    if (S.fav && !FAV.has(r[6])) continue;
    if (S.hasMemo || memoSet) {
      const m = memoOf(i);
      if (S.hasMemo && (!m || (!m.text && !m.stage))) continue;
      if (memoSet && (!m || !memoSet.has(m.stage))) continue;
    }
    if (S.ai && AI_S[i] < S.ai) continue;
    if (custSet && !custSet.has(CUST ? CUST[i] : 0)) continue;
    if (statSet && !statSet.has(STAT ? STAT[i] : 0)) continue;
    if (S.revB.length) { const v = revEok(i); if (!(v === v) || !S.revB.some(k => v >= REV_B[k][1] && v < REV_B[k][2])) continue; }
    if (S.empB.length) { const v = empOf(i); if (!(v === v) || !S.empB.some(k => v >= EMP_B[k][1] && v < EMP_B[k][2])) continue; }
    if (S.prof && !(EN && EN.op[i] > 0)) continue;
    if (S.grow && !(revGrowth(i) > 0)) continue;
    if (S.hire && !hiring(i)) continue;
    if (S.salB.length) { const v = SAL ? SAL[i] : NaN; if (!(v === v) || !S.salB.some(k => v >= SAL_B[k][1] && v < SAL_B[k][2])) continue; }
    if (S.outMin && !(OUT && OUT[i] >= S.outMin)) continue;
    if (S.fut && !(FUT && FUT[i])) continue;
    if (S.netup && !(NET && NET[i] > 0)) continue;
    if (S.nip && !(EN && EN.ni[i] > 0)) continue;
    if (S.leadG) { const minL = S.leadG === 'S' ? 80 : S.leadG === 'A' ? 70 : 60; if (!(LEAD && LEAD[i] >= minL)) continue; }
    if (S.cred) { const cg = CRED_G ? CRED_G[i] : 0; if (!cg) continue; if (S.cred === 'hi' && cg > 3) continue; if (S.cred === 'mid' && (cg < 4 || cg > 5)) continue; if (S.cred === 'lo' && cg < 6) continue; }
    if (S.nozb && ZOMBIE && ZOMBIE[i]) continue;
    if (S.pat.length) {
      let okP = true;
      for (const pk of S.pat) {
        if (pk === 'r40' && !(RULE40 && ok(RULE40[i]) && RULE40[i] >= 40)) { okP = false; break; }
        if (pk === 'cagr20' && !(CAGR && ok(CAGR[i]) && CAGR[i] >= 20)) { okP = false; break; }
        if (pk === 'grow2' && !(PAT && (PAT[i] & 1))) { okP = false; break; }
        if (pk === 'prof3' && !(PAT && (PAT[i] & 2))) { okP = false; break; }
        if (pk === 'slump' && !(PAT && (PAT[i] & 8))) { okP = false; break; }
      }
      if (!okP) continue;
    }
    if (S.hr.length && !(HR_REG && S.hr.includes(HR_REG[i]))) continue;
    if (S.rpeMin && !(RPE && ok(RPE[i]) && RPE[i] >= S.rpeMin)) continue;
    if (indKwM && !indKwM[r[12]]) continue;
    if (S.tags.length && !(TAGM && S.tags.some(k => TAGM[i] & (1 << k)))) continue;
    if (brSet) { const rr = r[15]; if (!brSet.has(rr >= 0 && RID_BR ? RID_BR[rr] : -1)) continue; }
    if (aicat >= 0 && AI_C[i] !== aicat) continue;
    if (nm) { if (nmc ? !NAMEC[i].includes(nmc) : !NAMEK[i].includes(nm)) continue; }
    if (ads.length) { let hit = false; for (const a of ads) if (ADDRK[i].includes(a)) { hit = true; break; } if (!hit) continue; }
    if (tel && !TELD[i].includes(tel)) continue;
    if (hm && !HOMEK[i].includes(hm)) continue;

    let sc = 0;
    if (q) {
      if (qc) { const k = NAMEC[i].indexOf(qc); if (k < 0) continue; sc = k === 0 ? (NAMEC[i].length === qc.length ? 100 : 60) : 30; }
      else {
        const nk = NAMEK[i]; const k = nk.indexOf(qn);
        if (k >= 0) { const base = nk.split('|')[0]; sc = base === qn ? 100 : base.startsWith(qn) ? 80 : k < base.length ? 50 : 35; }
        else if (ALLK[i].includes(qn) || (qd.length >= 4 && ALLK[i].includes(qd))) sc = 20;
        else continue;
      }
      if (r[5] < 3) sc += 5;
    }
    out.push(i); score.push(sc);
  }

  let idx = out.map((_, k) => k);
  const nv = f => (a, b) => { const x = f(out[a]), y = f(out[b]); const X = x === x ? x : -Infinity, Y = y === y ? y : -Infinity; return Y - X; };
  const sorters = {
    lead: nv(i => LEAD ? LEAD[i] : NaN),
    z: nv(i => Z_SCR ? Z_SCR[i] : NaN),
    cagr: nv(i => CAGR ? CAGR[i] : NaN),
    rpe: nv(i => RPE ? RPE[i] : NaN),
    roe: nv(i => RULE40 ? RULE40[i] : NaN),
    pct: nv(i => IND_PCT && IND_PCT[i] ? IND_PCT[i] : NaN),
    out: nv(i => OUT ? OUT[i] : NaN), sal: nv(i => SAL ? SAL[i] : NaN), ni: nv(i => EN ? EN.ni[i] : NaN), net: nv(i => NET ? NET[i] : NaN),
    rev: nv(i => EN ? EN.rev[i] : NaN), op: nv(i => EN ? EN.op[i] : NaN),
    margin: nv(i => { const r = EN ? EN.rev[i] : NaN; return r >= 1e10 ? opMargin(i) : NaN; }),
    growth: nv(i => { const r = EN ? EN.rev[i] : NaN; return r >= 1e9 ? revGrowth(i) : NaN; }),
    emp: nv(empOf), hire: nv(i => EN ? EN.nps_new[i] : NaN),
    ai: (a, b) => AI_S[out[b]] - AI_S[out[a]] || ROWS[out[a]][5] - ROWS[out[b]][5] || (ROWS[out[a]][13] || 99999999) - (ROWS[out[b]][13] || 99999999),
    rel: (a, b) => score[b] - score[a] || ROWS[out[a]][5] - ROWS[out[b]][5] || ROWS[out[a]][0].localeCompare(ROWS[out[b]][0], 'ko'),
    name: (a, b) => ROWS[out[a]][0].localeCompare(ROWS[out[b]][0], 'ko'),
    old: (a, b) => (ROWS[out[a]][13] || 99999999) - (ROWS[out[b]][13] || 99999999),
    new: (a, b) => (ROWS[out[b]][13] || 0) - (ROWS[out[a]][13] || 0),
    listed: (a, b) => ROWS[out[a]][5] - ROWS[out[b]][5] || score[b] - score[a],
  };
  if (S.sort === 'rel' && !q) idx.sort((a, b) => ROWS[out[a]][5] - ROWS[out[b]][5]);
  else if (out.length <= 60000 || S.sort !== 'name') idx.sort(sorters[S.sort]);
  else { const coll = new Intl.Collator('ko'); idx.sort((a, b) => coll.compare(ROWS[out[a]][0], ROWS[out[b]][0])); }

  RES = Int32Array.from(idx, k => out[k]);
  renderActive(); renderList(true); renderMap(); autoFit();
  if ($('#vSales').classList.contains('on')) renderSales();
  if ($('#vEda').classList.contains('on')) renderEda();
  if ($('#vPro').classList.contains('on')) renderPro();
  if (VIEW_STATS_ON()) renderStats(); else STATS_DIRTY = true;
  $('#cnt').textContent = fmt(RES.length);
  const fc = activeCount(); const b = $('#fcount'); b.hidden = !fc; b.textContent = fc;
}

function activeCount() {
  let c = 0;
  for (const k of ['name', 'sido', 'addr', 'tel', 'home', 'fm', 'from', 'to']) if (S[k]) c++;
  if (S.hasHome) c++; if (S.fav) c++; if (S.hasMemo) c++; if (S.ai) c++; if (S.aicat !== '') c++;
  c += S.cust.length + S.stat.length + S.br.length + S.memoSt.length + S.revB.length + S.empB.length + S.tags.length +
    (S.prof ? 1 : 0) + (S.grow ? 1 : 0) + (S.hire ? 1 : 0) + S.salB.length + (S.outMin ? 1 : 0) + (S.fut ? 1 : 0) + (S.netup ? 1 : 0) + (S.nip ? 1 : 0) + (S.indKw ? 1 : 0) +
    (S.leadG ? 1 : 0) + (S.cred ? 1 : 0) + (S.nozb ? 1 : 0) + S.pat.length + S.hr.length + (S.rpeMin ? 1 : 0);
  c += S.ind.length + S.corp.length + S.sggs.length + S.dongs.length;
  return c;
}

function renderActive() {
  const a = []; const add = (lbl, fn) => a.push({ lbl, fn });
  if (S.q) add(`검색: ${S.q}`, () => { S.q = ''; $('#q').value = ''; $('#searchBox').classList.remove('has'); });
  if (S.name) add(`회사명: ${S.name}`, () => { S.name = ''; $('#fName').value = ''; });
  if (S.sido && !S.sggs.length && !S.dongs.length) add(S.sido === 'xx' ? '해외·미분류' : META.sido.find(s => s.sd === S.sido).n, () => setSido('', ''));
  S.sggs.forEach(id => add('📍 ' + regName(id), () => toggleSgg(id)));
  S.dongs.forEach(d => add('🏘 ' + META.dongs[d][1] + ' (' + MAP.regions[META.dongs[d][0]].n + ')', () => { S.dongs = S.dongs.filter(x => x !== d); }));
  if (S.addr) add(`주소: ${S.addr}`, () => { S.addr = ''; $('#fAddr').value = ''; });
  if (S.tel) add(`전화: ${S.tel}`, () => { S.tel = ''; $('#fTel').value = ''; });
  if (S.home) add(`홈페이지: ${S.home}`, () => { S.home = ''; $('#fHome').value = ''; });
  if (S.hasHome) add('홈페이지 보유', () => { S.hasHome = false; $('#fHasHome').checked = false; });
  S.ind.forEach(i => add(META.industries[i], () => { S.ind = S.ind.filter(x => x !== i); }));
  S.corp.forEach(c => add(META.corp[c], () => { S.corp = S.corp.filter(x => x !== c); }));
  if (S.from || S.to) add(`설립 ${S.from || '…'} ~ ${S.to || '…'}`, () => { S.from = S.to = ''; $('#fFrom').value = $('#fTo').value = ''; clearPreset(); });
  if (S.fm) add(`결산 ${S.fm}월`, () => { S.fm = ''; $('#fFm').value = ''; });
  if (S.fav) add('⭐ 즐겨찾기', () => { S.fav = false; $('#fFav').checked = false; });
  if (S.hasMemo) add('📝 메모 보유', () => { S.hasMemo = false; $('#fHasMemo').checked = false; });
  S.memoSt.forEach(v => add('📝 ' + v, () => { S.memoSt = S.memoSt.filter(x => x !== v); }));
  if (S.ai) add(`AI 적합도 ${S.ai}점+`, () => { S.ai = 0; });
  S.revB.forEach(v => add('매출 ' + REV_B[v][0], () => { S.revB = S.revB.filter(x => x !== v); }));
  S.empB.forEach(v => add('직원 ' + EMP_B[v][0], () => { S.empB = S.empB.filter(x => x !== v); }));
  if (S.indKw) add('업종: ' + S.indKw, () => { S.indKw = ''; });
  if (S.fut) add('🌱 미래 강소 후보', () => { S.fut = false; });
  if (S.outMin) add(`전망 ${S.outMin}+`, () => { S.outMin = 0; });
  if (S.netup) add('인원 증가', () => { S.netup = false; });
  if (S.nip) add('순이익 흑자', () => { S.nip = false; });
  S.salB.forEach(v => add('연봉 ' + SAL_B[v][0], () => { S.salB = S.salB.filter(x => x !== v); }));
  if (S.prof) add('흑자', () => { S.prof = false; });
  if (S.grow) add('매출 성장', () => { S.grow = false; });
  if (S.hire) add('채용 활발', () => { S.hire = false; });
  S.tags.forEach(v => add('🏅 ' + (TAGS[v] ? TAGS[v].label : '?'), () => { S.tags = S.tags.filter(x => x !== v); }));
  S.cust.forEach(v => add('고객: ' + CUST_LBL[v], () => { S.cust = S.cust.filter(x => x !== v); }));
  S.stat.forEach(v => add('상태: ' + STAT_LBL[v], () => { S.stat = S.stat.filter(x => x !== v); }));
  S.br.forEach(v => add('지사: ' + (v < 0 ? '관할 외' : BR[v] ? BR[v].name : '?'), () => { S.br = S.br.filter(x => x !== v); }));
  if (S.aicat !== '') add(`AI 분야: ${AICAT[+S.aicat][0]}`, () => { S.aicat = ''; $('#fAiCat').value = ''; });
  if (S.leadG) add(`영업 우선 ${S.leadG}등급+`, () => { S.leadG = ''; });
  if (S.cred) add(`신용: ${S.cred === 'hi' ? '우량(AAA~A)' : S.cred === 'mid' ? '보통(BBB~BB)' : '주의(B~D)'}`, () => { S.cred = ''; });
  if (S.nozb) add('한계기업 제외', () => { S.nozb = false; });
  const patLbl = { r40: '🔥 Rule of 40+', cagr20: '🚀 고성장 20%+', grow2: '⚡ 매출·인원 동반↑', prof3: '💎 고마진 10%+', slump: '⚠ 적자·둔화' };
  S.pat.forEach(p => add(patLbl[p] || p, () => { S.pat = S.pat.filter(x => x !== p); }));
  S.hr.forEach(h => add(HR_LBL[h] || String(h), () => { S.hr = S.hr.filter(x => x !== h); }));
  if (S.rpeMin) add(`1인당 매출 ${S.rpeMin}억+`, () => { S.rpeMin = 0; });

  const el = $('#activeF');
  el.innerHTML = a.map((x, k) => `<button class="chip" data-k="${k}" aria-pressed="true">${esc(x.lbl)} <span class="x">✕</span></button>`).join('') + (a.length > 1 ? '<button class="resetbtn" data-all>모두 해제</button>' : '');
  el.onclick = e => { if (e.target.closest('[data-all]')) { resetAll(); return; } const b = e.target.closest('.chip'); if (!b) return; a[+b.dataset.k].fn(); run(); };

  $$('#aiChips .chip').forEach(b => b.setAttribute('aria-pressed', +b.dataset.s === S.ai));
  $('#fAiCat').value = S.aicat; $('#sort').value = S.sort;
  enrichSyncChips(); anaSync(); proSyncChips();
  $$('#custChips .chip').forEach(b => b.setAttribute('aria-pressed', S.cust.includes(+b.dataset.v)));
  $$('#statChips .chip').forEach(b => b.setAttribute('aria-pressed', S.stat.includes(+b.dataset.v)));
  $$('#brChips .chip').forEach(b => b.setAttribute('aria-pressed', S.br.includes(+b.dataset.v)));
  $$('#memoChips .chip').forEach(b => b.setAttribute('aria-pressed', S.memoSt.includes(b.dataset.ms)));
  $$('#corpChips .chip').forEach(b => b.setAttribute('aria-pressed', S.corp.includes(+b.dataset.c)));
  $('#sggChips').innerHTML = S.sggs.map(id => `<button class="chip" data-r="${id}" aria-pressed="true">${esc(regName(id))} <span class="x">✕</span></button>`).join('');
  $('#dongChips').innerHTML = S.dongs.map(d => `<button class="chip" data-d="${d}" aria-pressed="true">${esc(META.dongs[d][1])} <span class="tiny" style="color:inherit;opacity:.8">${esc(MAP.regions[META.dongs[d][0]].n)}</span> <span class="x">✕</span></button>`).join('');
  $('#indChips').innerHTML = S.ind.map(i => `<button class="chip" data-i="${i}" aria-pressed="true">${esc(META.industries[i])} <span class="x">✕</span></button>`).join('');
}

/* ==================== List & Export ==================== */
const PAGE = 60;
function hl(name) {
  if (!S.q || isCho(S.q.replace(/\s/g, ''))) return esc(name);
  const q = S.q.trim(); const k = name.toLowerCase().indexOf(q.toLowerCase());
  if (k < 0) return esc(name);
  return esc(name.slice(0, k)) + '<mark>' + esc(name.slice(k, k + q.length)) + '</mark>' + esc(name.slice(k + q.length));
}
function memoBadge(i) {
  const m = memoOf(i);
  if (!m || (!m.stage && !m.text)) return '';
  return `<span class="sb s-memo">📝 ${esc(m.stage || '메모')}</span>`;
}
function itemHTML(i) {
  const r = ROWS[i]; const a = age(r[13]);
  const closed = STAT && (STAT[i] === 2 || STAT[i] === 3);
  const inCmp = CMP.includes(i);
  return `<li class="item${i === CUR ? ' on' : ''}${closed ? ' closed' : ''}" data-i="${i}" tabindex="0">
    <div class="nm">${FAV.has(r[6]) ? '⭐ ' : ''}${hl(r[0])}</div>
    <span style="display:flex;gap:4px;align-self:start;align-items:center">
      <button type="button" class="cmp-mini${inCmp ? ' on' : ''}" data-cmp="${i}" title="비교함에 담기 (최대 5개)">${inCmp ? '✓비교' : '+비교'}</button>
      <span class="ai${AI_S[i] >= 70 ? ' hi' : ''}" title="AI 도입 적합도">AI ${AI_S[i]}</span>
      <span class="tag c${r[5]}">${CORP_SHORT[r[5]]}${r[3].trim() ? ' ' + r[3].trim() : ''}</span>
    </span>
    <div class="meta"><span>${esc(META.industries[r[12]])}</span>${S.ai || S.sort === 'ai' || S.aicat !== '' ? `<span style="color:var(--accent)">→ ${esc(AICAT[AI_C[i]][3][0])}</span>` : ''}${r[4] ? `<span>대표 ${esc(r[4].length > 18 ? r[4].slice(0, 18) + '…' : r[4])}</span>` : ''}<span class="num">설립 ${estStr(r[13])}${a !== null ? ` (${a}년)` : ''}</span>${r[8] ? `<span class="num">☎ ${esc(r[8])}</span>` : ''}</div>
    <div class="addr">${esc(r[7] || '주소 정보 없음')}</div>${enrichLine(i)}${anaLine(i)}<div class="sbrow">${proBadges(i)}${memoBadge(i)}${anaBadges(i)}${tagBadges(i)}${salesBadges(i)}</div></li>`;
}
function renderList(reset) {
  const ul = $('#list');
  if (reset) { SHOWN = 0; ul.innerHTML = ''; $('#listScroll').scrollTop = 0; }
  if (!RES.length) {
    ul.innerHTML = `<li class="empty">조건에 맞는 기업이 없습니다.<br><button class="resetbtn" onclick="document.getElementById('resetAll').click()">조건 초기화</button></li>`;
    $('#more').textContent = ''; return;
  }
  const end = Math.min(RES.length, SHOWN + PAGE);
  let h = ''; for (let k = SHOWN; k < end; k++) h += itemHTML(RES[k]);
  ul.insertAdjacentHTML('beforeend', h); SHOWN = end;
  $('#more').textContent = SHOWN < RES.length ? `${fmt(SHOWN)} / ${fmt(RES.length)} · 스크롤하면 더 보기` : `전체 ${fmt(RES.length)}개 표시`;
}
function initList() {
  const io = new IntersectionObserver(es => { if (es[0].isIntersecting && SHOWN < RES.length) renderList(false); }, { root: $('#listScroll'), rootMargin: '600px' });
  io.observe($('#more'));
  $('#list').addEventListener('click', e => {
    const cb = e.target.closest('[data-cmp]');
    if (cb) { e.stopPropagation(); toggleCompare(+cb.dataset.cmp); return; }
    const li = e.target.closest('.item'); if (li) openDetail(+li.dataset.i);
  });
  $('#list').addEventListener('keydown', e => {
    const li = e.target.closest('.item'); if (!li) return;
    if (e.key === 'Enter') openDetail(+li.dataset.i);
    else if (e.key === 'ArrowDown') { li.nextElementSibling && li.nextElementSibling.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { li.previousElementSibling && li.previousElementSibling.focus(); e.preventDefault(); }
  });
}
function exportResults(mode) {
  const lim = Math.min(RES.length, mode === 'csv' ? 50000 : 5000);
  const head = ['회사이름', '영문명', '종목코드', '대표자', '법인구분', '사업자등록번호', '주소', '읍면동', '전화번호', '홈페이지', '업종명', '설립일', '결산월', 'AI적합도', 'AI분야', '추천활용', '담당지사', '고객구분', '사업자상태', '매출액(억)', '영업이익(억)', '순이익(억)', '직원수', '최근입사', '인증·선정', '평균연봉(만)', '연봉추정', '전망점수', '미래강소후보', '월입사율%', '인원순증', '영업우선순위', '신용등급', '안전도(Z)', '매출성장%', 'RuleOf40', '1인당매출(억)', 'HR활력', '업종백분위%', '메모단계', '영업메모'];
  const rowsOut = [head];
  for (let k = 0; k < lim; k++) {
    const i = RES[k], r = ROWS[i], m = memoOf(i);
    const e = x => EN && EN[x][i] === EN[x][i] ? Math.round(EN[x][i] / 1e8 * 10) / 10 : '';
    const em = empOf(i);
    rowsOut.push([
      r[0], r[1], r[3].trim(), r[4], META.corp[r[5]], r[6], r[7], r[17] >= 0 ? META.dongs[r[17]][1] : '',
      r[8], r[10], META.industries[r[12]], estStr(r[13]), r[14] || '', AI_S[i], AICAT[AI_C[i]][0], AICAT[AI_C[i]][3][0],
      rowBr(i) >= 0 ? BR[rowBr(i)].name : '', CUST ? CUST_LBL[CUST[i]] : '', STAT ? STAT_LBL[STAT[i]] : '',
      e('rev'), e('op'), e('ni'), em === em ? Math.round(em) : '', EN && ok(EN.nps_new[i]) ? EN.nps_new[i] : '',
      TAGM && TAGM[i] ? TAGS.filter((_, t) => TAGM[i] & (1 << t)).map(t => t.label).join('/') : '',
      ok(SAL[i]) ? Math.round(SAL[i] / 1e4) : '', SAL_EST[i] ? '추정' : '', ok(OUT[i]) ? OUT[i] : '', FUT[i] ? 'Y' : '',
      ok(HIRE_R[i]) ? HIRE_R[i].toFixed(1) : '', ok(NET[i]) ? NET[i] : '',
      LEAD ? LEAD[i] : '', CRED_G && CRED_G[i] ? CRED_LBL[CRED_G[i]] : '', Z_SCR && ok(Z_SCR[i]) ? Math.round(Z_SCR[i]) : '',
      CAGR && ok(CAGR[i]) ? CAGR[i].toFixed(1) : '', RULE40 && ok(RULE40[i]) ? RULE40[i].toFixed(1) : '',
      RPE && ok(RPE[i]) ? RPE[i].toFixed(2) : '', HR_REG && HR_REG[i] ? HR_LBL[HR_REG[i]] : '',
      IND_PCT && IND_PCT[i] ? IND_PCT[i] : '',
      m ? (m.stage || '') : '', m ? (m.text || '') : '',
    ].map(v => String(v).replace(/\t|\r|\n/g, ' ')));
  }
  if (mode === 'csv') {
    const csv = '\uFEFF' + rowsOut.map(cols => cols.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `기업분석_${todayStr()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`${fmt(lim)}건 CSV 저장` + (RES.length > lim ? ` (전체 ${fmt(RES.length)}건 중 앞부분)` : ''));
  } else {
    copy(rowsOut.map(c => c.join('\t')).join('\n'), `${fmt(lim)}건을 표 형식으로 복사했습니다 (엑셀 붙여넣기)`);
  }
}

/* ==================== Map ==================== */
const NS = 'http://www.w3.org/2000/svg';
let VB, VB0, REG_EL = [], REG_CNT, LABELS, PIN;
function initMap() {
  const svg = $('#map'); VB0 = [-20, -20, MAP.w + 40, MAP.h + 40]; VB = [...VB0];
  const g = document.createElementNS(NS, 'g'); g.id = 'mg'; svg.appendChild(g);
  MAP.regions.forEach(r => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', r.d); p.setAttribute('class', 'rg'); p.dataset.id = r.id; g.appendChild(p); REG_EL[r.id] = p; });
  const sg = document.createElementNS(NS, 'g'); MAP.sidos.forEach(s => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', s.d); p.setAttribute('class', 'sdl'); sg.appendChild(p); }); g.appendChild(sg);
  LABELS = document.createElementNS(NS, 'g'); g.appendChild(LABELS);
  PIN = document.createElementNS(NS, 'g'); g.appendChild(PIN);
  applyVB();
  $('#sdbar').innerHTML = '<button data-sd="" class="on">전국</button>' + MAP.sidos.map(s => `<button data-sd="${s.sd}">${s.s}</button>`).join('');
  $('#sdbar').onclick = e => { const b = e.target.closest('button'); if (!b) return; const sd = b.dataset.sd; setSido(sd, ''); run(); zoomToSido(sd); };

  const wrap = $('#mapwrap'), tip = $('#tip');
  const pts = new Map(); let drag = null, moved = false, pinch = null;
  const toSvg = (cx, cy) => {
    const rc = svg.getBoundingClientRect(); const s = Math.max(VB[2] / rc.width, VB[3] / rc.height);
    const ox = (rc.width * s - VB[2]) / 2, oy = (rc.height * s - VB[3]) / 2;
    return [VB[0] - ox + (cx - rc.left) * s, VB[1] - oy + (cy - rc.top) * s, s];
  };
  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = false;
    if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, vb: [...VB] };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), vb: [...VB], c: toSvg((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) }; drag = null; }
  });
  svg.addEventListener('pointermove', e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoomAt(pinch.c[0], pinch.c[1], pinch.d / d, pinch.vb); moved = true; return; }
    if (drag) {
      const [, , s] = toSvg(0, 0); const dx = (e.clientX - drag.x) * s, dy = (e.clientY - drag.y) * s;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) moved = true;
      if (moved) { VB = [drag.vb[0] - dx, drag.vb[1] - dy, drag.vb[2], drag.vb[3]]; applyVB(); tip.style.display = 'none'; }
      return;
    }
    const t = e.target.closest('.rg'); if (t && e.pointerType === 'mouse') showTip(+t.dataset.id, e); else tip.style.display = 'none';
  });
  const end = e => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (!moved) {
        const t = document.elementFromPoint(e.clientX, e.clientY); const rg = t && t.closest && t.closest('.rg');
        if (rg) { const id = +rg.dataset.id; if (e.pointerType !== 'mouse') showTip(id, e); selectRegion(id); }
      }
      drag = null;
    }
  };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  svg.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = toSvg(e.clientX, e.clientY); zoomAt(x, y, Math.exp(e.deltaY * 0.0015), VB); }, { passive: false });
  $('#zin').onclick = () => zoomAt(VB[0] + VB[2] / 2, VB[1] + VB[3] / 2, 0.66, VB);
  $('#zout').onclick = () => zoomAt(VB[0] + VB[2] / 2, VB[1] + VB[3] / 2, 1.5, VB);
  $('#zreset').onclick = () => animVB(VB0);
  function showTip(id, e) {
    const r = MAP.regions[id], sd = MAP.sidos.find(s => s.sd === r.sd), rc = wrap.getBoundingClientRect();
    tip.innerHTML = `<b>${sd.s} ${esc(r.n)}</b><br>${fmt(REG_CNT[id])}개 기업 <span style="opacity:.7">· 클릭 시 필터</span>`;
    tip.style.left = (e.clientX - rc.left) + 'px'; tip.style.top = (e.clientY - rc.top) + 'px'; tip.style.display = 'block';
    if (e.pointerType !== 'mouse') { clearTimeout(showTip.t); showTip.t = setTimeout(() => tip.style.display = 'none', 1800); }
  }
}
function selectRegion(id) {
  AUTOFIT_SKIP = true;
  if (ASSIGN >= 0) { assignRegion(ASSIGN, id).then(() => toast(`${BR[ASSIGN].name}: ${regName(id)} ${RID_BR[id] === ASSIGN ? '추가' : '해제'}`)); return; }
  toggleSgg(id); run(); toast(`${S.sggs.includes(id) ? '추가' : '해제'}: ${regName(id)} · ${fmt(RES.length)}개`);
}
function zoomAt(x, y, k, base) { ANIM++; const w = Math.min(VB0[2] * 1.2, Math.max(40, base[2] * k)); const kk = w / base[2]; const h = base[3] * kk; VB = [x - (x - base[0]) * kk, y - (y - base[1]) * kk, w, h]; applyVB(); }
function applyVB() { if (!(VB[2] > 0 && VB[3] > 0)) VB = [...VB0]; $('#map').setAttribute('viewBox', VB.join(' ')); renderLabels(); }
window.addEventListener('resize', debounce(() => renderLabels(), 150));
let ANIM = 0;
function animVB(to) {
  const tok = ++ANIM, from = [...VB], t0 = performance.now();
  const step = t => { if (tok !== ANIM) return; const p = Math.min(1, (t - t0) / 380), e = 1 - Math.pow(1 - p, 3); VB = from.map((v, i) => v + (to[i] - v) * e); applyVB(); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function zoomToBox(b, pad) { const w = b[2] - b[0], h = b[3] - b[1]; const p = Math.max(w, h, 60) * (pad || .15) + 10; animVB([b[0] - p, b[1] - p, w + 2 * p, h + 2 * p]); }
function zoomToSido(sd) { $$('#sdbar button').forEach(b => b.classList.toggle('on', b.dataset.sd === sd)); if (!sd) { animVB(VB0); return; } const s = MAP.sidos.find(x => x.sd === sd); if (s) zoomToBox(s.b); }
function syncMainMapMode() {
  const isPrec = MAPMODE === 'precision';
  const wrap = $('#mapwrap');
  const box = $('#vwMainMap');
  if (wrap) wrap.classList.toggle('precision-on', isPrec);
  if (box) box.hidden = !isPrec;
  if (isPrec && box && window.VWorldTwin) {
    if (!VW_MAIN) {
      VW_MAIN = window.VWorldTwin.createMainMap(box, {
        store,
        getMeta: () => META,
        getItems: lim => [...RES.slice(0, lim)].map(i => {
          const sc = LEAD ? LEAD[i] : (AI_S ? AI_S[i] : 50);
          const gr = LEAD ? leadGrade(sc)[0] : (sc >= 80 ? 'S' : sc >= 70 ? 'A' : sc >= 60 ? 'B' : 'C');
          return {
            id: i,
            name: ROWS[i][0],
            addr: ROWS[i][7],
            sub: `${META.corp[ROWS[i][5]]} · ${META.industries[ROWS[i][12]]}`,
            color: ['#2563eb', '#059669', '#d97706', '#6366f1'][ROWS[i][5]] || '#2563eb',
            grade: gr,
            score: sc,
          };
        }),
        onOpenItem: idx => openDetail(idx),
        toast,
        itemLabel: '기업',
      });
    }
    VW_MAIN.show();
  }
}
function renderMap() {
  REG_CNT = new Int32Array(MAP.regions.length);
  for (let k = 0; k < RES.length; k++) { const r = ROWS[RES[k]][15]; if (r >= 0) REG_CNT[r]++; }
  const nz = [...REG_CNT].filter(v => v > 0).sort((a, b) => a - b);
  const nice = v => { if (v < 10) return Math.max(1, Math.round(v)); const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.round(v / p * 2) / 2 * p; };
  let th = []; if (nz.length) { for (const q of [.2, .4, .6, .75, .88, .96]) th.push(nice(nz[Math.min(nz.length - 1, Math.floor(q * nz.length))])); }
  th = [...new Set(th)].filter(v => v > 1).sort((a, b) => a - b);
  const cls = v => { if (!v) return 0; let c = 1; for (const t of th) if (v >= t) c++; return c; };
  const cols = ['var(--zero)', 'var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)'];
  $$('#mapMode button').forEach(b => b.classList.toggle('on', b.dataset.m === MAPMODE));
  syncMainMapMode();
  if (MAPMODE === 'precision') {
    $('#assignBar').hidden = true;
    $('#mapCap').textContent = `브이월드 일반 정밀지도 · 조회 ${fmt(RES.length)}개 (도로·건물·지적·공시지가)`;
    return;
  }
  if (MAPMODE === 'branch') { paintBranch(); $('#mapCap').textContent = `지사 관할 보기 · 조회 ${fmt(RES.length)}개`; renderLabels(); return; }
  $('#assignBar').hidden = true;
  REG_EL.forEach((p, id) => { p.style.fillOpacity = 1; p.style.fill = cols[cls(REG_CNT[id])]; p.classList.toggle('selr', S.sggs.includes(id) || S.dongs.some(d => META.dongs[d][0] === id)); });
  const lab = ['1'].concat(th.map(fmt));
  $('#legend').innerHTML = `<div class="ttl">기업 수 (시군구)</div><div class="sw"><i style="background:var(--zero)"></i>${th.concat([0]).map((_, k) => `<i style="background:${cols[k + 1]}"></i>`).join('')}</div><div class="lb"><span>0</span>${lab.map(l => `<span>${l}+</span>`).join('')}</div>`;
  const outside = RES.length - REG_CNT.reduce((a, b) => a + b, 0);
  $('#mapCap').textContent = `조회 ${fmt(RES.length)}개 중 지도 표시 ${fmt(RES.length - outside)}개` + (outside ? ` · 해외/미분류 ${fmt(outside)}` : '');
  $$('#sdbar button').forEach(b => b.classList.toggle('on', b.dataset.sd === (S.sido === 'xx' ? '' : S.sido)));
  renderLabels();
}
function renderLabels() {
  if (!LABELS || !REG_CNT) return;
  const z = VB0[2] / VB[2]; let h = '';
  const rc = $('#map').getBoundingClientRect(); if (!rc.width) { LABELS.innerHTML = ''; return; }
  const upx = Math.max(VB[2] / rc.width, VB[3] / rc.height); const fs = upx * 17; LABELS.style.strokeWidth = (upx * 3) + 'px';
  if (MAPMODE === 'branch' && z < 2.6) { LABELS.innerHTML = branchLabels(fs); return; }
  if (z < 2.2) {
    MAP.sidos.forEach(s => {
      let c = 0; MAP.regions.forEach(r => { if (r.sd === s.sd) c += REG_CNT[r.id]; });
      h += `<text class="mlabel" x="${s.c[0]}" y="${s.c[1]}" style="font-size:${fs * .62}px">${s.s}<tspan x="${s.c[0]}" dy="${fs * .72}" style="font-weight:600;font-size:${fs * .5}px">${fmt(c)}</tspan></text>`;
    });
  } else {
    const [x0, y0, w, hh] = VB;
    MAP.regions.forEach(r => {
      if (r.c[0] < x0 || r.c[0] > x0 + w || r.c[1] < y0 || r.c[1] > y0 + hh) return;
      const bw = r.b[2] - r.b[0]; if (bw < upx * 40) return;
      const nm = esc(r.n.replace(/특별자치시$/, ''));
      h += REG_CNT[r.id] ? `<text class="mlabel" x="${r.c[0]}" y="${r.c[1]}" style="font-size:${fs * .62}px">${nm}<tspan x="${r.c[0]}" dy="${fs * .7}" style="font-weight:600;font-size:${fs * .55}px">${fmt(REG_CNT[r.id])}</tspan></text>`
        : `<text class="mlabel" x="${r.c[0]}" y="${r.c[1]}" style="font-size:${fs * .5}px;font-weight:500;opacity:.55">${nm}</text>`;
    });
  }
  LABELS.innerHTML = h;
}
let LASTFIT = '', AUTOFIT_SKIP = false;
function autoFit() {
  if (AUTOFIT_SKIP) { AUTOFIT_SKIP = false; return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, c = 0;
  REG_CNT.forEach((v, id) => { if (!v) return; c++; const b = MAP.regions[id].b; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
  const key = c ? [x0, y0, x1, y1].join() : 'none'; if (key === LASTFIT) return; LASTFIT = key;
  if (!c || c >= MAP.regions.length * 0.6) { animVB(VB0); return; }
  zoomToBox([x0, y0, x1, y1], c === 1 ? .9 : .15);
}
function setPin(i) {
  PIN.innerHTML = ''; if (i < 0) return; const r = ROWS[i]; if (r[15] < 0) return;
  const c = MAP.regions[r[15]].c; const rad = VB[2] / 110;
  PIN.innerHTML = `<circle class="pinring" cx="${c[0]}" cy="${c[1]}" r="${rad * 1.4}"/><circle class="pin" cx="${c[0]}" cy="${c[1]}" r="${rad}"/>`;
}

/* ==================== Stats ==================== */
let STATS_DIRTY = true;
const VIEW_STATS_ON = () => $('#vStats').classList.contains('on');
function renderStats() {
  STATS_DIRTY = false; const n = RES.length; const el = $('#stats');
  if (!n) { el.innerHTML = '<div class="card empty">조회 결과가 없습니다</div>'; return; }
  const corp = [0, 0, 0, 0], ind = new Map(), sd = new Map(), dec = new Map();
  let ageSum = 0, ageN = 0, home = 0, newer = 0;
  const y0 = Math.floor(TODAY / 10000);
  for (let k = 0; k < n; k++) {
    const r = ROWS[RES[k]]; corp[r[5]]++; ind.set(r[12], (ind.get(r[12]) || 0) + 1); sd.set(r[16], (sd.get(r[16]) || 0) + 1);
    if (r[13]) { const a = (TODAY - r[13]) / 10000; ageSum += a; ageN++; const y = Math.floor(r[13] / 10000); const b = Math.max(1950, Math.floor(y / 5) * 5); dec.set(b, (dec.get(b) || 0) + 1); if (y >= y0 - 3) newer++; }
    if (r[10]) home++;
  }
  const listed = corp[0] + corp[1] + corp[2];
  const pct = v => n ? (v / n * 100).toFixed(1) + '%' : '-';
  let h = `<div class="kpi"><div class="k">조회 기업</div><div class="v num">${fmt(n)}</div><div class="s">전체 ${fmt(N)}개 중 ${(n / N * 100).toFixed(1)}%</div></div>
  <div class="kpi"><div class="k">상장사</div><div class="v num">${fmt(listed)}</div><div class="s">${pct(listed)} · 코스피 ${fmt(corp[0])} / 코스닥 ${fmt(corp[1])}</div></div>
  <div class="kpi"><div class="k">평균 업력</div><div class="v num">${ageN ? (ageSum / ageN).toFixed(1) : '-'}<small style="font-size:14px">년</small></div><div class="s">최근 3년 내 설립 ${fmt(newer)}개</div></div>
  <div class="kpi"><div class="k">홈페이지 보유</div><div class="v num">${pct(home)}</div><div class="s">${fmt(home)}개 기업</div></div>`;
  h += enrichStats(n);
  h += `<div class="card"><h3>법인구분 구성</h3><div class="sub">막대를 누르면 해당 구분으로 필터</div><div class="stack">${corp.map((v, i) => v ? `<i data-corp="${i}" title="${META.corp[i]} ${fmt(v)}" style="flex:${v};background:${CORP_COLOR[i]};cursor:pointer"></i>` : '').join('')}</div>
    <div class="lg">${corp.map((v, i) => `<span><span class="dot" style="background:${CORP_COLOR[i]}"></span>${META.corp[i]} <b class="num">${fmt(v)}</b></span>`).join('')}</div></div>`;
  const top = [...ind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12); const mx = top.length ? top[0][1] : 1;
  {
    const ac = new Map(), hi = new Map(); let h70 = 0;
    for (let k = 0; k < n; k++) { const j = RES[k]; const c = AI_C[j]; ac.set(c, (ac.get(c) || 0) + 1); if (AI_S[j] >= 70) { hi.set(c, (hi.get(c) || 0) + 1); h70++; } }
    const ar = [...hi.entries()].sort((a, b) => b[1] - a[1]); const m5 = ar.length ? ar[0][1] : 1;
    h += `<div class="card"><h3>AI 도입 유망(70점+) 분야별</h3><div class="sub">조회 결과 중 ${fmt(h70)}개(${(h70 / n * 100).toFixed(1)}%) · 누르면 해당 분야 + 70점+ 필터</div>${ar.length ? `<div class="hbar">${ar.map(([c, v]) => `<div class="r" data-aicat="${c}" title="${AICAT[c][0]}: ${fmt(v)}개"><span class="l">${AICAT[c][0]}</span><span class="t"><i style="width:${v / m5 * 100}%"></i></span><span class="n">${fmt(v)}</span></div>`).join('')}</div>` : '<div class="tiny">70점 이상 기업이 없습니다</div>'}</div>`;
  }
  h += `<div class="card"><h3>업종 TOP ${top.length}</h3><div class="sub">조회 결과 내 기업 수 · 누르면 업종 필터 추가</div><div class="hbar">${top.map(([i, v]) => `<div class="r" data-ind="${i}" title="${esc(META.industries[i])}: ${fmt(v)}개"><span class="l">${esc(META.industries[i])}</span><span class="t"><i style="width:${v / mx * 100}%"></i></span><span class="n">${fmt(v)}</span></div>`).join('')}</div></div>`;
  const sds = [...sd.entries()].filter(([k]) => k >= 0).sort((a, b) => b[1] - a[1]); const mx2 = sds.length ? sds[0][1] : 1; const unk = sd.get(-1) || 0;
  h += `<div class="card"><h3>시·도별 분포</h3><div class="sub">누르면 해당 지역으로 필터 · 지도와 연동${unk ? ` · 해외/미분류 ${fmt(unk)}개` : ''}</div><div class="hbar">${sds.map(([k, v]) => `<div class="r" data-sd="${META.sido[k].sd}" title="${META.sido[k].n}: ${fmt(v)}개"><span class="l">${META.sido[k].n}</span><span class="t"><i style="width:${v / mx2 * 100}%"></i></span><span class="n">${fmt(v)}</span></div>`).join('')}</div></div>`;
  if (S.sggs.length || S.dongs.length || (S.sido && S.sido !== 'xx')) {
    const dc = new Map(); for (let k = 0; k < n; k++) { const d = ROWS[RES[k]][17]; if (d >= 0) dc.set(d, (dc.get(d) || 0) + 1); }
    const td = [...dc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15); const m4 = td.length ? td[0][1] : 1;
    if (td.length) h += `<div class="card"><h3>읍·면·동별 분포 TOP ${td.length}</h3><div class="sub">선택 지역 내 · 누르면 해당 동 조건 추가</div><div class="hbar">${td.map(([d, v]) => `<div class="r" data-dong="${d}" title="${esc(META.dongs[d][1])}: ${fmt(v)}개"><span class="l">${esc(META.dongs[d][1])} <span class="tiny">${esc(MAP.regions[META.dongs[d][0]].n)}</span></span><span class="t"><i style="width:${v / m4 * 100}%"></i></span><span class="n">${fmt(v)}</span></div>`).join('')}</div></div>`;
  }
  const ys = [...dec.keys()];
  if (ys.length) {
    const minY = Math.min(...ys), maxY = Math.floor(y0 / 5) * 5; const arr = [];
    for (let y = minY; y <= maxY; y += 5) arr.push([y, dec.get(y) || 0]);
    const mx3 = Math.max(...arr.map(a => a[1])) || 1;
    h += `<div class="card"><h3>설립연도 분포 (5년 단위)</h3><div class="sub">막대를 누르면 해당 기간으로 설립일 필터</div>
    <div class="hist">${arr.map(([y, v]) => `<div data-y="${y}" style="height:${Math.max(.5, v / mx3 * 100)}%" title="${y === 1950 && minY === 1950 ? '~1954' : y + '~' + (y + 4)}년: ${fmt(v)}개"></div>`).join('')}</div>
    <div class="hist-x"><span>${minY === 1950 ? '~' : ''}${minY}</span><span>${Math.round((minY + maxY) / 2 / 5) * 5}</span><span>${maxY}~</span></div></div>`;
  }
  el.innerHTML = h;
}
function initStats() {
  $('#stats').addEventListener('click', e => {
    const t = e.target.closest('[data-ind],[data-sd],[data-y],[data-corp],[data-dong],[data-aicat],[data-revb],[data-empb]'); if (!t) return;
    if (t.dataset.revb !== undefined) { const v = +t.dataset.revb; if (!S.revB.includes(v)) S.revB.push(v); }
    else if (t.dataset.empb !== undefined) { const v = +t.dataset.empb; if (!S.empB.includes(v)) S.empB.push(v); }
    else if (t.dataset.aicat) { S.aicat = t.dataset.aicat; S.ai = 70; S.sort = 'ai'; }
    else if (t.dataset.dong) { const d = +t.dataset.dong; if (!S.dongs.includes(d)) S.dongs.push(d); }
    else if (t.dataset.ind) { const i = +t.dataset.ind; if (!S.ind.includes(i)) S.ind.push(i); }
    else if (t.dataset.sd) { setSido(t.dataset.sd, ''); zoomToSido(t.dataset.sd); }
    else if (t.dataset.corp) { S.corp = [+t.dataset.corp]; }
    else if (t.dataset.y) { const y = +t.dataset.y; S.from = y === 1950 ? '' : `${y}-01-01`; S.to = `${y + 4}-12-31`; $('#fFrom').value = S.from; $('#fTo').value = S.to; clearPreset(); }
    run(); toast(`조건 적용 · ${fmt(RES.length)}개`);
  });
}

/* ==================== Detail Sheet + CRM Memo ==================== */
function memoSection(i) {
  const bno = digits(ROWS[i][6]);
  const m = MEMOS[bno] || { stage: '', text: '', updated: '' };
  return `<div class="sec"><h4>📝 내 영업 메모 <span class="tiny">${m.updated ? '수정 ' + esc(m.updated) : '로컬 저장'}</span></h4><div class="sales">
    <div class="memo-stages" id="memoStBar">${MEMO_STAGES.map(st => `<button type="button" class="chip" data-mst="${st}" aria-pressed="${m.stage === st}">${st}</button>`).join('')}</div>
    <textarea class="memo-txt" id="memoTxt" placeholder="방문 일정, 담당자 연락처, 제안 내용 등을 기록하세요…">${esc(m.text || '')}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button type="button" class="iconbtn sm" id="memoSave" style="background:var(--accent);color:#fff;border-color:var(--accent);flex:1">메모 저장</button>
      ${m.stage || m.text ? '<button type="button" class="iconbtn sm" id="memoDel">삭제</button>' : ''}
    </div>
  </div></div>`;
}
function bindMemoUI(i) {
  const bno = digits(ROWS[i][6]);
  let selStage = (MEMOS[bno] && MEMOS[bno].stage) || '';
  $('#memoStBar')?.addEventListener('click', e => {
    const b = e.target.closest('[data-mst]'); if (!b) return;
    selStage = selStage === b.dataset.mst ? '' : b.dataset.mst;
    $$('#memoStBar .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.mst === selStage));
  });
  $('#memoSave')?.addEventListener('click', () => {
    const text = $('#memoTxt').value.trim();
    if (!selStage && !text) { delete MEMOS[bno]; }
    else { MEMOS[bno] = { stage: selStage, text, updated: new Date().toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }; }
    store.set('memos', MEMOS);
    toast('영업 메모를 저장했습니다');
    const li = $(`#list .item[data-i="${i}"]`); if (li) li.outerHTML = itemHTML(i);
    openDetail(i);
  });
  $('#memoDel')?.addEventListener('click', () => {
    delete MEMOS[bno]; store.set('memos', MEMOS); toast('메모를 삭제했습니다');
    const li = $(`#list .item[data-i="${i}"]`); if (li) li.outerHTML = itemHTML(i);
    openDetail(i);
  });
}

function openDetail(i) {
  CUR = i; const r = ROWS[i]; const reg = r[15] >= 0 ? MAP.regions[r[15]] : null; const a = age(r[13]);
  $$('#list .item.on').forEach(x => x.classList.remove('on'));
  const li = $(`#list .item[data-i="${i}"]`); li && li.classList.add('on');
  const stock = r[3].trim(), tel = r[8], home = homeUrl(r[10]), addr = r[7];
  const q = encodeURIComponent;
  const naverMap = `https://map.naver.com/p/search/${q(addr || r[0])}`, kakaoMap = `https://map.kakao.com/?q=${q(addr || r[0])}`;
  const peers = []; for (let k = 0; k < N && peers.length < 6; k++) { const x = ROWS[k]; if (k !== i && x[12] === r[12] && x[15] === r[15] && r[15] >= 0) peers.push(k); }
  const row = (k, v, cp) => v ? `<dt>${k}</dt><dd><span>${v}</span>${cp ? `<button class="cp" data-cp="${esc(cp)}">복사</button>` : ''}</dd>` : '';

  $('#dbody').innerHTML = `
  <div class="dh"><div style="flex:1;min-width:0"><h2>${esc(r[0])}</h2>${r[1] ? `<div class="en">${esc(r[1])}</div>` : ''}
    <div class="tags"><span class="tag c${r[5]}">${META.corp[r[5]]}${stock ? ' · ' + stock : ''}</span><span class="tag c3">${esc(META.industries[r[12]])}</span>${a !== null ? `<span class="tag c3">업력 ${a}년</span>` : ''}</div></div>
    <button class="fav${FAV.has(r[6]) ? ' on' : ''}" id="dfav" aria-label="즐겨찾기">${FAV.has(r[6]) ? '★' : '☆'}</button>
    <button class="close" id="dclose" aria-label="닫기">✕</button></div>
  <div class="db">
    <div class="actions">
      <a href="${tel ? 'tel:' + digits(tel) : '#'}" class="${tel ? '' : 'dis'}"><span class="ico">📞</span>전화</a>
      <a href="${home || '#'}" target="_blank" rel="noopener" class="${home ? '' : 'dis'}"><span class="ico">🌐</span>홈페이지</a>
      <a href="${naverMap}" target="_blank" rel="noopener"><span class="ico">📍</span>네이버지도</a>
      <a href="${kakaoMap}" target="_blank" rel="noopener"><span class="ico">🗺</span>카카오맵</a>
    </div>
    <div style="display:flex;gap:8px;margin:8px 0 4px">
      <button type="button" class="iconbtn sm" id="dCmpBtn" style="flex:1">${CMP.includes(i) ? '✓ 비교함에 담김' : '⚖️ 비교함에 담기'}</button>
      <button type="button" class="iconbtn sm" id="dBriefBtn" style="flex:1">📄 1페이지 브리핑</button>
    </div>
    <dl class="kv">
      ${row('대표자', esc(r[4]))}
      ${row('주소', esc(addr), addr)}
      ${r[17] >= 0 ? `<dt>읍·면·동</dt><dd><span>${esc(META.dongs[r[17]][1])}</span><button class="cp" id="ddong" style="color:var(--accent)">이 동 기업 보기</button></dd>` : ''}
      ${row('전화번호', `<span class="num">${esc(tel)}</span>`, tel)}
      ${row('팩스', `<span class="num">${esc(r[9])}</span>`)}
      ${row('홈페이지', home ? `<a href="${esc(home)}" target="_blank" rel="noopener">${esc(r[10])}</a>` : '', r[10])}
      ${r[11] ? row('IR 홈페이지', `<a href="${esc(homeUrl(r[11]))}" target="_blank" rel="noopener">${esc(r[11])}</a>`) : ''}
      ${row('업종명', esc(META.industries[r[12]]))}
      ${row('설립일', `<span class="num">${estStr(r[13])}</span>`)}
      ${row('결산월', r[14] ? r[14] + '월' : '')}
      ${row('사업자번호', `<span class="num">${esc(r[6])}</span>`, r[6])}
      ${r[2] ? row('공시회사명', esc(r[2])) : ''}
    </dl>
    <div class="sec"><h4>🗺 일반 정밀지도 · 지적 · 공시지가 (브이월드)</h4><div class="sales" id="vwBox">
      <p class="tiny" style="margin:0 0 8px">일반 정밀지도(도로·건물)·백지도·항공·야간 전환 및 지적·용도·공시지가를 실시간 조회합니다.</p>
      <button type="button" class="aibtn" id="btnVwInspect" style="margin:0;background:linear-gradient(135deg,#0f766e,#0284c7)">🗺 일반 정밀지도 · 지적 · 공시지가 보기</button>
    </div></div>
    ${memoSection(i)}
    ${proDetailSection(i)}
    ${salesSection(i)}
    ${enrichSection(i)}
    ${anaSection(i)}
    ${aiSection(i)}
    <div class="sec"><h4>외부 공시 · 실적 바로가기</h4><div class="sales">
      <div class="linkrow">
        ${stock ? `<a class="pri" href="https://finance.naver.com/item/main.naver?code=${stock}" target="_blank" rel="noopener">네이버 금융</a><a href="https://finance.naver.com/item/coinfo.naver?code=${stock}" target="_blank" rel="noopener">기업분석</a>` : ''}
        <a class="${stock ? '' : 'pri'}" href="https://dart.fss.or.kr/" target="_blank" rel="noopener">DART 전자공시</a>
        <a href="https://search.naver.com/search.naver?query=${q(r[0].replace(/\(주\)|㈜|주식회사/g, '').trim() + ' 매출액')}" target="_blank" rel="noopener">매출 검색</a>
      </div>
      <p class="tiny" style="margin:8px 0 0">DART에서는 회사명 또는 사업자번호로 검색하세요. <button class="cp" data-cp="${esc(r[0])}">회사명 복사</button></p>
    </div></div>
    ${reg ? `<div class="sec"><h4><span>위치 · ${MAP.sidos.find(s => s.sd === reg.sd).n} ${esc(reg.n)}</span><button class="resetbtn" id="dregion">이 지역 기업 보기</button></h4><div class="mini" id="mini"></div></div>` : ''}
    ${peers.length ? `<div class="sec"><h4><span>같은 지역 · 같은 업종</span><button class="resetbtn" id="dpeer">모두 보기</button></h4><ul class="peers">${peers.map(k => `<li data-i="${k}"><span>${esc(ROWS[k][0])}</span><span class="tiny num">${estStr(ROWS[k][13])}</span></li>`).join('')}</ul></div>` : ''}
  </div>`;

  bindMemoUI(i);
  const loadVw = () => window.VWorldTwin?.renderInspector($('#vwBox'), { addr, name: r[0], store, meta: META });
  $('#btnVwInspect')?.addEventListener('click', loadVw);
  if (window.VWorldTwin?.getKey(store, META)) loadVw();
  if (MAPMODE === 'precision' && VW_MAIN && (addr || r[0])) {
    VW_MAIN.focusItem({ id: i, name: r[0], addr });
  }
  $('#dCmpBtn').onclick = () => { toggleCompare(i); $('#dCmpBtn').textContent = CMP.includes(i) ? '✓ 비교함에 담김' : '⚖️ 비교함에 담기'; };
  $('#dBriefBtn').onclick = () => openBriefing(i);
  if (reg) drawMini(reg);
  setPin(i);
  $('#dclose').onclick = closeDetail;
  $('#dfav').onclick = e => {
    const b = r[6]; if (FAV.has(b)) FAV.delete(b); else FAV.add(b);
    store.set('fav', [...FAV]); e.currentTarget.classList.toggle('on', FAV.has(b)); e.currentTarget.textContent = FAV.has(b) ? '★' : '☆';
    toast(FAV.has(b) ? '즐겨찾기에 추가했습니다' : '즐겨찾기에서 뺐습니다');
    const rowEl = $(`#list .item[data-i="${i}"]`); if (rowEl) rowEl.outerHTML = itemHTML(i);
  };
  $('#dbody').querySelectorAll('[data-cp]').forEach(b => b.onclick = () => copy(b.dataset.cp));
  const dd = $('#ddong'); if (dd) dd.onclick = () => { setSido(reg.sd, reg.id); S.dongs = [r[17]]; run(); closeDetail(); if (isMobile()) setView('list'); };
  const dr = $('#dregion'); if (dr) dr.onclick = () => { setSido(reg.sd, reg.id); run(); closeDetail(); zoomToBox(reg.b, .8); if (isMobile()) setView('map'); };
  const dp = $('#dpeer'); if (dp) dp.onclick = () => { setSido(reg.sd, reg.id); S.ind = [r[12]]; run(); closeDetail(); if (isMobile()) setView('list'); };
  $('#dbody').querySelectorAll('.peers li').forEach(l => l.onclick = () => openDetail(+l.dataset.i));
  $('#detail').classList.add('on'); $('#detail').setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('on');
  $('.db').scrollTop = 0;
}

function aiSection(i) {
  const r = ROWS[i], c = AI_C[i], p = aiParts(r, c, i), t = AI_S[i], cat = AICAT[c];
  const grade = t >= 80 ? '매우 유망' : t >= 70 ? '유망' : t >= 55 ? '검토' : '낮음';
  const lb = ['업종 적합도', sizePts(i, r)[1], '업력', '디지털 접점'], mx = [50, 30, 10, 10];
  return `<div class="sec"><h4>AI 도입 적합도 <span class="tiny">참고용 점수</span></h4><div class="sales">
   <div class="aiscore"><div class="big num">${t}<small>/100</small></div><div><div style="font-weight:700">${grade} · ${esc(cat[0])}</div><div class="tiny" style="margin-top:2px">${esc(cat[4])}</div></div></div>
   <div class="brk">${p.map((v, k) => `<span class="muted">${lb[k]}</span><span class="t"><i style="width:${v / mx[k] * 100}%"></i></span><span class="n">${v}/${mx[k]}</span>`).join('')}</div>
   <ul class="uc">${cat[3].map((u, k) => `<li>${k === 0 ? '<b>추천</b> ' : ''}${esc(u)}</li>`).join('')}</ul>
  </div></div>`;
}
function drawMini(reg) {
  const s = MAP.sidos.find(x => x.sd === reg.sd); const b = s.b, p = Math.max(b[2] - b[0], b[3] - b[1]) * .06 + 4;
  let h = `<svg viewBox="${b[0] - p} ${b[1] - p} ${b[2] - b[0] + 2 * p} ${b[3] - b[1] + 2 * p}">`;
  MAP.regions.filter(r => r.sd === reg.sd).forEach(r => { h += `<path d="${r.d}" style="fill:${r.id === reg.id ? 'var(--sel)' : 'var(--zero)'};stroke:var(--surface);stroke-width:1;vector-effect:non-scaling-stroke"/>`; });
  const fs = (b[2] - b[0] + 2 * p) / 22;
  h += `<text class="mlabel" x="${reg.c[0]}" y="${reg.c[1] - fs * 1.1}" style="font-size:${fs}px">${esc(reg.n)}</text></svg>`;
  $('#mini').innerHTML = h;
}
function closeDetail() { window.VWorldTwin?.destroyActiveMap(); $('#detail').classList.remove('on'); $('#detail').setAttribute('aria-hidden', 'true'); updateScrim(); setPin(-1); }

/* ==================== Navigation & Modals ==================== */
const isMobile = () => matchMedia('(max-width:767px)').matches;
function updateScrim() {
  const on = $('#detail').classList.contains('on') || $('#filterPanel').classList.contains('on') ||
    $('#settingsModal').classList.contains('on') || $('#cmpModal').classList.contains('on') || $('#briefModal').classList.contains('on');
  $('#scrim').classList.toggle('on', on);
}
function openFilter(on) { $('#filterPanel').classList.toggle('on', on); updateScrim(); }
function openSettings(on) {
  $('#settingsModal').classList.toggle('on', on);
  $('#settingsModal').setAttribute('aria-hidden', String(!on));
  if (on) {
    $('#geminiKeyIn').value = store.get('geminiKey', '');
    if ($('#vwKeyIn') && window.VWorldTwin) {
      const localVw = store.get('vworldKey', '');
      const effVw = VWorldTwin.getKey(store, META);
      $('#vwKeyIn').value = localVw;
      $('#vwKeyMask').textContent = localVw ? `${VWorldTwin.maskKey(effVw)} (수동 저장)` : effVw ? `${VWorldTwin.maskKey(effVw)} (Vault 암호화)` : '미입력';
    }
    applyTheme(store.get('theme', 'auto'));
    if (VAULT_META) $('#vaultInfo').textContent = `데이터 빌드일: ${VAULT_META.builtAt} · AES-256-GCM 암호화 (${(VAULT_META.totalBytes / 1024 / 1024).toFixed(2)} MB)`;
  }
  updateScrim();
}
function setSide(v) {
  $('#vEda').classList.toggle('on', v === 'eda'); $('#tabEda').setAttribute('aria-selected', v === 'eda'); if (v === 'eda') renderEda();
  $('#vPro').classList.toggle('on', v === 'pro'); $('#tabPro').setAttribute('aria-selected', v === 'pro'); if (v === 'pro') renderPro();
  $('#vMap').classList.toggle('on', v === 'map'); $('#vStats').classList.toggle('on', v === 'stats'); $('#vSales').classList.toggle('on', v === 'sales');
  $('#tabMap').setAttribute('aria-selected', v === 'map'); $('#tabStats').setAttribute('aria-selected', v === 'stats'); $('#tabSales').setAttribute('aria-selected', v === 'sales');
  if (v === 'sales') renderSales();
  $('#mapCap').style.visibility = v === 'map' ? 'visible' : 'hidden';
  if (v === 'stats' && STATS_DIRTY) renderStats();
  if (v === 'map') {
    syncMainMapMode();
    if (MAPMODE === 'precision') VW_MAIN?.invalidate();
    else requestAnimationFrame(renderLabels);
  }
}
function setView(v) {
  if (v === 'filter') { openFilter(true); return; }
  document.body.dataset.view = v;
  $$('.bnav button').forEach(b => b.setAttribute('aria-selected', b.dataset.v === v));
  if (v === 'map' || v === 'stats' || v === 'sales' || v === 'eda' || v === 'pro') setSide(v);
  if (v === 'map') {
    if (MAPMODE === 'precision') VW_MAIN?.invalidate();
    else requestAnimationFrame(renderLabels);
  }
  if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
}
function initNav() {
  $$('.tabs button').forEach(b => b.onclick = () => setSide(b.dataset.v));
  $$('.bnav button').forEach(b => b.onclick = () => setView(b.dataset.v));
  $('#scrim').onclick = () => { closeDetail(); openFilter(false); openSettings(false); closeCompare(); closeBriefing(); };
  $('#openSettings').onclick = () => openSettings(true);
  $('#closeSettings').onclick = () => openSettings(false);
  $('#closeCmp').onclick = closeCompare;
  $('#closeBrief').onclick = closeBriefing;
  $('#lockNowBtn').onclick = lockAppNow;
  $('#modalLockBtn').onclick = lockAppNow;
  $('#themeChips').onclick = e => { const b = e.target.closest('.chip'); if (b) applyTheme(b.dataset.th); };
  $('#vwEyeBtn')?.addEventListener('click', () => { const inp = $('#vwKeyIn'); inp.type = inp.type === 'password' ? 'text' : 'password'; });
  $('#saveVwKey')?.addEventListener('click', () => {
    const k = $('#vwKeyIn').value.replace(/\s+/g, '');
    if (k) { store.set('vworldKey', k); toast('브이월드 인증키 저장'); }
    else { store.del('vworldKey'); toast('수동 키 해제 · Vault 기본 키 사용'); }
    openSettings(true);
  });
  $('#btnCheckVw')?.addEventListener('click', async () => {
    if (!window.VWorldTwin) return;
    $('#vwDiagOut').textContent = '🩺 브이월드 API 2종 연결 점검 중…';
    const res = await VWorldTwin.healthChecks(store, META);
    $('#vwDiagOut').innerHTML = res.map(x => `${x.ok ? '🟢' : '🔴'} <b>${esc(x.name)}</b>: ${esc(x.summary)} (${esc(x.hint)})`).join('<br>');
  });
  $('#saveGeminiKey').onclick = () => {
    const k = $('#geminiKeyIn').value.trim();
    if (k) { store.set('geminiKey', k); toast('Gemini API 키를 저장했습니다'); }
    else { store.del('geminiKey'); toast('Gemini API 키를 삭제했습니다'); }
  };
  $('#clearCacheBtn').onclick = async () => {
    if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
    toast('오프라인 캐시를 비웠습니다. 새로고침합니다…');
    setTimeout(() => location.reload(), 600);
  };
  $('#backupExport').onclick = () => {
    const payload = {
      version: 2, exportedAt: new Date().toISOString(),
      fav: [...FAV], memos: MEMOS, branches: BR, presets: PRESETS, proW: PRO_W,
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = `기업분석_백업_${todayStr()}.json`;
    a.click();
    toast('즐겨찾기·메모·지사·프리셋·가중치를 백업했습니다');
  };
  $('#backupImport').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (Array.isArray(j.fav)) { FAV = new Set(j.fav); store.set('fav', [...FAV]); }
      if (j.memos && typeof j.memos === 'object') { MEMOS = Object.assign({}, MEMOS, j.memos); store.set('memos', MEMOS); }
      if (Array.isArray(j.branches) && j.branches.length) { BR = j.branches; await saveBranches(); renderBrChips(); }
      if (Array.isArray(j.presets)) { PRESETS = j.presets; store.set('presets', PRESETS); renderPresets(); }
      if (j.proW && typeof j.proW === 'object') { PRO_W = Object.assign({}, PRO_W, j.proW); store.set('proW', PRO_W); recomputeLead(); }
      run(); toast('백업을 복원했습니다');
    } catch { toast('백업 파일 형식이 올바르지 않습니다'); }
    e.target.value = '';
  };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDetail(); openFilter(false); openSettings(false); closeCompare(); closeBriefing(); }
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  });

  // swipe down to close sheet (mobile)
  let sy = null; const d = $('#detail');
  d.addEventListener('touchstart', e => { const db = d.querySelector('.db'); sy = (db && db.scrollTop > 0 && !e.target.closest('.dh,.grab')) ? null : e.touches[0].clientY; }, { passive: true });
  d.addEventListener('touchmove', e => { if (sy === null || !isMobile()) return; const dy = e.touches[0].clientY - sy; if (dy > 0) d.style.transform = `translateY(${dy}px)`; }, { passive: true });
  d.addEventListener('touchend', e => { if (sy === null) return; const dy = e.changedTouches[0].clientY - sy; d.style.transform = ''; if (dy > 110 && isMobile()) closeDetail(); sy = null; });

  const h = location.hash.slice(1); if (['list', 'map', 'stats', 'sales', 'eda', 'pro'].includes(h)) setView(h);
  window.addEventListener('hashchange', () => { const hh = location.hash.slice(1); if (['list', 'map', 'stats', 'sales', 'eda', 'pro'].includes(hh)) setView(hh); });
}

/* ==================== Analytics, EDA & Gemini AI ==================== */
let SAL = null, SAL_EST = null, HIRE_R = null, QUIT_R = null, NET = null, OUT = null, OUT_COV = null, FUT = null;
const SAL_B = [['3천만 미만', 0, 3e7], ['3~5천만', 3e7, 5e7], ['5~7천만', 5e7, 7e7], ['7천~1억', 7e7, 1e8], ['1억 이상', 1e8, 1e12]];
const NPS_CAP = 6.59e6;
const TAILWIND = /인공지능|소프트웨어|데이터|정보서비스|포털|반도체|전자부품|집적회로|축전지|전지|이차|바이오|의약|의료|진단|로봇|자동제어|전기자동차|태양|풍력|수소|에너지 저장|통신장비|항공|우주|무기|화장품|게임|플랫폼|연구개발/;
const OUT_W = { growth: 30, profit: 20, hiring: 15, salary: 10, industry: 15, stability: 10 };
const OUT_LBL = { growth: '성장성', profit: '수익성', hiring: '채용 모멘텀', salary: '연봉 경쟁력', industry: '업종 전망', stability: '재무 안정성' };
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
function indTail(n) { if (/부동산|임대|금융|투자|신탁|지주회사|여신/.test(n)) return 0; if (TAILWIND.test(n)) return 1; if (/제조/.test(n)) return .6; return .4; }

function buildAnalytics() {
  SAL = new Float64Array(N).fill(NaN); SAL_EST = new Uint8Array(N); HIRE_R = new Float32Array(N).fill(NaN);
  QUIT_R = new Float32Array(N).fill(NaN); NET = new Float32Array(N).fill(NaN); OUT = new Float32Array(N).fill(NaN);
  OUT_COV = new Uint8Array(N); FUT = new Uint8Array(N);
  const tailI = META.industries.map(indTail);
  const strongMask = TAGS.reduce((m, t, k) => /강소/.test(t.label) ? m | (1 << k) : m, 0);
  for (let i = 0; i < N; i++) {
    const r = ROWS[i]; const p = {};
    if (EN) {
      if (ok(EN.avg_sal[i])) SAL[i] = EN.avg_sal[i];
      else if (ok(EN.nps_wage[i]) && EN.nps_wage[i] > 0) { SAL[i] = EN.nps_wage[i] * 12; SAL_EST[i] = EN.nps_wage[i] >= NPS_CAP * 0.98 ? 2 : 1; }
      const e = EN.nps_emp[i];
      if (ok(e) && e > 0) {
        if (ok(EN.nps_new[i]) && e >= 5) HIRE_R[i] = EN.nps_new[i] / e * 100;
        if (ok(EN.nps_lost[i]) && e >= 5) QUIT_R[i] = EN.nps_lost[i] / e * 100;
        if (ok(EN.nps_new[i]) && ok(EN.nps_lost[i])) NET[i] = EN.nps_new[i] - EN.nps_lost[i];
      }
      const g = revGrowth(i);
      if (ok(g)) p.growth = clamp01((g + 10) / 40);
      else if (ok(NET[i]) && ok(EN.nps_emp[i]) && EN.nps_emp[i] >= 5) p.growth = clamp01((NET[i] / EN.nps_emp[i] * 100 + 2) / 8);
      const m = opMargin(i);
      if (ok(m)) p.profit = clamp01((m + 5) / 20);
      else if (ok(EN.ni[i])) p.profit = EN.ni[i] > 0 ? .6 : .15;
      if (ok(HIRE_R[i])) p.hiring = clamp01(HIRE_R[i] / 4);
      if (ok(SAL[i])) p.salary = clamp01((SAL[i] - 3e7) / 5e7);
      if (ok(EN.equity[i]) && ok(EN.assets[i]) && EN.assets[i] > 0) p.stability = EN.equity[i] <= 0 ? 0 : clamp01((300 - (EN.assets[i] - EN.equity[i]) / EN.equity[i] * 100) / 250);
    }
    p.industry = tailI[r[12]];
    let ws = 0, sc = 0; for (const k in p) { ws += OUT_W[k]; sc += OUT_W[k] * p[k]; }
    OUT_COV[i] = ws; if (ws >= 40) OUT[i] = Math.round(sc / ws * 100);
    if (OUT[i] >= 75 && ws >= 55 && p.growth !== undefined && (ok(revEok(i)) || (EN && EN.nps_emp[i] >= 10))) {
      const st = empOf(i), rv = revEok(i), a = age(r[13]);
      const small = (ok(st) && st >= 10 && st < 300) || (!ok(st) && ok(rv) && rv < 1000 && r[5] === 3);
      if (small && a !== null && a >= 3 && !(TAGM && (TAGM[i] & strongMask))) FUT[i] = 1;
    }
  }
}
function outParts(i) {
  const r = ROWS[i]; const p = {};
  if (EN) {
    const g = revGrowth(i);
    if (ok(g)) p.growth = [clamp01((g + 10) / 40), `매출 ${g >= 0 ? '+' : ''}${g.toFixed(1)}%`];
    else if (ok(NET[i]) && ok(EN.nps_emp[i]) && EN.nps_emp[i] >= 5) p.growth = [clamp01((NET[i] / EN.nps_emp[i] * 100 + 2) / 8), `인원 순증 ${NET[i] >= 0 ? '+' : ''}${NET[i]}명/월`];
    const m = opMargin(i);
    if (ok(m)) p.profit = [clamp01((m + 5) / 20), `영업이익률 ${m.toFixed(1)}%`];
    else if (ok(EN.ni[i])) p.profit = [EN.ni[i] > 0 ? .6 : .15, EN.ni[i] > 0 ? '순이익 흑자' : '순이익 적자'];
    if (ok(HIRE_R[i])) p.hiring = [clamp01(HIRE_R[i] / 4), `월 입사율 ${HIRE_R[i].toFixed(1)}%`];
    if (ok(SAL[i])) p.salary = [clamp01((SAL[i] - 3e7) / 5e7), `연봉 ${fmtSal(i)}`];
    if (ok(EN.equity[i]) && ok(EN.assets[i]) && EN.assets[i] > 0) p.stability = [EN.equity[i] <= 0 ? 0 : clamp01((300 - (EN.assets[i] - EN.equity[i]) / EN.equity[i] * 100) / 250), EN.equity[i] <= 0 ? '자본잠식' : `부채비율 ${((EN.assets[i] - EN.equity[i]) / EN.equity[i] * 100).toFixed(0)}%`];
  }
  const t = indTail(META.industries[r[12]]);
  p.industry = [t, t >= 1 ? '성장 업종' : t >= .6 ? '제조업' : t === 0 ? '금융·부동산' : '일반 업종'];
  return p;
}
const fmtSal = i => !ok(SAL[i]) ? '-' : (SAL[i] >= 1e8 ? (SAL[i] / 1e8).toFixed(2) + '억' : Math.round(SAL[i] / 1e4).toLocaleString('ko-KR') + '만') + (SAL_EST[i] === 2 ? '+' : '') + (SAL_EST[i] ? '(추정)' : '');
function anaBadges(i) { let h = ''; if (FUT && FUT[i]) h += '<span class="sb s-fut">🌱 미래 강소 후보</span>'; if (OUT && ok(OUT[i]) && OUT[i] >= 70) h += `<span class="sb s-out">전망 ${OUT[i]}</span>`; return h; }
function anaLine(i) {
  if (!EN) return ''; const p = [];
  if (ok(SAL[i])) p.push(`연봉 ${fmtSal(i)}`);
  if (ok(EN.ni[i])) p.push(`<span style="color:${EN.ni[i] < 0 ? 'var(--c8)' : 'inherit'}">순이익 ${fmtEok(EN.ni[i])}</span>`);
  if (ok(NET[i]) && NET[i] !== 0) p.push(`<span style="color:${NET[i] > 0 ? 'var(--c3)' : 'var(--c8)'}">인원 ${NET[i] > 0 ? '+' : ''}${NET[i]}명/월</span>`);
  return p.length ? `<div class="enl muted num">${p.join(' · ')}</div>` : '';
}
function anaSection(i) {
  let h = '';
  if (EN && (ok(EN.nps_emp[i]) || ok(SAL[i]))) {
    h += `<div class="sec"><h4>채용활동 · 연봉 <span class="tiny">${ok(EN.nps_emp[i]) ? `국민연금 ${esc(String(EN_META.npsYm || ''))}` : ''}</span></h4><div class="sales"><div class="fkpi">
     ${ok(SAL[i]) ? `<div><span>${SAL_EST[i] ? '추정 평균연봉' : '1인 평균연봉'}</span><b class="num">${fmtSal(i).replace('(추정)', '')}</b><em>${SAL_EST[i] ? '국민연금 기준소득×12' + (SAL_EST[i] === 2 ? ' · 상한 이상' : '') : 'DART 사업보고서'}</em></div>` : ''}
     ${ok(EN.nps_emp[i]) ? `<div><span>가입자(직원)</span><b class="num">${fmt(EN.nps_emp[i])}명</b></div>` : ''}
     ${ok(EN.nps_new[i]) ? `<div><span>월 입사</span><b class="num" style="color:var(--c3)">${fmt(EN.nps_new[i])}명</b>${ok(HIRE_R[i]) ? `<em>입사율 ${HIRE_R[i].toFixed(1)}%</em>` : ''}</div>` : ''}
     ${ok(EN.nps_lost[i]) ? `<div><span>월 퇴사</span><b class="num">${fmt(EN.nps_lost[i])}명</b>${ok(QUIT_R[i]) ? `<em>퇴사율 ${QUIT_R[i].toFixed(1)}%</em>` : ''}</div>` : ''}
     ${ok(NET[i]) ? `<div><span>인원 순증</span><b class="num" style="color:${NET[i] > 0 ? 'var(--c3)' : NET[i] < 0 ? 'var(--c8)' : 'inherit'}">${NET[i] > 0 ? '+' : ''}${NET[i]}명</b><em>${NET[i] > 0 ? '확장 중' : NET[i] < 0 ? '감소' : '유지'}</em></div>` : ''}
    </div></div></div>`;
  }
  if (OUT && ok(OUT[i])) {
    const p = outParts(i), sc = OUT[i], g = sc >= 80 ? '매우 밝음' : sc >= 70 ? '밝음' : sc >= 55 ? '보통' : '주의';
    h += `<div class="sec"><h4>전망 점수 ${FUT[i] ? '<span class="sb s-fut">🌱 미래 강소 후보</span>' : ''}<span class="tiny">데이터 충분도 ${OUT_COV[i]}%</span></h4><div class="sales">
     <div class="aiscore"><div class="big num">${sc}<small>/100</small></div><div><div style="font-weight:700">${g}</div><div class="tiny" style="margin-top:2px">성장·수익·채용·연봉·업종·재무안정을 가중 합산</div></div></div>
     <div class="obrk">${Object.keys(OUT_W).map(k => p[k] ? `<span class="muted">${OUT_LBL[k]}</span><span class="t"><i style="width:${p[k][0] * 100}%"></i></span><span class="n">${Math.round(p[k][0] * OUT_W[k])}/${OUT_W[k]}</span><span class="d">${esc(p[k][1])}</span>` : `<span class="muted" style="opacity:.5">${OUT_LBL[k]}</span><span class="d" style="grid-column:2/4;opacity:.6;margin:0">자료 없음</span>`).join('')}</div>
    </div></div>`;
  }
  h += `<div class="sec"><h4>🤖 AI 기업 분석</h4><div class="sales" id="aiRep"><p style="margin:0 0 8px">위 수치를 바탕으로 강점·리스크·전망·영업 포인트를 Gemini AI가 정리합니다.</p><button class="aibtn" style="margin:0" data-ai-rep="${i}">AI 분석 생성</button></div></div>`;
  return h;
}

/* ---- Live Gemini API Helper ---- */
async function callGemini(prompt, wantJson = false) {
  const key = store.get('geminiKey', '');
  if (!key) {
    toast('설정(⚙️)에서 Gemini API 키를 먼저 입력하세요');
    openSettings(true);
    return null;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    ...(wantJson ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Gemini HTTP ${r.status} ${errText.slice(0, 80)}`);
  }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!wantJson) return txt;
  const cleaned = txt.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function companyFacts(i) {
  const r = ROWS[i];
  const f = { 회사: r[0], 업종: META.industries[r[12]], 지역: r[7].split(' ').slice(0, 2).join(' '), 법인구분: META.corp[r[5]], 설립: estStr(r[13]), 업력: age(r[13]), 홈페이지: !!r[10] };
  if (EN) {
    const e = k => ok(EN[k][i]) ? Math.round(EN[k][i] / 1e8) : undefined;
    Object.assign(f, {
      매출억_당기: e('rev'), 매출억_전기: e('rev_p1'), 매출억_전전기: e('rev_p2'), 영업이익억: e('op'), 순이익억: e('ni'),
      직원: ok(empOf(i)) ? Math.round(empOf(i)) : undefined, 연봉만원: ok(SAL[i]) ? Math.round(SAL[i] / 1e4) : undefined,
      월입사: ok(EN.nps_new[i]) ? EN.nps_new[i] : undefined, 월퇴사: ok(EN.nps_lost[i]) ? EN.nps_lost[i] : undefined,
    });
  }
  if (STAT) f.사업자상태 = STAT_LBL[STAT[i]];
  if (OUT && ok(OUT[i])) f.전망점수 = OUT[i];
  f.AI도입적합도 = AI_S[i]; f.AI활용분야 = AICAT[AI_C[i]][0];
  if (FUT[i]) f.미래강소후보 = true;
  if (TAGM && TAGM[i]) f.인증 = TAGS.filter((_, k) => TAGM[i] & (1 << k)).map(t => t.label);
  Object.keys(f).forEach(k => f[k] === undefined && delete f[k]);
  return f;
}

async function aiReport(i, box) {
  box.innerHTML = '<p class="tiny">Gemini AI가 분석 중입니다…</p>';
  const prompt = `당신은 B2B 영업 분석가입니다. 아래 한국 기업 데이터만 근거로 분석하세요. 데이터에 없는 사실은 추측하지 말고, 수치가 없으면 '자료 없음'으로 다루세요.
반드시 JSON 하나만 출력: {"요약":"한 문장","강점":["…"],"리스크":["…"],"전망":"2~3문장","영업포인트":["보안·AI CCTV·업무 자동화 등 이 회사에 맞는 제안 2~3개"],"확인할점":["영업 전 확인할 것 1~2개"]}
데이터: ${JSON.stringify(companyFacts(i))}`;
  try {
    const v = await callGemini(prompt, true);
    if (!v) { box.innerHTML = '<p class="tiny">설정(⚙️)에서 Gemini API 키를 입력하면 AI 분석을 바로 사용할 수 있습니다.</p>'; return; }
    const L = a => (Array.isArray(a) ? a : []).map(x => `<li>${esc(x)}</li>`).join('');
    box.innerHTML = `<p style="margin:0 0 8px;font-weight:700">${esc(v.요약 || '')}</p><div class="airep"><div><b>강점</b><ul>${L(v.강점)}</ul></div><div><b>리스크</b><ul>${L(v.리스크)}</ul></div></div><p style="margin:8px 0"><b>전망</b> ${esc(v.전망 || '')}</p><div><b>영업 포인트</b><ul>${L(v.영업포인트)}</ul></div><div class="tiny"><b>확인할 점</b><ul>${L(v.확인할점)}</ul></div>`;
  } catch (e) {
    box.innerHTML = `<p class="tiny">AI 분석 오류: ${esc(e.message)}</p>`;
  }
}

async function aiSearch(text) {
  toast('AI가 조건으로 바꾸는 중…');
  const prompt = `사용자의 기업 검색 문장을 아래 JSON 조건으로 바꾸세요. 해당 없는 키는 빼고 JSON만 출력.
키: name(회사명 일부), sido(다음 중 하나: ${META.sido.map(s => s.n).join(',')}), sgg(시군구명 배열, 예 ["부평구"]), dong(읍면동 배열, 예 ["청천동"]), ind(업종 키워드 배열, 예 ["반도체","소프트웨어"]),
corp(배열: 0=코스피,1=코스닥,2=코넥스,3=기타법인), revB(매출구간 인덱스 배열: ${REV_B.map((b, k) => k + '=' + b[0]).join(', ')}), empB(직원구간 인덱스 배열: ${EMP_B.map((b, k) => k + '=' + b[0]).join(', ')}),
salB(연봉구간 인덱스 배열: ${SAL_B.map((b, k) => k + '=' + b[0]).join(', ')}), prof(true=영업이익 흑자), nip(true=순이익 흑자), grow(true=매출성장), hire(true=채용 활발), netup(true=인원 증가), fut(true=미래 강소 후보), outMin(전망점수 최소 0~100), ai(AI도입 적합도 최소: 60/70/80), aicat(AI 분야명: ${AICAT.map(c => c[0]).join(',')}),
estFrom(설립 시작 YYYY-MM-DD), estTo(설립 끝 YYYY-MM-DD), hasHome(true), sort(rel|name|old|new|ai|rev|op|margin|growth|emp|hire|out|sal|ni|net)
문장: ${text}`;
  try {
    const v = await callGemini(prompt, true);
    if (!v) return;
    applyAiFilter(v);
    toast(`AI 조건 적용 · ${fmt(RES.length)}개`);
  } catch (e) {
    toast('AI 검색 실패: ' + e.message);
  }
}

function applyAiFilter(v) {
  resetAll();
  if (v.name) { S.name = v.name; $('#fName').value = v.name; }
  const sd = v.sido ? META.sido.find(s => s.n === v.sido || s.s === v.sido || v.sido.startsWith(s.s)) : null;
  if (sd) { S.sido = sd.sd; $('#fSido').value = sd.sd; fillSgg(); }
  if (Array.isArray(v.sgg)) v.sgg.forEach(n => { const r = MAP.regions.filter(x => x.n === n || x.n.startsWith(n.replace(/(시|군|구)$/, ''))); const rr = sd ? r.filter(x => x.sd === sd.sd) : r; rr.slice(0, 3).forEach(x => { if (!S.sggs.includes(x.id)) S.sggs.push(x.id); }); });
  if (Array.isArray(v.dong)) { const sg = new Set(S.sggs); v.dong.forEach(n => { META.dongs.forEach((d, k) => { if ((d[1] === n || d[1] === n + '동') && (!sg.size || sg.has(d[0])) && (!sd || MAP.regions[d[0]].sd === sd.sd)) S.dongs.push(k); }); }); }
  if (Array.isArray(v.ind) && v.ind.length) S.indKw = v.ind.map(x => String(x).trim()).filter(Boolean).join(',');
  const arr = (k, mx) => Array.isArray(v[k]) ? v[k].map(Number).filter(x => x >= 0 && x < mx) : [];
  S.corp = arr('corp', 4); S.revB = arr('revB', REV_B.length); S.empB = arr('empB', EMP_B.length); S.salB = arr('salB', SAL_B.length);
  ['prof', 'grow', 'hire', 'hasHome', 'nip', 'netup', 'fut'].forEach(k => { if (v[k]) S[k] = true; });
  if (v.hasHome) $('#fHasHome').checked = true;
  if (v.outMin) S.outMin = +v.outMin; if (v.ai) S.ai = +v.ai;
  if (v.aicat) { const k = AICAT.findIndex(c => c[0] === v.aicat); if (k >= 0) S.aicat = String(k); }
  if (v.estFrom) { S.from = v.estFrom; $('#fFrom').value = v.estFrom; }
  if (v.estTo) { S.to = v.estTo; $('#fTo').value = v.estTo; }
  if (v.sort && $(`#sort option[value="${v.sort}"]`)) S.sort = v.sort;
  run();
}

/* ---- EDA ---- */
const EDA_M = [
  { k: 'rev', l: '매출액(억)', f: i => revEok(i), log: true },
  { k: 'margin', l: '영업이익률(%)', f: i => { const r = EN ? EN.rev[i] : NaN; return r >= 1e9 ? opMargin(i) : NaN; } },
  { k: 'ni', l: '순이익(억)', f: i => EN && ok(EN.ni[i]) ? EN.ni[i] / 1e8 : NaN },
  { k: 'growth', l: '매출성장률(%)', f: i => { const r = EN ? EN.rev[i] : NaN; return r >= 1e9 ? revGrowth(i) : NaN; } },
  { k: 'emp', l: '직원수', f: i => empOf(i), log: true },
  { k: 'sal', l: '연봉(만원)', f: i => ok(SAL[i]) ? SAL[i] / 1e4 : NaN },
  { k: 'hire', l: '월 입사율(%)', f: i => HIRE_R[i] },
  { k: 'out', l: '전망점수', f: i => OUT[i] },
  { k: 'age', l: '업력(년)', f: i => { const a = age(ROWS[i][13]); return a === null ? NaN : a; } },
];
let EDA_SEL = 'rev', EDA_SC = null, edaStatsCache = null, QUAD_PTS = [];
const qPct = (s, p) => { if (!s.length) return NaN; const x = (s.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x); return s[lo] + (s[hi] - s[lo]) * (x - lo); };
const nf = (v, d = 1) => !ok(v) ? '-' : Math.abs(v) >= 1000 ? fmt(Math.round(v)) : v.toFixed(d);
function edaCols() { const n = RES.length; const cols = {}; EDA_M.forEach(m => { const a = new Float64Array(n); for (let k = 0; k < n; k++) a[k] = m.f(RES[k]); cols[m.k] = a; }); return cols; }
function spearman(a, b) {
  const idx = []; for (let k = 0; k < a.length; k++) if (ok(a[k]) && ok(b[k])) idx.push(k);
  if (idx.length < 30) return [NaN, idx.length];
  const rank = arr => {
    const o = idx.map((k, j) => [arr[k], j]).sort((x, y) => x[0] - y[0]); const r = new Float64Array(idx.length);
    let s = 0; while (s < o.length) { let e = s; while (e + 1 < o.length && o[e + 1][0] === o[s][0]) e++; const av = (s + e) / 2; for (let t = s; t <= e; t++) r[o[t][1]] = av; s = e + 1; }
    return r;
  };
  const ra = rank(a), rb = rank(b); let ma = 0, mb = 0; const n = idx.length;
  for (let k = 0; k < n; k++) { ma += ra[k]; mb += rb[k]; } ma /= n; mb /= n;
  let c = 0, va = 0, vb = 0; for (let k = 0; k < n; k++) { const x = ra[k] - ma, y = rb[k] - mb; c += x * y; va += x * x; vb += y * y; }
  return [c / Math.sqrt(va * vb), n];
}
function renderEda() {
  const el = $('#eda'); if (!el) return; const n = RES.length;
  if (!EN) { el.innerHTML = `<div class="card"><h3>분석할 실적 데이터가 없습니다</h3></div>`; return; }
  const cols = edaCols(); EDA_SC = cols;
  let h = `<div class="card"><h3>요약 통계 <span class="tiny">현재 조회 ${fmt(n)}개 기준</span></h3><div class="sub">충분도 = 값이 있는 기업 비율 · 행을 누르면 아래 분포 그래프가 바뀝니다</div><div class="tblwrap"><table class="tbl"><thead><tr><th>지표</th><th>기업 수</th><th>충분도</th><th>평균</th><th>중앙값</th><th>P10</th><th>P90</th></tr></thead><tbody>`;
  const stats = {};
  EDA_M.forEach(m => {
    const v = [...cols[m.k]].filter(ok).sort((a, b) => a - b);
    const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    stats[m.k] = { n: v.length, mean, med: qPct(v, .5), p10: qPct(v, .1), p90: qPct(v, .9), p25: qPct(v, .25), p75: qPct(v, .75), s: v };
    h += `<tr data-edam="${m.k}" class="${EDA_SEL === m.k ? 'sel' : ''}"><td>${m.l}</td><td class="num">${fmt(v.length)}</td><td class="num">${n ? (v.length / n * 100).toFixed(0) : 0}%</td><td class="num">${nf(mean)}</td><td class="num"><b>${nf(qPct(v, .5))}</b></td><td class="num">${nf(qPct(v, .1))}</td><td class="num">${nf(qPct(v, .9))}</td></tr>`;
  });
  h += `</tbody></table></div></div>`;
  const sm = EDA_M.find(m => m.k === EDA_SEL), ss = stats[EDA_SEL];
  h += `<div class="card"><h3>분포 · ${sm.l}${sm.log ? ' <span class="tiny">로그 눈금</span>' : ''}</h3><div id="edaHist">${histSVG(ss.s, sm)}</div></div>`;
  const ck = ['rev', 'margin', 'growth', 'emp', 'sal', 'hire', 'out', 'age'];
  const lab = ck.map(k => EDA_M.find(m => m.k === k).l.replace(/\(.*\)/, ''));
  let cm = '<div class="corr" style="grid-template-columns:72px repeat(' + ck.length + ',1fr)"><span></span>' + lab.map(l => `<span class="ch">${l}</span>`).join('');
  ck.forEach((a, x) => {
    cm += `<span class="rh">${lab[x]}</span>`;
    ck.forEach((b, y) => {
      if (x === y) { cm += '<span class="cc diag">1</span>'; return; }
      const [r, cnt] = spearman(cols[a], cols[b]);
      const c = !ok(r) ? 'var(--zero)' : r > 0 ? `color-mix(in srgb,var(--c1) ${Math.round(Math.abs(r) * 100)}%,var(--surface-2))` : `color-mix(in srgb,var(--c8) ${Math.round(Math.abs(r) * 100)}%,var(--surface-2))`;
      cm += `<span class="cc" style="background:${c};color:${Math.abs(r) > .55 ? '#fff' : 'var(--ink)'}" title="${lab[x]} × ${lab[y]}: ρ=${ok(r) ? r.toFixed(2) : '자료 부족'} (n=${fmt(cnt)})">${ok(r) ? r.toFixed(2) : '·'}</span>`;
    });
  });
  cm += '</div>';
  h += `<div class="card"><h3>상관관계 (스피어만 순위상관)</h3><div class="sub">파랑=함께 커짐, 빨강=반대로 움직임</div>${cm}</div>`;
  h += `<div class="card"><h3>성장 × 수익 사분면</h3><div class="sub">매출 10억 이상 기업 · 점을 누르면 상세</div><canvas id="quad" height="320"></canvas><div class="quadlg" id="quadLg"></div></div>`;
  const g = new Map(); for (let k = 0; k < n; k++) { const i = RES[k], ind = ROWS[i][12]; if (!g.has(ind)) g.set(ind, []); g.get(ind).push(k); }
  const med = arr => { const v = arr.filter(ok).sort((a, b) => a - b); return [qPct(v, .5), v.length]; };
  const rows = [...g.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([ind, ks]) => {
    const pick = key => ks.map(k => cols[key][k]);
    const [rv] = med(pick('rev')), [mg] = med(pick('margin')), [sl] = med(pick('sal')), [hr] = med(pick('hire')), [ou] = med(pick('out'));
    return { ind, c: ks.length, rv, mg, sl, hr, ou };
  });
  h += `<div class="card"><h3>업종 비교 TOP 15</h3><div class="sub">업종 내 중앙값 · 행을 누르면 업종 필터</div><div class="tblwrap"><table class="tbl"><thead><tr><th>업종</th><th>기업</th><th>매출(억)</th><th>이익률%</th><th>연봉(만)</th><th>입사율%</th><th>전망</th></tr></thead><tbody>
   ${rows.map(r => `<tr data-edaind="${r.ind}"><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(META.industries[r.ind])}</td><td class="num">${fmt(r.c)}</td><td class="num">${nf(r.rv, 0)}</td><td class="num">${nf(r.mg)}</td><td class="num">${nf(r.sl, 0)}</td><td class="num">${nf(r.hr)}</td><td class="num">${nf(r.ou, 0)}</td></tr>`).join('')}</tbody></table></div></div>`;
  const outl = [];
  [['margin', '영업이익률'], ['growth', '매출성장률'], ['hire', '월 입사율']].forEach(([key, l]) => {
    const st = stats[key]; if (st.n < 20) return; const iqr = st.p75 - st.p25, hi = st.p75 + 3 * iqr, lo = st.p25 - 3 * iqr;
    for (let k = 0; k < n; k++) { const v = cols[key][k]; if (ok(v) && (v > hi || v < lo)) outl.push({ i: RES[k], l, v, dir: v > hi ? '높음' : '낮음' }); }
  });
  outl.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  h += `<div class="card"><h3>이상치 (IQR×3 밖)</h3>${outl.length ? `<ul class="peers">${outl.slice(0, 12).map(o => `<li data-edai="${o.i}"><span>${esc(ROWS[o.i][0])}</span><span class="tiny num">${o.l} ${o.v.toFixed(1)}% (${o.dir})</span></li>`).join('')}</ul>` : '<p class="tiny">특이한 값이 없습니다.</p>'}</div>`;
  h += `<div class="card"><h3>🤖 AI 인사이트</h3><div class="sub">위 통계를 Gemini AI가 읽고 영업 관점의 발견점을 정리합니다</div><div id="edaAi"><button class="aibtn" style="margin:0" data-eda-ai="1">AI 인사이트 생성</button></div></div>`;
  el.innerHTML = h; edaStatsCache = { stats, rows }; drawQuad(cols);
}
function histSVG(s, m) {
  if (!s.length) return '<p class="tiny">값이 있는 기업이 없습니다.</p>';
  let v = s; if (m.log) v = s.filter(x => x > 0).map(Math.log10); if (!v.length) return '<p class="tiny">값이 없습니다</p>';
  const lo = qPct(v, .01); let hi = qPct(v, .99); if (hi <= lo) hi = lo + 1;
  const B = 28, w = (hi - lo) / B, c = new Array(B).fill(0);
  v.forEach(x => { let b = Math.floor((x - lo) / w); b = b < 0 ? 0 : b >= B ? B - 1 : b; c[b]++; });
  const mx = Math.max(...c), W = 600, H = 170, bw = W / B;
  const md = m.log ? Math.log10(qPct(s.filter(x => x > 0), .5)) : qPct(s, .5);
  const lab = x => m.log ? nf(Math.pow(10, x), 0) : nf(x);
  return `<svg viewBox="0 0 ${W} ${H + 22}" class="hist2">${c.map((n, k) => `<rect x="${k * bw + 1}" y="${H - n / mx * (H - 10)}" width="${bw - 2}" height="${n / mx * (H - 10)}" rx="2"><title>${lab(lo + k * w)} ~ ${lab(lo + (k + 1) * w)}: ${fmt(n)}개</title></rect>`).join('')}
   <line x1="${(md - lo) / (hi - lo) * W}" x2="${(md - lo) / (hi - lo) * W}" y1="0" y2="${H}" class="mdl"/><text x="${Math.min(W - 60, Math.max(4, (md - lo) / (hi - lo) * W + 4))}" y="12" class="hl">중앙값 ${lab(md)}</text>
   <text x="0" y="${H + 16}" class="hl">${lab(lo)}</text><text x="${W / 2}" y="${H + 16}" class="hl" text-anchor="middle">${lab((lo + hi) / 2)}</text><text x="${W}" y="${H + 16}" class="hl" text-anchor="end">${lab(hi)}</text></svg>`;
}
function drawQuad(cols) {
  const cv = $('#quad'); if (!cv) return;
  const W = cv.clientWidth || 600, H = 320, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.scale(dpr, dpr); const cs = getComputedStyle(document.body); const col = k => cs.getPropertyValue(k).trim() || '#888';
  const pad = 28, X = v => pad + (Math.max(-40, Math.min(40, v)) + 40) / 80 * (W - pad * 2), Y = v => H - pad - (Math.max(-40, Math.min(40, v)) + 40) / 80 * (H - pad * 2);
  g.strokeStyle = col('--line-2'); g.lineWidth = 1; g.beginPath(); g.moveTo(X(0), pad); g.lineTo(X(0), H - pad); g.moveTo(pad, Y(0)); g.lineTo(W - pad, Y(0)); g.stroke();
  g.fillStyle = col('--ink-3'); g.font = '11px sans-serif'; g.fillText('-40%', pad - 4, H - 10); g.fillText('+40%', W - pad - 24, H - 10); g.fillText('성장률 →', W / 2 + 6, H - 10); g.fillText('이익률 ↑', X(0) + 4, pad - 8);
  const qd = [0, 0, 0, 0]; QUAD_PTS = []; const pts = [];
  for (let k = 0; k < RES.length; k++) { const a = cols.growth[k], b = cols.margin[k]; if (ok(a) && ok(b)) pts.push([k, a, b]); }
  const lim = pts.length > 6000 ? 6000 : pts.length, step = pts.length / lim;
  g.fillStyle = col('--c1'); g.globalAlpha = .5;
  for (let t = 0; t < lim; t++) { const [k, a, b] = pts[Math.floor(t * step)]; const x = X(a), y = Y(b); g.beginPath(); g.arc(x, y, 2.6, 0, 6.3); g.fill(); QUAD_PTS.push([x, y, RES[k], a, b]); }
  pts.forEach(([, a, b]) => qd[a >= 0 ? (b >= 0 ? 0 : 3) : (b >= 0 ? 1 : 2)]++); g.globalAlpha = 1;
  const L = [['⭐ 성장·수익', W - pad - 6, pad + 14, 'right', 0], ['💰 수익·정체', pad + 6, pad + 14, 'left', 1], ['⚠ 정체·적자', pad + 6, H - pad - 8, 'left', 2], ['🚀 성장·적자', W - pad - 6, H - pad - 8, 'right', 3]];
  g.font = 'bold 12px sans-serif'; g.fillStyle = col('--ink'); L.forEach(([t, x, y, al, ix]) => { g.textAlign = al; g.fillText(`${t} ${fmt(qd[ix])}`, x, y); }); g.textAlign = 'left';
  $('#quadLg').innerHTML = pts.length ? `표시 ${fmt(lim)}개${pts.length > lim ? ` (전체 ${fmt(pts.length)}개 중 표본)` : ''}` : '성장률·이익률이 모두 있는 기업이 없습니다';
  cv.onclick = e => { const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; let best = null, bd = 64; QUAD_PTS.forEach(p => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = p; } }); if (best) openDetail(best[2]); };
  cv.onmousemove = e => { const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; let best = null, bd = 64; QUAD_PTS.forEach(p => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = p; } }); cv.title = best ? `${ROWS[best[2]][0]} · 성장 ${best[3].toFixed(1)}% · 이익률 ${best[4].toFixed(1)}%` : ''; cv.style.cursor = best ? 'pointer' : 'default'; };
}
async function edaAi(box) {
  const { stats, rows } = edaStatsCache;
  const sum = {
    조회기업: RES.length, 조건: [...$$('#activeF .chip')].map(c => c.textContent.replace('✕', '').trim()),
    지표: Object.fromEntries(EDA_M.map(m => [m.l, { 기업수: stats[m.k].n, 중앙값: +nf(stats[m.k].med).replace(/,/g, '') || null, P10: +nf(stats[m.k].p10).replace(/,/g, '') || null, P90: +nf(stats[m.k].p90).replace(/,/g, '') || null }])),
    업종: rows.map(r => ({ 업종: META.industries[r.ind], 기업: r.c, 매출중앙: ok(r.rv) ? Math.round(r.rv) : null, 이익률: ok(r.mg) ? +r.mg.toFixed(1) : null, 연봉만: ok(r.sl) ? Math.round(r.sl) : null, 전망: ok(r.ou) ? Math.round(r.ou) : null })),
  };
  box.innerHTML = '<p class="tiny">Gemini AI가 분석 중입니다…</p>';
  try {
    const text = await callGemini(`다음은 한국 기업 조회 결과의 요약 통계입니다. 이 숫자만 근거로 B2B 영업·시장 분석 관점의 인사이트를 한국어로 5~7개 불릿(각 1~2문장)으로 쓰고, 마지막에 '추천 타깃' 1문장을 덧붙이세요. 숫자를 인용하고 데이터에 없는 내용은 쓰지 마세요.\n${JSON.stringify(sum)}`, false);
    if (!text) { box.innerHTML = '<p class="tiny">설정(⚙️)에서 Gemini API 키를 입력하면 AI 인사이트를 사용할 수 있습니다.</p>'; return; }
    box.innerHTML = `<div class="aitext">${esc(text).replace(/\n/g, '<br>')}</div>`;
  } catch (e) {
    box.innerHTML = `<p class="tiny">AI 인사이트 오류: ${esc(e.message)}</p>`;
  }
}
function initEda() {
  $('#eda').addEventListener('click', e => {
    const t = e.target;
    const m = t.closest('[data-edam]'); if (m) { EDA_SEL = m.dataset.edam; renderEda(); return; }
    const ind = t.closest('[data-edaind]'); if (ind) { const k = +ind.dataset.edaind; if (!S.ind.includes(k)) S.ind.push(k); run(); toast('업종 필터 추가'); return; }
    const li = t.closest('[data-edai]'); if (li) { openDetail(+li.dataset.edai); return; }
    if (t.closest('[data-eda-ai]')) edaAi($('#edaAi'));
  });
  $('#dbody').addEventListener('click', e => { const b = e.target.closest('[data-ai-rep]'); if (b) aiReport(+b.dataset.aiRep, $('#aiRep')); });
  window.addEventListener('resize', debounce(() => { if ($('#vEda').classList.contains('on') && EDA_SC) drawQuad(EDA_SC); }, 200));
  $('#aiSearchBtn').onclick = () => {
    const v = $('#q').value.trim();
    if (!v) { toast('검색창에 원하는 조건을 문장으로 입력하세요 (예: 부평구 직원 50명 이상 흑자 제조업)'); $('#q').focus(); return; }
    aiSearch(v);
  };
  $('#futPreset').onclick = () => { resetAll(); S.fut = true; S.sort = 'out'; run(); openFilter(false); if (isMobile()) setView('list'); toast(`🌱 미래 강소기업 후보 ${fmt(RES.length)}개`); };
  $('#salChips').innerHTML = SAL_B.map((b, k) => `<button class="chip" data-v="${k}">${b[0]}</button>`).join('');
  $('#salChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const v = +b.dataset.v; S.salB = S.salB.includes(v) ? S.salB.filter(x => x !== v) : [...S.salB, v]; run(); };
  $('#outChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; if (b.dataset.k) S[b.dataset.k] = !S[b.dataset.k]; else { const v = +b.dataset.o; S.outMin = S.outMin === v ? 0 : v; } run(); };
}
function anaSync() {
  $$('#salChips .chip').forEach(b => b.setAttribute('aria-pressed', S.salB.includes(+b.dataset.v)));
  $$('#outChips .chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.k ? !!S[b.dataset.k] : S.outMin === +b.dataset.o));
}

/* ==================== Enrich & Tags ==================== */
const EK = ['rev', 'rev_p1', 'rev_p2', 'op', 'op_p1', 'op_p2', 'ni', 'assets', 'equity', 'emp', 'avg_sal', 'tenure', 'nps_emp', 'nps_new', 'nps_lost', 'nps_wage'];
let EN = null, EN_META = null, TAGS = [], TAGM = null;
const REV_B = [['10억 미만', 0, 10], ['10~100억', 10, 100], ['100~1,000억', 100, 1000], ['1,000억~1조', 1000, 10000], ['1조 이상', 10000, 1e12]];
const EMP_B = [['10명 미만', 0, 10], ['10~49명', 10, 50], ['50~299명', 50, 300], ['300~999명', 300, 1000], ['1,000명 이상', 1000, 1e9]];
const TAG_COL = ['var(--c4)', 'var(--c7)', 'var(--c5)', 'var(--c6)', 'var(--c1)', 'var(--c3)', 'var(--c2)', 'var(--c8)'];
const ok = v => v === v && v !== undefined;
function fmtEok(v) { if (!ok(v)) return '-'; const e = v / 1e8, a = Math.abs(e); if (a >= 10000) return (e / 10000).toFixed(a >= 100000 ? 0 : 1) + '조'; if (a >= 1) return fmt(Math.round(e)) + '억'; return (Math.round(e * 100) / 100) + '억'; }
const empOf = i => !EN ? NaN : ok(EN.emp[i]) ? EN.emp[i] : EN.nps_emp[i];
const revEok = i => EN && ok(EN.rev[i]) ? EN.rev[i] / 1e8 : NaN;
const opMargin = i => EN && ok(EN.rev[i]) && ok(EN.op[i]) && EN.rev[i] > 0 ? EN.op[i] / EN.rev[i] * 100 : NaN;
const revGrowth = i => EN && ok(EN.rev[i]) && ok(EN.rev_p1[i]) && EN.rev_p1[i] > 0 ? (EN.rev[i] / EN.rev_p1[i] - 1) * 100 : NaN;
const hiring = i => EN && ok(EN.nps_new[i]) && EN.nps_new[i] >= Math.max(2, (ok(EN.nps_emp[i]) ? EN.nps_emp[i] : 0) * 0.03);

function applyEnrich(list, meta) {
  EN = {}; EK.forEach(k => EN[k] = new Float64Array(N).fill(NaN));
  let hit = 0, fy = '', ym = '';
  for (let [b, v] of list) {
    const i = BIZIDX.get(b); if (i === undefined) continue; hit++;
    if (Array.isArray(v)) { const o = {}; (BAKED && BAKED.cols || []).forEach((k, j) => { if (v[j] !== null) o[k] = v[j]; }); v = o; }
    EK.forEach(k => { if (v[k] !== undefined && v[k] !== null && v[k] !== '') EN[k][i] = +v[k]; });
    if (v.fin_year) fy = String(v.fin_year).replace(/\.0+$/, '');
    if (v.nps_ym) ym = v.nps_ym;
  }
  let fin = 0, emp = 0; for (let i = 0; i < N; i++) { if (ok(EN.rev[i])) fin++; if (ok(EN.emp[i]) || ok(EN.nps_emp[i])) emp++; }
  EN_META = Object.assign({}, meta, { hit, fin, emp, finYear: meta.finYear || fy, npsYm: meta.npsYm || ym });
}
async function importEnrich(file) {
  const rows = await readTable(file); if (rows.length < 2) throw new Error('내용이 없습니다');
  const head = rows[0].map(h => String(h).trim()); const bi = head.findIndex(h => /^b_no$|사업자/i.test(h));
  if (bi < 0) throw new Error('b_no(사업자번호) 열이 없습니다');
  const ci = {}; ['fin_year', 'nps_ym', ...EK].forEach(k => { ci[k] = head.indexOf(k); });
  if (EK.every(k => ci[k] < 0)) throw new Error('보강 항목 열(rev, emp, nps_emp 등)을 찾지 못했습니다');
  const prev = (await idb.get('enrich')) || { list: [] }; const m = new Map(prev.list);
  let n = 0;
  for (const r of rows.slice(1)) {
    const b = digits(String(r[bi] || '')); if (b.length !== 10) continue;
    const v = Object.assign({}, m.get(b) || {});
    for (const k in ci) { if (ci[k] < 0) continue; const x = String(r[ci[k]] ?? '').replace(/,/g, '').trim(); if (x !== '' && x !== 'nan') v[k] = k === 'fin_year' ? x.replace(/\.0+$/, '') : k === 'nps_ym' ? x : +x; }
    m.set(b, v); n++;
  }
  const list = [...m.entries()], meta = { file: file.name, date: todayStr() };
  applyEnrich(list, meta); IDB_OK = await idb.set('enrich', { list, meta }); buildAI(); buildAnalytics(); buildProMetrics(); return n;
}
function rebuildTagM() { TAGM = new Uint16Array(N); TAGS.forEach((t, k) => { if (k > 15) return; t.b.forEach(b => { const i = BIZIDX.get(b); if (i !== undefined) TAGM[i] |= (1 << k); }); }); }
let TAG_PENDING = null;
function tagMapUI(rows, fname) {
  const head = rows[0].map(h => String(h).trim()); TAG_PENDING = { head, body: rows.slice(1), fname };
  const g = { b: guessCol(head, [/사업자/, /b_no/i]), n: guessCol(head, [/기업명|회사명|업체명|사업장명|상호|법인명/]), a: guessCol(head, [/주소|소재지|지역|시도/]) };
  const opt = (sel, none) => `<option value="-1">${none}</option>` + head.map((h, k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(h || ('열' + (k + 1)))}</option>`).join('');
  const label = fname.replace(/\.(csv|xlsx?|txt)$/i, '').replace(/[_\-]?\d{6,8}$/, '').slice(0, 20);
  return `<div class="mapui"><div class="tiny" style="margin-bottom:8px">${esc(fname)} · ${fmt(rows.length - 1)}행</div>
   <label class="tiny">표시 이름<input class="inp" id="tgL" value="${esc(label)}"></label>
   <div class="row2" style="margin-top:8px"><label class="tiny">사업자번호<select class="inp" id="tgB">${opt(g.b, '없음')}</select></label><label class="tiny">기업명<select class="inp" id="tgN">${opt(g.n, '없음')}</select></label></div>
   <label class="tiny" style="margin-top:8px">주소/지역<select class="inp" id="tgA">${opt(g.a, '없음')}</select></label>
   <div style="display:flex;gap:8px;margin-top:10px"><button class="aibtn" data-act="tag-run" style="margin:0;flex:1">명단 적용</button><button class="iconbtn" data-act="tag-cancel" style="height:42px">취소</button></div></div>`;
}
async function runTag() {
  const P = TAG_PENDING; const bi = +$('#tgB').value, ni = +$('#tgN').value, ai = +$('#tgA').value, label = $('#tgL').value.trim() || '인증기업';
  if (bi < 0 && ni < 0) { toast('사업자번호나 기업명 열을 선택하세요'); return; }
  const byName = new Map(); if (ni >= 0) for (let i = 0; i < N; i++) { const k = norm(ROWS[i][0]); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); }
  const set = new Set(); let miss = 0, amb = 0;
  for (const r of P.body) {
    let i; const b = bi >= 0 ? digits(String(r[bi] || '')) : '';
    if (b.length === 10) i = BIZIDX.get(b);
    if (i === undefined && ni >= 0) {
      const c = byName.get(norm(String(r[ni] || ''))) || [];
      if (c.length === 1) i = c[0];
      else if (c.length > 1 && ai >= 0) { const a = String(r[ai] || '').replace(/\s/g, ''); const sido = a.slice(0, 2); const f = c.filter(j => ROWS[j][7].replace(/\s/g, '').startsWith(sido) || a && ROWS[j][7].replace(/\s/g, '').includes(a.slice(0, 6))); if (f.length === 1) i = f[0]; else amb++; }
      else if (c.length > 1) amb++;
    }
    if (i === undefined) { miss++; continue; }
    set.add(digits(ROWS[i][6]));
  }
  const ex = TAGS.findIndex(t => t.label === label);
  const t = { label, b: [...set], file: P.fname, total: P.body.length, miss, amb, date: todayStr() };
  if (ex >= 0) TAGS[ex] = t; else { if (TAGS.length >= 16) { toast('명단은 최대 16개까지'); return; } TAGS.push(t); }
  TAG_PENDING = null; rebuildTagM(); buildAnalytics(); IDB_OK = await idb.set('tags', TAGS); renderTagChips(); run(); renderSales();
  toast(`${label}: ${fmt(set.size)}개 기업 표시`);
}
function renderTagChips() {
  const el = $('#tagChips'); if (!el) return;
  el.innerHTML = TAGS.length ? TAGS.map((t, k) => `<button class="chip" data-v="${k}" aria-pressed="${S.tags.includes(k)}"><span class="dot" style="background:${TAG_COL[k % 8]}"></span>${esc(t.label)}</button>`).join('') : '<span class="tiny">[영업] 탭에서 명단을 올리면 표시됩니다</span>';
}
function enrichLine(i) {
  if (!EN) return ''; const p = [];
  if (ok(EN.rev[i])) p.push(`매출 ${fmtEok(EN.rev[i])}`);
  if (ok(EN.op[i])) p.push(`<span style="color:${EN.op[i] < 0 ? 'var(--c8)' : 'inherit'}">영업이익 ${fmtEok(EN.op[i])}</span>`);
  const e = empOf(i); if (ok(e)) p.push(`직원 ${fmt(Math.round(e))}명`);
  if (hiring(i)) p.push(`<span style="color:var(--c3)">최근 입사 ${fmt(EN.nps_new[i])}명</span>`);
  return p.length ? `<div class="enl num">${p.join(' · ')}</div>` : '';
}
function tagBadges(i) {
  if (!TAGM || !TAGM[i]) return ''; let h = '';
  TAGS.forEach((t, k) => { if (TAGM[i] & (1 << k)) h += `<span class="sb" style="background:color-mix(in srgb,${TAG_COL[k % 8]} 18%,transparent);color:var(--ink)">🏅 ${esc(t.label)}</span>`; });
  return h;
}
function finChart(vals, labels, unit) {
  const v = vals.map(x => ok(x) ? x : null); if (v.every(x => x === null)) return '';
  const mx = Math.max(1, ...v.map(x => Math.abs(x || 0))), hasNeg = v.some(x => x < 0);
  const H = 78, base = hasNeg ? H / 2 + 2 : H - 2, sc = (hasNeg ? H / 2 - 12 : H - 18) / mx;
  return `<svg viewBox="0 0 150 ${H + 16}" class="fch">${v.map((x, k) => {
    const xx = 12 + k * 46;
    if (x === null) return `<text x="${xx + 14}" y="${base - 4}" class="fl">-</text><text x="${xx + 14}" y="${H + 13}" class="fl">${labels[k]}</text>`;
    const h = Math.max(1.5, Math.abs(x) * sc), y = x >= 0 ? base - h : base;
    return `<rect x="${xx}" y="${y}" width="28" height="${h}" rx="3" style="fill:${x < 0 ? 'var(--c8)' : k === v.length - 1 ? 'var(--accent)' : 'var(--s3)'}"><title>${labels[k]}: ${fmt(Math.round(x))}${unit}</title></rect><text x="${xx + 14}" y="${x >= 0 ? y - 3 : y + h + 9}" class="fv">${Math.abs(x) >= 10000 ? (x / 10000).toFixed(1) + '조' : fmt(Math.round(x))}</text><text x="${xx + 14}" y="${H + 13}" class="fl">${labels[k]}</text>`;
  }).join('')}${hasNeg ? `<line x1="6" x2="146" y1="${base}" y2="${base}" style="stroke:var(--line-2)"/>` : ''}</svg>`;
}
function enrichSection(i) {
  const r = ROWS[i]; let h = '';
  if (EN && (ok(EN.rev[i]) || ok(EN.emp[i]) || ok(EN.nps_emp[i]))) {
    const fy = +EN_META.finYear || 0, yl = fy ? [String(fy - 2).slice(2) + '년', String(fy - 1).slice(2) + '년', String(fy).slice(2) + '년'] : ['전전기', '전기', '당기'];
    const m = opMargin(i), g = revGrowth(i);
    h += `<div class="sec"><h4>재무·인력 <span class="tiny">${ok(EN.rev[i]) ? `DART ${EN_META.finYear || ''}` : ''}${ok(EN.nps_emp[i]) ? ` · 국민연금 ${esc(String(EN_META.npsYm || ''))}` : ''}</span></h4><div class="sales"><div class="fkpi">
      ${ok(EN.rev[i]) ? `<div><span>매출액</span><b class="num">${fmtEok(EN.rev[i])}</b>${ok(g) ? `<em class="${g < 0 ? 'neg' : 'pos'}">${g >= 0 ? '▲' : '▼'} ${Math.abs(g).toFixed(1)}%</em>` : ''}</div>` : ''}
      ${ok(EN.op[i]) ? `<div><span>영업이익</span><b class="num${EN.op[i] < 0 ? ' negc' : ''}">${fmtEok(EN.op[i])}</b>${ok(m) ? `<em>이익률 ${m.toFixed(1)}%</em>` : ''}</div>` : ''}
      ${ok(EN.ni[i]) ? `<div><span>순이익</span><b class="num${EN.ni[i] < 0 ? ' negc' : ''}">${fmtEok(EN.ni[i])}</b></div>` : ''}
      ${ok(empOf(i)) ? `<div><span>직원수</span><b class="num">${fmt(Math.round(empOf(i)))}명</b><em>${ok(EN.emp[i]) ? '사업보고서' : '국민연금 가입자'}</em></div>` : ''}
      ${ok(EN.avg_sal[i]) ? `<div><span>1인 평균급여</span><b class="num">${(EN.avg_sal[i] / 1e7).toFixed(1)}천만원</b>${ok(EN.tenure[i]) ? `<em>근속 ${EN.tenure[i]}년</em>` : ''}</div>` : ''}
      ${ok(EN.equity[i]) && ok(EN.assets[i]) && EN.assets[i] > 0 ? `<div><span>부채비율</span><b class="num">${EN.equity[i] > 0 ? ((EN.assets[i] - EN.equity[i]) / EN.equity[i] * 100).toFixed(0) + '%' : '자본잠식'}</b></div>` : ''}
    </div>
    ${ok(EN.rev[i]) ? `<div class="fcharts"><div><div class="tiny">매출액 (억원)</div>${finChart([EN.rev_p2[i], EN.rev_p1[i], EN.rev[i]].map(x => ok(x) ? x / 1e8 : NaN), yl, '억')}</div><div><div class="tiny">영업이익 (억원)</div>${finChart([EN.op_p2[i], EN.op_p1[i], EN.op[i]].map(x => ok(x) ? x / 1e8 : NaN), yl, '억')}</div></div>` : ''}
    ${ok(EN.nps_emp[i]) ? `<div class="npsbox"><b>국민연금 ${esc(String(EN_META.npsYm || ''))}</b> 가입자 ${fmt(EN.nps_emp[i])}명 · 입사 <b style="color:var(--c3)">${fmt(EN.nps_new[i] || 0)}</b> · 퇴사 ${fmt(EN.nps_lost[i] || 0)}${ok(EN.nps_wage[i]) ? ` · 추정 월소득 ${fmt(Math.round(EN.nps_wage[i] / 1e4))}만원` : ''}</div>` : ''}
    </div></div>`;
  }
  const q = encodeURIComponent(r[0].replace(/\(주\)|㈜|주식회사/g, '').trim());
  h += `<div class="sec"><h4>채용정보 ${EN && ok(EN.nps_new[i]) ? (hiring(i) ? '<span class="sb s-act">채용 활발</span>' : '<span class="tiny">최근 입사 적음</span>') : ''}</h4><div class="linkrow">
    <a href="https://www.saramin.co.kr/zf_user/search?searchword=${q}" target="_blank" rel="noopener">사람인</a>
    <a href="https://www.jobkorea.co.kr/Search/?stext=${q}" target="_blank" rel="noopener">잡코리아</a>
    <a href="https://www.wanted.co.kr/search?query=${q}" target="_blank" rel="noopener">원티드</a>
    <a href="https://www.jobplanet.co.kr/search?query=${q}" target="_blank" rel="noopener">잡플래닛</a></div></div>`;
  if (TAGM && TAGM[i]) h = `<div class="sec"><h4>인증·선정</h4><div class="sbrow" style="display:flex">${tagBadges(i)}</div></div>` + h;
  return h;
}
function enrichCards() {
  const em = EN_META;
  let h = `<div class="card"><h3>③ 재무·인력 보강 (매출·영업이익·직원수)</h3><div class="sub">DART·국민연금 최신 데이터가 기본 내장되어 있으며, 새 보강 파일도 추가 업로드할 수 있습니다.</div>
  ${em ? `<div class="kv2"><span>파일</span><b>${esc(em.file)}</b><span>반영</span><b class="num">${fmt(em.hit)}개 기업</b><span>재무</span><b class="num">${fmt(em.fin)}개 (${esc(String(em.finYear || '-'))} 사업연도)</b><span>직원수</span><b class="num">${fmt(em.emp)}개${em.npsYm ? ` · 국민연금 ${esc(String(em.npsYm))}` : ''}</b></div>` : ''}
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><label class="aibtn" style="margin:0;flex:1;cursor:pointer">📂 보강 파일 올리기<input type="file" id="enFile" accept=".csv,.txt,.xlsx" hidden></label>${em ? '<button class="iconbtn" data-act="en-clear" style="height:42px">기본값 복원</button>' : ''}</div></div>`;
  h += `<div class="card"><h3>④ 강소기업·인증 명단</h3><div class="sub">청년일자리강소기업·부평산단·인천우수기업 명단이 기본 내장되어 있으며, 추가 명단도 올릴 수 있습니다.</div>
  ${TAGS.length ? `<div class="tagl">${TAGS.map((t, k) => `<div><span class="dot" style="background:${TAG_COL[k % 8]}"></span><b>${esc(t.label)}</b><span class="tiny num">${fmt(t.b.length)}개 매칭 / ${fmt(t.total)}행</span><button class="cp" data-act="tag-del" data-k="${k}">삭제</button></div>`).join('')}</div>` : ''}
  <div id="tagMap"></div>
  <label class="aibtn" style="margin:10px 0 0;cursor:pointer">📂 명단 파일 올리기<input type="file" id="tagFile" accept=".csv,.txt,.xlsx,.xls" hidden></label></div>`;
  return h;
}
async function enrichChange(t) {
  if (t.id === 'enFile' && t.files[0]) { try { const n = await importEnrich(t.files[0]); run(); renderSales(); toast(`보강 ${fmt(n)}건 반영`); } catch (e) { toast('가져오기 실패: ' + e.message); } t.value = ''; return true; }
  if (t.id === 'tagFile' && t.files[0]) { try { const rows = await readTable(t.files[0]); if (rows.length < 2) throw new Error('행이 없습니다'); $('#tagMap').innerHTML = tagMapUI(rows, t.files[0].name); } catch (e) { toast(e.message); } t.value = ''; return true; }
  return false;
}
async function enrichClick(a, b) {
  if (a === 'en-clear') { EN = null; EN_META = null; await idb.del('enrich'); if (BAKED) applyEnrich(BAKED.list, BAKED.meta); buildAI(); buildAnalytics(); buildProMetrics(); Object.assign(S, { revB: [], empB: [], prof: false, grow: false, hire: false }); run(); renderSales(); return true; }
  if (a === 'tag-run') { await runTag(); return true; }
  if (a === 'tag-cancel') { TAG_PENDING = null; $('#tagMap').innerHTML = ''; return true; }
  if (a === 'tag-del') { const k = +b.dataset.k; if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '한 번 더'; return true; } TAGS.splice(k, 1); S.tags = []; rebuildTagM(); buildAnalytics(); await idb.set('tags', TAGS); renderTagChips(); run(); renderSales(); return true; }
  return false;
}
async function initEnrich() {
  let ie = null; try { ie = await idb.get('enrich'); } catch {}
  if (ie) applyEnrich(ie.list, ie.meta); else if (BAKED) applyEnrich(BAKED.list, BAKED.meta);
  let it = null; try { it = await idb.get('tags'); } catch {}
  if (Array.isArray(it)) TAGS = it; else if (BAKED && BAKED.tags) TAGS = BAKED.tags;
  rebuildTagM();
  $('#revChips').innerHTML = REV_B.map((b, k) => `<button class="chip" data-v="${k}" aria-pressed="false">${b[0]}</button>`).join('');
  $('#empChips').innerHTML = EMP_B.map((b, k) => `<button class="chip" data-v="${k}" aria-pressed="false">${b[0]}</button>`).join('');
  const tog = key => e => { const b = e.target.closest('.chip'); if (!b) return; const v = +b.dataset.v; S[key] = S[key].includes(v) ? S[key].filter(x => x !== v) : [...S[key], v]; run(); };
  $('#revChips').onclick = tog('revB'); $('#empChips').onclick = tog('empB'); $('#tagChips').onclick = tog('tags');
  $('#perfChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S[b.dataset.k] = !S[b.dataset.k]; run(); };
  renderTagChips();
}
function enrichSyncChips() {
  $$('#revChips .chip').forEach(b => b.setAttribute('aria-pressed', S.revB.includes(+b.dataset.v)));
  $$('#empChips .chip').forEach(b => b.setAttribute('aria-pressed', S.empB.includes(+b.dataset.v)));
  $$('#perfChips .chip').forEach(b => b.setAttribute('aria-pressed', !!S[b.dataset.k]));
  $$('#tagChips .chip').forEach(b => b.setAttribute('aria-pressed', S.tags.includes(+b.dataset.v)));
  const hint = $('#enHint'); if (hint) hint.hidden = !!EN;
}
function enrichStats(n) {
  if (!EN) return ''; const rc = REV_B.map(() => 0), ec = EMP_B.map(() => 0); let rn = 0, en = 0, prof = 0, hire = 0;
  for (let k = 0; k < n; k++) {
    const i = RES[k]; const r = revEok(i); if (ok(r)) { rn++; rc[REV_B.findIndex(b => r >= b[1] && r < b[2])]++; if (EN.op[i] > 0) prof++; }
    const e = empOf(i); if (ok(e)) { en++; ec[EMP_B.findIndex(b => e >= b[1] && e < b[2])]++; }
    if (hiring(i)) hire++;
  }
  const bar = (arr, lab, key) => { const mx = Math.max(1, ...arr); return `<div class="hbar">${arr.map((v, k) => `<div class="r" data-${key}="${k}"><span class="l">${lab[k][0]}</span><span class="t"><i style="width:${v / mx * 100}%"></i></span><span class="n">${fmt(v)}</span></div>`).join('')}</div>`; };
  return `<div class="card"><h3>매출 규모</h3><div class="sub">재무 확보 ${fmt(rn)}개 · 흑자 ${fmt(prof)}개${rn ? ` (${(prof / rn * 100).toFixed(0)}%)` : ''} · 누르면 필터</div>${bar(rc, REV_B, 'revb')}</div>
  <div class="card"><h3>직원 규모</h3><div class="sub">직원수 확보 ${fmt(en)}개 · 채용 활발 ${fmt(hire)}개 · 누르면 필터</div>${bar(ec, EMP_B, 'empb')}</div>`;
}

/* ==================== Sales Module (Status, Customers, Branches) ==================== */
const STAT_LBL = ['미확인', '계속', '휴업', '폐업', '미등록'];
const CUST_LBL = ['신규대상', '기존고객', '해지고객'];
let STAT = null, STAT_META = null, CUST = null, CUST_INFO = new Map(), CUST_META = null, BIZIDX = null, NAMEIDX = null;
let BR = [], RID_BR = null, MAPMODE = 'precision', ASSIGN = -1, VW_MAIN = null;
const BR_COL = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

function buildBizIdx() {
  BIZIDX = new Map(); NAMEIDX = new Map();
  for (let i = 0; i < N; i++) {
    const b = digits(ROWS[i][6]); if (b.length === 10 && !BIZIDX.has(b)) BIZIDX.set(b, i);
    const n = norm(ROWS[i][0]); NAMEIDX.set(n, NAMEIDX.has(n) ? -1 : i);
  }
}
function decodeText(buf) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); } catch { return new TextDecoder('euc-kr').decode(buf); } }
function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  const sep = (t.split('\n')[0].split('\t').length > t.split('\n')[0].split(',').length) ? '\t' : ',';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}
let XLSX_P = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return XLSX_P || (XLSX_P = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('엑셀 라이브러리를 불러오지 못했습니다 (인터넷 연결 확인 또는 CSV로 업로드하세요)'));
    document.head.appendChild(s);
  }));
}
async function readTable(file) {
  const buf = await file.arrayBuffer();
  if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
    const X = await loadXLSX(); const wb = X.read(buf, { type: 'array' });
    for (const n of wb.SheetNames) { const a = X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }); const hi = findHeader(a); if (hi >= 0) return a.slice(hi); }
    return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }
  const rows = parseCSV(decodeText(buf)); const hi = findHeader(rows); return hi > 0 ? rows.slice(hi) : rows;
}
function findHeader(rows) { for (let i = 0; i < Math.min(rows.length, 15); i++) { if (rows[i].some(c => /사업자|b_no/i.test(String(c)))) return i; } return -1; }
function guessCol(head, res) { return head.findIndex(h => res.some(re => re.test(String(h).replace(/\s/g, '')))); }

function statCode(cd, txt) {
  cd = String(cd || '').trim(); txt = String(txt || '');
  if (cd === '01' || cd === '1') return 1; if (cd === '02' || cd === '2') return 2; if (cd === '03' || cd === '3') return 3;
  if (/폐업/.test(txt)) return 3; if (/휴업/.test(txt)) return 2; if (/등록되지|미등록/.test(txt)) return 4; if (/계속|과세자|면세|영업/.test(txt)) return 1;
  return cd === '' && txt ? 4 : 0;
}
function applyBakedStatus(bs) {
  if (!bs || !bs.codesB64) return;
  STAT = b64ToBytes(bs.codesB64);
  STAT_META = bs.meta;
}
function applyStatus(list, meta) {
  STAT = new Uint8Array(N); let hit = 0; const cnt = [0, 0, 0, 0, 0];
  for (const [b, c] of list) { const i = BIZIDX.get(b); if (i !== undefined && c) { STAT[i] = c; hit++; cnt[c]++; } }
  STAT_META = Object.assign({}, meta, { hit, cnt });
}
async function importStatus(file) {
  const rows = await readTable(file); if (rows.length < 2) throw new Error('내용이 없습니다');
  const head = rows[0], bi = guessCol(head, [/^b_no$/i, /사업자/]), ci = guessCol(head, [/b_stt_cd/i, /상태코드/]), ti = guessCol(head, [/^b_stt$/i, /납세자상태|사업자상태|상태/]);
  if (bi < 0) throw new Error('사업자번호 열을 찾지 못했습니다');
  const di = guessCol(head, [/^checked$/i, /조회일/]);
  const list = []; let date = '';
  for (const r of rows.slice(1)) { const b = digits(String(r[bi] || '')); if (b.length !== 10) continue; list.push([b, statCode(ci >= 0 ? r[ci] : '', ti >= 0 ? r[ti] : '')]); if (di >= 0 && r[di]) date = String(r[di]); }
  const prev = (await idb.get('status')) || null;
  const m = new Map(prev && prev.list || []); list.forEach(([b, c]) => m.set(b, c)); const merged = [...m.entries()];
  const meta = { date: date || todayStr(), file: file.name, rows: list.length };
  applyStatus(merged, meta); IDB_OK = await idb.set('status', { list: merged, meta }); buildProMetrics();
  return list.length;
}

/* ---- Customer Matching ---- */
let CUST_PENDING = null;
function custClass(v) { return /해지|이탈|탈퇴|종료|취소|철거|폐/.test(String(v || '')) ? 2 : 1; }
function applyCust(recs, meta) {
  CUST = new Uint8Array(N); CUST_INFO = new Map(); let hit = 0, miss = 0, byName = 0; const missList = [];
  for (const r of recs) {
    let i = r.b ? BIZIDX.get(r.b) : undefined;
    if (i === undefined && meta.nameMatch && r.n) { const j = NAMEIDX.get(norm(r.n)); if (j !== undefined && j >= 0) { i = j; byName++; } }
    if (i === undefined) { miss++; if (missList.length < 30) missList.push(r.n || r.b); continue; }
    hit++; CUST[i] = CUST[i] === 1 ? 1 : (r.s === 1 ? 1 : Math.max(CUST[i], r.s));
    if (!CUST_INFO.has(i)) CUST_INFO.set(i, []); const L = CUST_INFO.get(i); if (L.length < 5) L.push(r);
  }
  CUST_META = Object.assign({}, meta, { hit, miss, byName, missList, companies: CUST_INFO.size, active: [...CUST].filter(v => v === 1).length, churn: [...CUST].filter(v => v === 2).length });
}
function custMapUI(rows, fname) {
  const head = rows[0].map(h => String(h).trim()), body = rows.slice(1);
  const g = { b: guessCol(head, [/사업자/, /b_no/i]), n: guessCol(head, [/고객명|상호|회사|법인명|업체/]), s: guessCol(head, [/상태|유지|해지|구분|계약/]), br: guessCol(head, [/지사|관할|담당/]) };
  const opt = (sel, none) => `<option value="-1">${none}</option>` + head.map((h, k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(h || ('열' + (k + 1)))}</option>`).join('');
  CUST_PENDING = { head, body, fname };
  return `<div class="mapui"><div class="tiny" style="margin-bottom:8px">${esc(fname)} · ${fmt(body.length)}행</div>
   <div class="row2"><label class="tiny">사업자번호<select class="inp" id="cmB">${opt(g.b, '선택')}</select></label><label class="tiny">고객명<select class="inp" id="cmN">${opt(g.n, '없음')}</select></label>
   <label class="tiny">유지/해지 상태<select class="inp" id="cmS">${opt(g.s, '없음 (모두 기존고객)')}</select></label><label class="tiny">지사<select class="inp" id="cmBr">${opt(g.br, '없음')}</select></label></div>
   <div id="cmPrev" class="tiny" style="margin:8px 0;line-height:1.5"></div>
   <label class="toggle"><input type="checkbox" id="cmName"> 사업자번호 없으면 회사명으로 대조</label>
   <div style="display:flex;gap:8px;margin-top:10px"><button class="aibtn" data-act="cust-run" style="margin:0;flex:1">대조 실행</button><button class="iconbtn" data-act="cust-cancel" style="height:42px">취소</button></div></div>`;
}
function custPreview() {
  const P = CUST_PENDING, si = +$('#cmS').value, bi = +$('#cmB').value; let h = '';
  if (bi >= 0) { const cnt = P.body.filter(r => digits(String(r[bi] || '')).length === 10).length; h += `유효 사업자번호 <b>${fmt(cnt)}</b> / ${fmt(P.body.length)}행<br>`; }
  if (si >= 0) {
    const m = new Map(); P.body.forEach(r => { const v = String(r[si] || '').trim() || '(빈칸)'; m.set(v, (m.get(v) || 0) + 1); });
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    h += '상태 분류: ' + top.map(([v, c]) => `<span class="tag ${custClass(v) === 2 ? 'c2' : 'c1'}" style="margin:2px 2px 0 0;display:inline-block">${esc(v)} ${fmt(c)} → ${custClass(v) === 2 ? '해지' : '유지'}</span>`).join('');
  }
  $('#cmPrev').innerHTML = h;
}
async function runCust() {
  const P = CUST_PENDING, bi = +$('#cmB').value, ni = +$('#cmN').value, si = +$('#cmS').value, bri = +$('#cmBr').value, nameMatch = $('#cmName').checked;
  if (bi < 0 && !(nameMatch && ni >= 0)) { toast('사업자번호 열을 선택하세요'); return; }
  const recs = [];
  for (const r of P.body) {
    const b = bi >= 0 ? digits(String(r[bi] || '')) : '', n = ni >= 0 ? String(r[ni] || '').trim() : '';
    if (b.length !== 10 && !(nameMatch && n)) continue;
    recs.push({ b: b.length === 10 ? b : '', n, s: si >= 0 ? custClass(r[si]) : 1, sv: si >= 0 ? String(r[si] || '').trim() : '', br: bri >= 0 ? String(r[bri] || '').trim() : '' });
  }
  const meta = { file: P.fname, rows: recs.length, nameMatch, date: todayStr() };
  applyCust(recs, meta); IDB_OK = await idb.set('cust', { recs, meta }); CUST_PENDING = null; run(); renderSales();
  toast(`대조 완료 · ${fmt(CUST_META.companies)}개 기업 매칭`);
}

/* ---- Branches ---- */
const BR_DRAFT = [
  ['중앙', '11', ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구']],
  ['강북', '11', ['성북구', '강북구', '도봉구', '노원구']],
  ['서대문', '11', ['서대문구', '은평구', '마포구']],
  ['고양', '31', ['고양시', '파주시']],
  ['의정부', '31', ['의정부시', '양주시', '동두천시', '포천시', '연천군']],
  ['남양주', '31', ['남양주시', '구리시', '가평군']],
  ['강릉', '32', ['강릉시', '동해시', '삼척시', '태백시', '속초시', '고성군', '양양군', '정선군']],
  ['원주', '32', ['원주시', '횡성군', '영월군', '평창군', '홍천군', '춘천시', '철원군', '화천군', '양구군', '인제군']],
];
function draftBranches() { return BR_DRAFT.map(([n, sd, list]) => ({ name: n, rids: list.map(x => MAP.regions.find(r => r.sd === sd && r.n === x)).filter(Boolean).map(r => r.id) })); }
function applyBranches() { RID_BR = new Int8Array(MAP.regions.length).fill(-1); BR.forEach((b, k) => b.rids.forEach(r => { RID_BR[r] = k; })); }
const rowBr = i => { const r = ROWS[i][15]; return r >= 0 && RID_BR ? RID_BR[r] : -1; };
async function saveBranches() { applyBranches(); IDB_OK = await idb.set('branches', BR); }

async function initSales() {
  buildBizIdx();
  let st = null; try { st = await idb.get('status'); } catch {}
  if (st) applyStatus(st.list, st.meta); else if (BAKED_STATUS) applyBakedStatus(BAKED_STATUS);
  try { const c = await idb.get('cust'); if (c) applyCust(c.recs, c.meta); } catch {}
  let sb; try { sb = await idb.get('branches'); } catch {}
  if (Array.isArray(sb) && sb.length) BR = sb; else { BR = draftBranches(); BR.isDraft = true; }
  applyBranches();

  $('#custChips').innerHTML = CUST_LBL.map((l, k) => `<button class="chip" data-v="${k}" aria-pressed="false">${l}</button>`).join('');
  $('#statChips').innerHTML = [1, 2, 3, 4, 0].map(k => `<button class="chip" data-v="${k}" aria-pressed="false">${STAT_LBL[k]}</button>`).join('');
  const tog = key => e => { const b = e.target.closest('.chip'); if (!b) return; const v = +b.dataset.v; S[key] = S[key].includes(v) ? S[key].filter(x => x !== v) : [...S[key], v]; run(); };
  $('#custChips').onclick = tog('cust'); $('#statChips').onclick = tog('stat'); $('#brChips').onclick = tog('br');
  $('#salesPreset').onclick = () => { S.cust = [0]; S.stat = [1]; if (S.sort === 'rel') S.sort = 'ai'; run(); openFilter(false); if (isMobile()) setView('list'); toast(`신규 영업 대상(계속사업자) ${fmt(RES.length)}개`); };
  $('#mapMode').onclick = e => { const b = e.target.closest('button'); if (!b) return; MAPMODE = b.dataset.m; if (MAPMODE !== 'branch') ASSIGN = -1; renderMap(); if (MAPMODE === 'branch') zoomBranches(); };
  $('#vSales').addEventListener('click', salesClick);
  $('#vSales').addEventListener('change', salesChange);
  await initEnrich(); buildAI(); buildAnalytics(); buildProMetrics(); initEda();
  renderBrChips(); renderSales();
}
function renderBrChips() { $('#brChips').innerHTML = BR.map((b, k) => `<button class="chip" data-v="${k}" aria-pressed="${S.br.includes(k)}"><span class="dot" style="background:${BR_COL[k % 8]}"></span>${esc(b.name)}</button>`).join('') + `<button class="chip" data-v="-1" aria-pressed="${S.br.includes(-1)}">관할 외</button>`; }

function renderSales() {
  const el = $('#sales'); if (!el) return;
  const nb = BR.length, T = Array.from({ length: nb + 1 }, () => ({ all: 0, ai: 0, neu: 0, act: 0, churn: 0, closed: 0 }));
  for (let k = 0; k < RES.length; k++) {
    const i = RES[k], b = rowBr(i), t = T[b < 0 ? nb : b]; t.all++; if (AI_S[i] >= 70) t.ai++;
    const c = CUST ? CUST[i] : 0; if (c === 1) t.act++; else if (c === 2) t.churn++;
    const st = STAT ? STAT[i] : 0; if (st === 2 || st === 3) t.closed++; else if (c === 0 && st !== 4) t.neu++;
  }
  const sm = STAT_META, cm = CUST_META;
  let h = `<div class="card"><h3>지사별 현황 <span class="tiny">현재 조회 조건 기준</span></h3><div class="sub">행을 누르면 해당 지사로 필터</div>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>지사</th><th>시군구</th><th>기업</th><th>AI 70+</th><th>신규대상</th><th>기존</th><th>해지</th><th>휴·폐업</th></tr></thead><tbody>
  ${BR.map((b, k) => `<tr data-br="${k}"><td><span class="dot" style="background:${BR_COL[k % 8]}"></span> ${esc(b.name)}</td><td class="num">${b.rids.length}</td><td class="num">${fmt(T[k].all)}</td><td class="num">${fmt(T[k].ai)}</td><td class="num"><b>${fmt(T[k].neu)}</b></td><td class="num">${CUST ? fmt(T[k].act) : '-'}</td><td class="num">${CUST ? fmt(T[k].churn) : '-'}</td><td class="num">${STAT ? fmt(T[k].closed) : '-'}</td></tr>`).join('')}
  <tr data-br="-1" class="muted"><td>관할 외</td><td></td><td class="num">${fmt(T[nb].all)}</td><td class="num">${fmt(T[nb].ai)}</td><td class="num">${fmt(T[nb].neu)}</td><td class="num">${CUST ? fmt(T[nb].act) : '-'}</td><td class="num">${CUST ? fmt(T[nb].churn) : '-'}</td><td class="num">${STAT ? fmt(T[nb].closed) : '-'}</td></tr>
  </tbody></table></div>
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="iconbtn sm" data-act="br-edit">✎ 지사 편집</button><button class="iconbtn sm" data-act="br-map">🗺 지도 관할</button><button class="iconbtn sm" data-act="br-export">설정 복사</button><button class="iconbtn sm" data-act="br-import">붙여넣기</button></div>
  <div id="brEditor"></div></div>`;
  h += `<div class="card"><h3>① 고객 명단 대조</h3><div class="sub">CSV·엑셀(사업자번호 포함)을 올리면 기존/해지 고객을 구분합니다. 파일은 이 브라우저 안에서만 처리·저장됩니다.</div>
  ${cm ? `<div class="kv2"><span>파일</span><b>${esc(cm.file)}</b><span>명단</span><b class="num">${fmt(cm.rows)}건</b><span>매칭 기업</span><b class="num">${fmt(cm.companies)}개 (기존 ${fmt(cm.active)} · 해지 ${fmt(cm.churn)})</b><span>미매칭</span><b class="num">${fmt(cm.miss)}건</b></div>` : ''}
  <div id="custMap"></div>
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><label class="aibtn" style="margin:0;flex:1;cursor:pointer">📂 고객 명단 올리기<input type="file" id="custFile" accept=".csv,.txt,.xlsx,.xls,.xlsm" hidden></label>${cm ? '<button class="iconbtn" data-act="cust-clear" style="height:42px">지우기</button>' : ''}</div></div>`;
  h += `<div class="card"><h3>② 사업자 휴·폐업 상태</h3><div class="sub">국세청 사업자 상태(계속/휴업/폐업)가 기본 내장되어 있습니다.</div>
  ${sm ? `<div class="kv2"><span>기준</span><b>${esc(String(sm.date))} · ${esc(sm.file)}</b><span>반영</span><b class="num">${fmt(sm.hit)}개 기업</b><span>상태</span><b class="num">계속 ${fmt(sm.cnt[1])} · 휴업 ${fmt(sm.cnt[2])} · 폐업 ${fmt(sm.cnt[3])}</b></div>` : ''}
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><label class="aibtn" style="margin:0;flex:1;cursor:pointer">📂 최신 상태 파일 올리기<input type="file" id="statFile" accept=".csv,.txt,.xlsx,.xls" hidden></label>${sm ? '<button class="iconbtn" data-act="stat-clear" style="height:42px">기본값 복원</button>' : ''}</div></div>`;
  h += enrichCards();
  el.innerHTML = h;
  if (TAG_PENDING) $('#tagMap').innerHTML = tagMapUI([TAG_PENDING.head, ...TAG_PENDING.body], TAG_PENDING.fname);
  if (CUST_PENDING) { $('#custMap').innerHTML = custMapUI([CUST_PENDING.head, ...CUST_PENDING.body], CUST_PENDING.fname); custPreview(); }
}

async function salesChange(e) {
  const t = e.target;
  if (await enrichChange(t)) return;
  if (t.id === 'custFile' && t.files[0]) { try { const rows = await readTable(t.files[0]); if (rows.length < 2) throw new Error('행이 없습니다'); $('#custMap').innerHTML = custMapUI(rows, t.files[0].name); custPreview(); } catch (err) { toast(err.message); } t.value = ''; }
  else if (t.id === 'statFile' && t.files[0]) { try { const n = await importStatus(t.files[0]); run(); renderSales(); toast(`상태 ${fmt(n)}건 반영`); } catch (err) { toast('가져오기 실패: ' + err.message); } t.value = ''; }
  else if (['cmB', 'cmS'].includes(t.id)) custPreview();
  else if (t.dataset && t.dataset.brname !== undefined) { BR[+t.dataset.brname].name = t.value.trim() || BR[+t.dataset.brname].name; delete BR.isDraft; await saveBranches(); renderBrChips(); run(); }
  else if (t.dataset && t.dataset.braddsel !== undefined && t.value !== '') { assignRegion(+t.dataset.braddsel, +t.value); t.value = ''; }
}
async function assignRegion(k, id) {
  BR.forEach((b, j) => { if (j !== k) b.rids = b.rids.filter(r => r !== id); });
  const b = BR[k]; b.rids = b.rids.includes(id) ? b.rids.filter(r => r !== id) : [...b.rids, id];
  delete BR.isDraft; await saveBranches(); run(); if ($('#brEditor').innerHTML) openBrEditor();
}
async function salesClick(e) {
  const tr = e.target.closest('tr[data-br]');
  if (tr) { S.br = [+tr.dataset.br]; run(); toast(`${tr.dataset.br === '-1' ? '관할 외' : BR[+tr.dataset.br].name} · ${fmt(RES.length)}개`); if (isMobile()) setView('list'); return; }
  const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
  if (await enrichClick(a, b)) return;
  if (a === 'cust-clear') { CUST = null; CUST_META = null; CUST_INFO = new Map(); await idb.del('cust'); S.cust = []; run(); renderSales(); }
  else if (a === 'stat-clear') { STAT = null; STAT_META = null; await idb.del('status'); if (BAKED_STATUS) applyBakedStatus(BAKED_STATUS); buildProMetrics(); S.stat = []; run(); renderSales(); }
  else if (a === 'br-edit') openBrEditor();
  else if (a === 'br-map') { MAPMODE = 'branch'; renderMap(); zoomBranches(); setSide('map'); if (isMobile()) setView('map'); }
  else if (a === 'br-export') copy(JSON.stringify(BR.map(x => ({ name: x.name, regions: x.rids.map(r => regName(r)) }))), '지사 관할 설정을 복사했습니다');
  else if (a === 'br-import') $('#brEditor').innerHTML = `<div class="mapui"><textarea class="inp" id="brJson" style="height:120px;padding:8px" placeholder='[{"name":"강북","regions":["서울 강북구"]}]'></textarea><div style="display:flex;gap:8px;margin-top:8px"><button class="aibtn" data-act="br-import-run" style="margin:0;flex:1">적용</button><button class="iconbtn" data-act="br-close" style="height:42px">닫기</button></div></div>`;
  else if (a === 'br-import-run') { try { const j = JSON.parse($('#brJson').value); const nameToId = new Map(MAP.regions.map(r => [regName(r.id), r.id])); BR = j.map(x => ({ name: String(x.name), rids: (x.regions || []).map(n => nameToId.get(n)).filter(v => v !== undefined) })); await saveBranches(); renderBrChips(); S.br = []; run(); toast(`지사 ${BR.length}개 적용`); } catch { toast('형식이 올바르지 않습니다'); } }
  else if (a === 'br-close') $('#brEditor').innerHTML = '';
  else if (a === 'br-add') { BR.push({ name: '새 지사 ' + (BR.length + 1), rids: [] }); delete BR.isDraft; await saveBranches(); renderBrChips(); renderSales(); openBrEditor(); }
  else if (a === 'br-del') { const k = +b.dataset.k; if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '한 번 더'; return; } BR.splice(k, 1); delete BR.isDraft; await saveBranches(); S.br = []; renderBrChips(); run(); openBrEditor(); }
  else if (a === 'br-rm') await assignRegion(+b.dataset.k, +b.dataset.r);
  else if (a === 'br-assign') { ASSIGN = +b.dataset.k; MAPMODE = 'branch'; renderMap(); setSide('map'); if (isMobile()) setView('map'); toast(`${BR[ASSIGN].name} 관할 지정 중 — 지도에서 시군구를 누르세요`); }
  else if (a === 'br-reset') { BR = draftBranches(); BR.isDraft = true; await idb.del('branches'); applyBranches(); renderBrChips(); S.br = []; run(); openBrEditor(); }
  else if (a === 'cust-run') runCust();
  else if (a === 'cust-cancel') { CUST_PENDING = null; $('#custMap').innerHTML = ''; }
}
function openBrEditor() {
  const opts = MAP.sidos.map(s => `<optgroup label="${s.n}">${MAP.regions.filter(r => r.sd === s.sd).sort((a, b) => a.n.localeCompare(b.n, 'ko')).map(r => `<option value="${r.id}">${esc(r.n)}${RID_BR[r.id] >= 0 ? ' · ' + esc(BR[RID_BR[r.id]].name) : ''}</option>`).join('')}</optgroup>`).join('');
  $('#brEditor').innerHTML = `<div class="mapui">${BR.map((b, k) => `<div class="bred"><div style="display:flex;gap:6px;align-items:center"><span class="dot" style="background:${BR_COL[k % 8]};width:12px;height:12px"></span><input class="inp" data-brname="${k}" value="${esc(b.name)}" style="height:34px;flex:1"><button class="iconbtn sm" data-act="br-assign" data-k="${k}">지도 지정</button><button class="iconbtn sm" data-act="br-del" data-k="${k}">삭제</button></div>
    <div class="chips" style="margin:6px 0">${b.rids.map(r => `<button class="chip" data-act="br-rm" data-k="${k}" data-r="${r}" aria-pressed="false">${esc(regName(r))} <span class="x">✕</span></button>`).join('') || '<span class="tiny">지정된 시군구 없음</span>'}</div>
    <select class="inp" data-braddsel="${k}" style="height:34px"><option value="">+ 시군구 추가</option>${opts}</select></div>`).join('')}
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="iconbtn sm" data-act="br-add">+ 지사 추가</button><button class="iconbtn sm" data-act="br-reset">초안 복원</button><button class="iconbtn sm" data-act="br-close">닫기</button></div></div>`;
}
function salesSection(i) {
  const b = rowBr(i), c = CUST ? CUST[i] : 0, st = STAT ? STAT[i] : 0, info = CUST_INFO.get(i) || [];
  return `<div class="sec"><h4>영업 정보</h4><div class="sales"><dl class="kv" style="margin:0">
    <dt>담당 지사</dt><dd><span>${b >= 0 ? `<span class="dot" style="background:${BR_COL[b % 8]}"></span> ${esc(BR[b].name)}` : '관할 외'}</span></dd>
    <dt>고객 구분</dt><dd><span>${CUST ? `<b>${CUST_LBL[c]}</b>` : '<span class="muted">고객 명단 미등록</span>'}${info.length ? '<br>' + info.map(x => `<span class="tiny">${esc(x.n || '')}${x.sv ? ' · ' + esc(x.sv) : ''}</span>`).join('<br>') : ''}</span></dd>
    <dt>사업자 상태</dt><dd><span>${STAT ? `<b class="st st${st}">${STAT_LBL[st]}</b> <span class="tiny">${esc(String(STAT_META.date || ''))} 기준</span>` : '<span class="muted">상태 미반영</span>'}</span></dd>
  </dl></div></div>`;
}
function salesBadges(i) {
  let h = '';
  if (CUST) { const c = CUST[i]; if (c === 1) h += '<span class="sb s-act">기존고객</span>'; else if (c === 2) h += '<span class="sb s-churn">해지고객</span>'; }
  if (STAT) { const s = STAT[i]; if (s === 2) h += '<span class="sb s-close">휴업</span>'; else if (s === 3) h += '<span class="sb s-close">폐업</span>'; else if (s === 4) h += '<span class="sb s-close">미등록</span>'; }
  const b = rowBr(i); if (b >= 0) h += `<span class="sb s-br"><span class="dot" style="background:${BR_COL[b % 8]}"></span>${esc(BR[b].name)}</span>`;
  return h;
}
function paintBranch() {
  REG_EL.forEach((p, id) => { const b = RID_BR[id]; p.style.fill = b >= 0 ? BR_COL[b % 8] : 'var(--zero)'; p.style.fillOpacity = b >= 0 ? (REG_CNT[id] ? 1 : .45) : 1; p.classList.toggle('selr', ASSIGN >= 0 && b === ASSIGN); });
  const cnt = BR.map(() => 0); REG_CNT.forEach((v, id) => { const b = RID_BR[id]; if (b >= 0) cnt[b] += v; });
  $('#legend').innerHTML = `<div class="ttl">지사 관할 · 조회 기업 수</div><div class="brlg">${BR.map((b, k) => `<span><span class="dot" style="background:${BR_COL[k % 8]}"></span>${esc(b.name)} <b class="num">${fmt(cnt[k])}</b></span>`).join('')}</div>`;
  $('#assignBar').hidden = ASSIGN < 0;
  if (ASSIGN >= 0) {
    $('#assignBar').innerHTML = `<span><span class="dot" style="background:${BR_COL[ASSIGN % 8]}"></span> <b>${esc(BR[ASSIGN].name)}</b> 관할 지정 중</span><button class="iconbtn sm" id="assignDone">완료</button>`;
    $('#assignDone').onclick = () => { ASSIGN = -1; renderMap(); setSide('sales'); if (isMobile()) setView('sales'); openBrEditor(); };
  }
}
function zoomBranches() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, c = 0;
  BR.forEach(b => b.rids.forEach(r => { const q = MAP.regions[r].b; c++; x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[2]); y1 = Math.max(y1, q[3]); }));
  if (c) zoomToBox([x0, y0, x1, y1], .12);
}
function branchLabels(fs) {
  let h = '';
  BR.forEach(b => {
    if (!b.rids.length) return;
    let x = 0, y = 0; b.rids.forEach(r => { x += MAP.regions[r].c[0]; y += MAP.regions[r].c[1]; });
    x /= b.rids.length; y /= b.rids.length;
    h += `<text class="mlabel" x="${x}" y="${y}" style="font-size:${fs * .7}px">${esc(b.name)}</text>`;
  });
  return h;
}

/* ==================== Pro Quant TOP 10 · Custom ICP · Compare · Presets ==================== */
const CRED_LBL = ['', 'AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'D'];
const CRED_CLS = ['', 'g-aaa', 'g-aa', 'g-a', 'g-bbb', 'g-bb', 'g-b', 'g-ccc', 'g-d'];
const HR_LBL = ['', '🚀 급성장 채용', '💎 안정 우수', '⚡ 고이직(회전문)', '⚠ 인력이탈'];
const PRO_PRESETS = {
  balanced: { name: '균형 기본', w: { size: 20, profit: 20, growth: 20, hiring: 15, ai: 15, safety: 10 } },
  aisales:  { name: 'AI·보안 영업', w: { size: 15, profit: 15, growth: 15, hiring: 15, ai: 35, safety: 5 } },
  growth:   { name: '고성장 강소', w: { size: 10, profit: 15, growth: 35, hiring: 25, ai: 10, safety: 5 } },
  enterprise:{ name: '대형·고매출', w: { size: 40, profit: 20, growth: 10, hiring: 10, ai: 10, safety: 10 } },
  safe:     { name: '우량·안정형', w: { size: 15, profit: 25, growth: 10, hiring: 5, ai: 10, safety: 35 } },
};
let PRO_W = Object.assign({}, PRO_PRESETS.balanced.w, store.get('proW', {}));
let PRESETS = store.get('presets', []);
let CMP = []; // compared company indices (max 5)

let Z_SCR = null, CRED_G = null, ZOMBIE = null;
let CAGR = null, PAT = null, RULE40 = null;
let ROE = null, ROA = null, ATURN = null, LEV = null, PAY_EFF = null;
let RPE = null, OPPE = null;
let HR_REG = null, NET_R = null;
let IND_PCT = null, IND_BUCKETS = null;
let LEAD = null;
let NAT_IND_CNT = null;

function bsearchPct(sortedArr, val) {
  if (!sortedArr || sortedArr.length < 3 || !ok(val)) return NaN;
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedArr[mid] < val) lo = mid + 1; else hi = mid; }
  return Math.round((lo / (sortedArr.length - 1)) * 100);
}

function buildProMetrics() {
  Z_SCR = new Float32Array(N).fill(NaN);
  CRED_G = new Uint8Array(N);
  ZOMBIE = new Uint8Array(N);
  CAGR = new Float32Array(N).fill(NaN);
  PAT = new Uint8Array(N);
  RULE40 = new Float32Array(N).fill(NaN);
  ROE = new Float32Array(N).fill(NaN);
  ROA = new Float32Array(N).fill(NaN);
  ATURN = new Float32Array(N).fill(NaN);
  LEV = new Float32Array(N).fill(NaN);
  PAY_EFF = new Float32Array(N).fill(NaN);
  RPE = new Float32Array(N).fill(NaN);
  OPPE = new Float32Array(N).fill(NaN);
  HR_REG = new Uint8Array(N);
  NET_R = new Float32Array(N).fill(NaN);
  IND_PCT = new Uint8Array(N);
  LEAD = new Uint8Array(N);

  NAT_IND_CNT = new Int32Array(META.industries.length);
  for (let i = 0; i < N; i++) NAT_IND_CNT[ROWS[i][12]]++;

  const nInd = META.industries.length;
  const bRev = Array.from({ length: nInd }, () => []);
  const bMrg = Array.from({ length: nInd }, () => []);
  const bGrw = Array.from({ length: nInd }, () => []);
  const bEmp = Array.from({ length: nInd }, () => []);
  const bSal = Array.from({ length: nInd }, () => []);
  const bRpe = Array.from({ length: nInd }, () => []);

  for (let i = 0; i < N; i++) {
    const r = ROWS[i];
    const ind = r[12];
    const st = STAT ? STAT[i] : 0;
    const yrs = age(r[13]);

    if (EN) {
      const rv = EN.rev[i], rv1 = EN.rev_p1[i], rv2 = EN.rev_p2[i];
      const op = EN.op[i], op1 = EN.op_p1[i], op2 = EN.op_p2[i];
      const ni = EN.ni[i], as = EN.assets[i], eq = EN.equity[i];
      const em = empOf(i);
      const mg = opMargin(i);

      // #2: Growth (2-yr CAGR when rev_p2 exists, else YoY) + Rule of 40 + 4 Momentum Patterns
      if (ok(rv) && ok(rv2) && rv2 > 0 && rv > 0) CAGR[i] = (Math.sqrt(rv / rv2) - 1) * 100;
      else if (ok(rv) && ok(rv1) && rv1 > 0 && rv > 0) CAGR[i] = (rv / rv1 - 1) * 100;

      if (ok(CAGR[i]) && ok(mg) && ok(rv) && rv >= 1e9) {
        RULE40[i] = Math.max(-100, Math.min(200, CAGR[i] + mg));
      }

      // #5: HR Momentum & Churn Regime (computed early so credit/patterns can use NET_R)
      const ne = EN.nps_emp[i], nw = EN.nps_new[i], ls = EN.nps_lost[i];
      if (ok(ne) && ne >= 5 && ok(nw) && ok(ls)) {
        const netr = ((nw - ls) / ne) * 100;
        const hir = (nw / ne) * 100;
        const qtr = (ls / ne) * 100;
        NET_R[i] = netr;
        if (netr >= 1.5 && hir >= 3.0) HR_REG[i] = 1;       // 급성장 채용
        else if (netr <= -2.0 && qtr >= 3.5) HR_REG[i] = 4; // 인력 이탈 경보
        else if (hir >= 3.5 && qtr >= 3.5) HR_REG[i] = 3;   // 고이직 회전문
        else if (qtr < 2.2 && (ok(SAL[i]) ? SAL[i] >= 4.2e7 : true)) HR_REG[i] = 2; // 안정 우수
      }

      let pmask = 0;
      // bit 1: 매출·인원 동반성장 (또는 2년연속 매출성장)
      if ((ok(rv) && ok(rv1) && ok(rv2) && rv > rv1 && rv1 > rv2 && rv2 > 0) ||
          (ok(CAGR[i]) && CAGR[i] > 5 && ok(NET[i]) && NET[i] > 0)) pmask |= 1;
      // bit 2: 고마진 우량 (영업이익률 10%+ 흑자 또는 3년연속 흑자)
      if ((ok(op) && ok(op1) && ok(op2) && op > 0 && op1 > 0 && op2 > 0) ||
          (ok(mg) && mg >= 10 && ok(rv) && rv >= 1e9)) pmask |= 2;
      // bit 4: 흑자전환 (op_p1 있을 때) 또는 Rule of 40+ 스타
      if ((ok(op) && ok(op1) && op1 < 0 && op > 0) || (ok(RULE40[i]) && RULE40[i] >= 40)) pmask |= 4;
      // bit 8: 적자·둔화 경보 (영업적자 & 매출감소, 또는 적자전환)
      if ((ok(op) && ok(op1) && op1 > 0 && op < 0) || (ok(op) && op < 0 && (!ok(CAGR[i]) || CAGR[i] < 0))) pmask |= 8;
      PAT[i] = pmask;

      // #3: DuPont ROE (when assets/equity present) + Payroll Leverage (매출 / 총인건비 배수)
      if (ok(as) && as > 0) {
        if (ok(op)) ROA[i] = (op / as) * 100;
        if (ok(rv) && rv >= 0) ATURN[i] = rv / as;
        if (ok(eq) && eq > 0) { LEV[i] = as / eq; if (ok(ni)) ROE[i] = (ni / eq) * 100; }
      }
      // #4: Productivity per Employee (억원/인) & 인건비 대비 매출 배수
      if (ok(em) && em >= 1) {
        if (ok(rv) && rv > 0) {
          RPE[i] = (rv / 1e8) / em;
          if (ok(SAL[i]) && SAL[i] > 0) PAY_EFF[i] = (rv / em) / SAL[i];
        }
        if (ok(op)) OPPE[i] = (op / 1e8) / em;
      }

      // #1: Hybrid Corporate Credit & Health Score (0~100 → AAA~D)
      if (st === 2 || st === 3) {
        Z_SCR[i] = st === 3 ? 5 : 18;
        CRED_G[i] = st === 3 ? 8 : 7;
        ZOMBIE[i] = 1;
      } else {
        let zPts = 0, zW = 0;
        // (a) Full balance-sheet Z-Score components if available
        if (ok(as) && as > 0 && ok(eq)) {
          zPts += 30 * clamp01((eq / as + 0.1) / 0.7); zW += 30;
          if (eq <= 0) ZOMBIE[i] = 1;
        }
        if (ok(ROA[i])) { zPts += 20 * clamp01((ROA[i] + 5) / 17); zW += 20; }
        // (b) Operating profitability & growth (DART)
        if (ok(mg)) { zPts += 30 * clamp01((mg + 5) / 20); zW += 30; }
        if (ok(CAGR[i])) { zPts += 15 * clamp01((CAGR[i] + 15) / 40); zW += 15; }
        // (c) Workforce & payroll vitality (NPS — covers 43,386 companies!)
        if (ok(ne) && ne > 0) {
          const empSc = clamp01(Math.log10(Math.max(1, ne)) / 2.7);
          const qtr = ok(ls) ? (ls / ne) * 100 : 2;
          const stabSc = clamp01((5 - qtr) / 4.5);
          const netSc = ok(NET_R[i]) ? clamp01((NET_R[i] + 3) / 6) : 0.5;
          zPts += 25 * (empSc * 0.35 + stabSc * 0.35 + netSc * 0.30);
          zW += 25;
          if (ok(NET_R[i]) && NET_R[i] <= -5 && qtr >= 8) ZOMBIE[i] = 1;
        }
        if (ok(SAL[i]) && SAL[i] > 0) { zPts += 15 * clamp01((SAL[i] - 2.6e7) / 4.8e7); zW += 15; }
        // (d) Operating status, corporate track record & listing reliability
        if (zW >= 20) {
          const ageSc = yrs === null ? 0.45 : clamp01(yrs / 20);
          const listSc = r[5] === 0 ? 1 : r[5] === 1 ? 0.85 : r[5] === 2 ? 0.65 : 0.45;
          const stSc = st === 1 ? 0.9 : 0.5;
          zPts += 15 * (ageSc * 0.4 + listSc * 0.3 + stSc * 0.3);
          zW += 15;

          if (ok(op) && op < 0 && ok(CAGR[i]) && CAGR[i] < -10) ZOMBIE[i] = 1;
          let z = Math.round((zPts / zW) * 100);
          if (ZOMBIE[i]) z = Math.min(z, 36);
          if (ok(op) && op < 0) z = Math.min(z, 54);
          Z_SCR[i] = z;
          CRED_G[i] = z >= 84 ? 1 : z >= 75 ? 2 : z >= 66 ? 3 : z >= 56 ? 4 : z >= 46 ? 5 : z >= 36 ? 6 : z >= 22 ? 7 : 8;
        }
      }

      if (ok(rv) && rv > 0) bRev[ind].push(rv / 1e8);
      if (ok(mg) && ok(rv) && rv >= 1e9) bMrg[ind].push(mg);
      if (ok(CAGR[i])) bGrw[ind].push(CAGR[i]);
      if (ok(em) && em > 0) bEmp[ind].push(em);
      if (ok(SAL[i])) bSal[ind].push(SAL[i]);
      if (ok(RPE[i])) bRpe[ind].push(RPE[i]);
    } else if (st === 2 || st === 3) {
      Z_SCR[i] = st === 3 ? 5 : 18; CRED_G[i] = st === 3 ? 8 : 7; ZOMBIE[i] = 1;
    }
  }

  const sortNum = a => a.sort((x, y) => x - y);
  IND_BUCKETS = { rev: bRev.map(sortNum), mrg: bMrg.map(sortNum), grw: bGrw.map(sortNum), emp: bEmp.map(sortNum), sal: bSal.map(sortNum), rpe: bRpe.map(sortNum) };

  for (let i = 0; i < N; i++) {
    const ps = peerAxes(i).filter(ok);
    if (ps.length >= 2) IND_PCT[i] = Math.round(ps.reduce((a, b) => a + b, 0) / ps.length);
  }

  recomputeLead();
}

function peerAxes(i) {
  if (!IND_BUCKETS || !EN) return [NaN, NaN, NaN, NaN, NaN, NaN];
  const ind = ROWS[i][12];
  return [
    bsearchPct(IND_BUCKETS.rev[ind], revEok(i)),
    bsearchPct(IND_BUCKETS.mrg[ind], ok(EN.rev[i]) && EN.rev[i] >= 1e9 ? opMargin(i) : NaN),
    bsearchPct(IND_BUCKETS.grw[ind], CAGR[i]),
    bsearchPct(IND_BUCKETS.emp[ind], empOf(i)),
    bsearchPct(IND_BUCKETS.sal[ind], SAL[i]),
    bsearchPct(IND_BUCKETS.rpe[ind], RPE[i]),
  ];
}

// #7: Customizable B2B Lead Priority Score (runs in <15ms for 120K rows!)
function recomputeLead() {
  if (!LEAD) return;
  const W = PRO_W;
  const wSum = (W.size + W.profit + W.growth + W.hiring + W.ai + W.safety) || 1;
  for (let i = 0; i < N; i++) {
    const st = STAT ? STAT[i] : 0;
    if (st === 2 || st === 3 || st === 4) { LEAD[i] = 0; continue; }
    // 6 normalized components (0~1)
    const sz = sizePts(i, ROWS[i])[0] / 30;
    const m = opMargin(i);
    const pr = ok(m) ? clamp01((m + 5) / 22) : (EN && ok(EN.ni[i]) ? (EN.ni[i] > 0 ? .6 : .2) : .45);
    const cg = CAGR ? CAGR[i] : NaN;
    const gr = ok(cg) ? clamp01((cg + 10) / 45) : (ok(NET_R[i]) ? clamp01((NET_R[i] + 2) / 7) : .45);
    const hr = ok(HIRE_R[i]) ? clamp01(HIRE_R[i] / 4.5) : (HR_REG[i] === 1 ? .9 : .4);
    const ai = AI_S[i] / 100;
    const sf = ok(Z_SCR[i]) ? Z_SCR[i] / 100 : (st === 1 ? .6 : .45);

    let sc = (sz * W.size + pr * W.profit + gr * W.growth + hr * W.hiring + ai * W.ai + sf * W.safety) / wSum * 100;
    if (ZOMBIE && ZOMBIE[i]) sc *= 0.6;
    if (CUST && CUST[i] === 1) sc *= 0.85; // 기존 고객은 신규 우선순위 살짝 조정
    LEAD[i] = Math.max(0, Math.min(100, Math.round(sc)));
  }
}

function leadGrade(s) { return s >= 80 ? ['S', 'g-s'] : s >= 70 ? ['A', 'g-a'] : s >= 60 ? ['B', 'g-b'] : ['C', 'g-c']; }

function proBadges(i) {
  if (!LEAD) return '';
  let h = '';
  const l = LEAD[i];
  if (l >= 70) { const [gl, gc] = leadGrade(l); h += `<span class="grd ${gc}" title="영업 우선순위 점수">🏆 ${gl} ${l}</span>`; }
  const cg = CRED_G ? CRED_G[i] : 0;
  if (cg) h += `<span class="grd ${CRED_CLS[cg]}" title="기업 신용·안전도(${Math.round(Z_SCR[i])}점)">${CRED_LBL[cg]}</span>`;
  if (RULE40 && ok(RULE40[i]) && RULE40[i] >= 40) h += `<span class="sb s-turn">🔥 R40 ${RULE40[i].toFixed(0)}</span>`;
  else if (ok(CAGR[i]) && CAGR[i] >= 20) h += `<span class="sb s-cagr">🚀 성장 +${CAGR[i].toFixed(0)}%</span>`;
  if (HR_REG && HR_REG[i] === 1) h += '<span class="sb s-hr-up">🚀 급성장채용</span>';
  else if (HR_REG && HR_REG[i] === 4) h += '<span class="sb s-hr-warn">⚠ 인력이탈</span>';
  if (ZOMBIE && ZOMBIE[i]) h += '<span class="sb s-close">⚠ 한계징후</span>';
  return h;
}

/* ---- SVG 6-Axis Peer Radar (Method #6 & #10) ---- */
function radarSVG(seriesList) {
  // seriesList: [{ vals: [6 nums 0..100], color, name }]
  const labels = ['매출', '이익률', '성장률', '직원수', '연봉', '1인매출'];
  const cx = 110, cy = 104, R = 70;
  const pt = (k, r) => { const a = -Math.PI / 2 + (k * Math.PI * 2) / 6; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
  let h = `<svg viewBox="0 0 220 208" class="radar-svg">`;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const pts = labels.map((_, k) => pt(k, R * f).map(v => v.toFixed(1)).join(',')).join(' ');
    h += `<polygon points="${pts}" class="grid"/>`;
  });
  labels.forEach((lb, k) => {
    const [x, y] = pt(k, R); const [lx, ly] = pt(k, R + 17);
    h += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="axis"/>`;
    h += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" class="lbl">${lb}</text>`;
  });
  // Industry median reference (50%)
  const medPts = labels.map((_, k) => pt(k, R * 0.5).map(v => v.toFixed(1)).join(',')).join(' ');
  h += `<polygon points="${medPts}" class="med"><title>업종 중앙값 (50%)</title></polygon>`;
  seriesList.forEach(s => {
    const pts = s.vals.map((v, k) => pt(k, R * (ok(v) ? Math.max(6, v) / 100 : 0.08)).map(x => x.toFixed(1)).join(',')).join(' ');
    h += `<polygon points="${pts}" style="fill:color-mix(in srgb,${s.color} 22%,transparent);stroke:${s.color};stroke-width:2"><title>${esc(s.name)}</title></polygon>`;
  });
  h += '</svg>';
  return h;
}

/* ---- Detail Panel Pro Diagnostics Card ---- */
function proDetailSection(i) {
  if (!LEAD) return '';
  const axes = peerAxes(i);
  const hasAny = axes.some(ok) || (CRED_G && CRED_G[i]) || ok(CAGR[i]) || ok(ROE[i]);
  const [lg, lc] = leadGrade(LEAD[i]);
  const cg = CRED_G ? CRED_G[i] : 0;
  const pats = [];
  if (ok(RULE40[i]) && RULE40[i] >= 40) pats.push(`🔥 Rule of 40 (${RULE40[i].toFixed(0)})`);
  if (PAT[i] & 1) pats.push('⚡ 매출·인원 동반성장');
  if (PAT[i] & 2) pats.push('💎 고마진 우량 (이익률 10%+)');
  if (PAT[i] & 8) pats.push('⚠ 적자·성장둔화 주의');
  if (ZOMBIE[i]) pats.push('🚨 한계·부실 징후');

  return `<div class="sec"><h4>🏆 전문가 퀀트·신용 진단 <span class="grd ${lc}">영업 우선 ${lg} (${LEAD[i]}점)</span></h4><div class="sales">
    <div class="fkpi">
      <div><span>신용등급 (안전도)</span><b class="num">${cg ? `<span class="grd ${CRED_CLS[cg]}">${CRED_LBL[cg]}</span> ${Math.round(Z_SCR[i])}점` : '-'}</b><em>${ZOMBIE[i] ? '한계 징후 주의' : cg && cg <= 3 ? '경영·재무 우량' : cg ? '일반 관리' : '평가자료 없음'}</em></div>
      <div><span>Rule of 40 / 성장</span><b class="num">${ok(RULE40[i]) ? RULE40[i].toFixed(1) : (ok(CAGR[i]) ? `${CAGR[i] >= 0 ? '+' : ''}${CAGR[i].toFixed(1)}%` : '-')}</b><em>${ok(CAGR[i]) ? `매출성장 ${CAGR[i] >= 0 ? '+' : ''}${CAGR[i].toFixed(1)}%` : '성장률+이익률'}</em></div>
      <div><span>${ok(ROE[i]) ? '듀폰 ROE / ROA' : '인건비 매출배수'}</span><b class="num">${ok(ROE[i]) ? ROE[i].toFixed(1) + '%' : (ok(PAY_EFF[i]) ? PAY_EFF[i].toFixed(1) + 'x' : '-')}</b><em>${ok(ROE[i]) ? `ROA ${ok(ROA[i]) ? ROA[i].toFixed(1) + '%' : '-'} · 레버리지 ${ok(LEV[i]) ? LEV[i].toFixed(1) + 'x' : '-'}` : '인건비 1원당 매출'}</em></div>
      <div><span>1인당 매출</span><b class="num">${ok(RPE[i]) ? RPE[i].toFixed(1) + '억' : '-'}</b><em>${ok(OPPE[i]) ? `1인 영업익 ${OPPE[i].toFixed(2)}억` : '생산성 지표'}</em></div>
      <div><span>업종 상대 백분위</span><b class="num">${IND_PCT[i] ? `상위 ${Math.max(1, 100 - IND_PCT[i])}%` : '-'}</b><em>종합 ${IND_PCT[i] || '-'}점 / 100</em></div>
      <div><span>HR 조직 활력</span><b style="font-size:13px">${HR_REG[i] ? HR_LBL[HR_REG[i]] : '-'}</b><em>${ok(NET_R[i]) ? `월 순증률 ${NET_R[i] >= 0 ? '+' : ''}${NET_R[i].toFixed(1)}%` : '국민연금 기준'}</em></div>
    </div>
    ${pats.length ? `<div class="sbrow" style="display:flex;margin-top:8px">${pats.map(p => `<span class="sb s-br">${p}</span>`).join('')}</div>` : ''}
    ${hasAny ? `<div class="radar-wrap" style="margin-top:10px">${radarSVG([{ vals: axes, color: 'var(--accent)', name: ROWS[i][0] }])}
      <div class="tiny" style="line-height:1.7">
        <b>동종업계(${esc(META.industries[ROWS[i][12]])}) 상대 위치</b><br>
        ${['매출액', '영업이익률', 'CAGR 성장', '직원수', '평균연봉', '1인당 매출'].map((lb, k) => `${lb}: <b>${ok(axes[k]) ? `상위 ${Math.max(1, 100 - axes[k])}%` : '자료없음'}</b>`).join('<br>')}
        <br><span style="opacity:.75">점선 다각형 = 업종 중앙값(50%)</span>
      </div></div>` : ''}
  </div></div>`;
}

/* ---- Pro Lab Tab (TOP 10 Quant Dashboard) ---- */
function renderPro() {
  const el = $('#pro'); if (!el || !LEAD) return;
  const n = RES.length;
  let saCnt = 0, hiCred = 0, r40Cnt = 0, zombCnt = 0, grow2Cnt = 0, prof3Cnt = 0, cagr20Cnt = 0, slumpCnt = 0;
  const credDist = new Int32Array(9), hrDist = new Int32Array(5);
  const revs = []; let revSum = 0;
  const rpeTop = [];
  const resInd = new Map();

  for (let k = 0; k < n; k++) {
    const i = RES[k];
    if (LEAD[i] >= 70) saCnt++;
    const cg = CRED_G[i]; credDist[cg]++; if (cg >= 1 && cg <= 3) hiCred++;
    if (ZOMBIE[i]) zombCnt++;
    if (PAT[i] & 1) grow2Cnt++;
    if (PAT[i] & 2) prof3Cnt++;
    if (ok(RULE40[i]) && RULE40[i] >= 40) r40Cnt++;
    if (PAT[i] & 8) slumpCnt++;
    if (ok(CAGR[i]) && CAGR[i] >= 20) cagr20Cnt++;
    hrDist[HR_REG[i]]++;
    const rv = revEok(i);
    if (ok(rv) && rv > 0) { revs.push(rv); revSum += rv; }
    if (ok(RPE[i]) && ok(empOf(i)) && empOf(i) >= 10) rpeTop.push([i, RPE[i]]);
    const ind = ROWS[i][12]; resInd.set(ind, (resInd.get(ind) || 0) + 1);
  }

  // #8 HHI & #9 Pareto / Gini
  revs.sort((a, b) => b - a);
  let hhi = 0, cr3 = 0, cr10 = 0, top10p = 0, top20p = 0, gini = NaN;
  const paretoPts = [[0, 0]];
  if (revs.length >= 5 && revSum > 0) {
    let cum = 0, lorenzArea = 0;
    const m = revs.length;
    const revAsc = [...revs].reverse();
    for (let k = 0; k < m; k++) {
      const sh = (revs[k] / revSum) * 100;
      hhi += sh * sh;
      if (k < 3) cr3 += sh;
      if (k < 10) cr10 += sh;
      cum += revs[k];
      if (k === Math.max(0, Math.floor(m * 0.1) - 1)) top10p = (cum / revSum) * 100;
      if (k === Math.max(0, Math.floor(m * 0.2) - 1)) top20p = (cum / revSum) * 100;
    }
    for (let step = 1; step <= 20; step++) {
      const idx = Math.min(m - 1, Math.floor((m - 1) * (step / 20)));
      let s = 0; for (let j = 0; j <= idx; j++) s += revs[j];
      paretoPts.push([step * 5, (s / revSum) * 100]);
    }
    let ascCum = 0;
    for (let k = 0; k < m; k++) { ascCum += revAsc[k]; lorenzArea += (ascCum - revAsc[k] / 2) / revSum; }
    gini = 1 - (2 * lorenzArea) / m;
  }
  const hhiLbl = hhi >= 2500 ? '고집중(독과점)' : hhi >= 1500 ? '중간 집중(과점)' : '분산(경쟁시장)';

  // #8 Location Quotient (LQ: 지역 특화 업종)
  const lqRows = [];
  if (n > 0 && n < N * 0.95) {
    for (const [ind, c] of resInd.entries()) {
      if (c < 5 || NAT_IND_CNT[ind] < 15) continue;
      const localShare = c / n;
      const natShare = NAT_IND_CNT[ind] / N;
      const lq = localShare / natShare;
      if (lq >= 1.3) lqRows.push({ ind, c, lq });
    }
    lqRows.sort((a, b) => b.lq - a.lq);
  }

  rpeTop.sort((a, b) => b[1] - a[1]);

  const paretoSvg = revs.length >= 5 ? (() => {
    const W = 520, H = 175, p = 26;
    const X = x => p + (x / 100) * (W - p * 2), Y = y => H - p - (y / 100) * (H - p * 2);
    const poly = paretoPts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ') + ` ${X(100)},${Y(0)} ${X(0)},${Y(0)}`;
    return `<svg viewBox="0 0 ${W} ${H}" class="pareto-svg">
      <line x1="${X(0)}" y1="${Y(0)}" x2="${X(100)}" y2="${Y(100)}" class="diag"/>
      <polygon points="${poly}" class="curve"/>
      <circle cx="${X(20)}" cy="${Y(top20p)}" r="4" fill="var(--sel)"/>
      <text x="${X(20) + 7}" y="${Y(top20p) + 4}" class="lbl" style="font-weight:700;fill:var(--sel)">상위 20% → 매출 ${top20p.toFixed(0)}%</text>
      <text x="${p}" y="${H - 6}" class="lbl">0%</text>
      <text x="${W / 2}" y="${H - 6}" class="lbl" text-anchor="middle">기업 누적 비율 →</text>
      <text x="${W - p}" y="${H - 6}" class="lbl" text-anchor="end">100%</text>
      <text x="4" y="${p}" class="lbl">100%</text>
    </svg>`;
  })() : '<p class="tiny">매출 데이터가 있는 기업이 5개 이상일 때 계산됩니다.</p>';

  const bar = (items, attr) => {
    const mx = Math.max(1, ...items.map(x => x.v));
    return `<div class="hbar">${items.map(x => `<div class="r" ${attr}="${x.k}"><span class="l">${x.l}</span><span class="t"><i style="width:${x.v / mx * 100}%;${x.c ? `background:${x.c}` : ''}"></i></span><span class="n">${fmt(x.v)}</span></div>`).join('')}</div>`;
  };

  const wItems = [['size', '기업 규모'], ['profit', '수익성'], ['growth', '성장성'], ['hiring', '채용 활력'], ['ai', 'AI 적합도'], ['safety', '재무 안전']];

  el.innerHTML = `
  <div class="card pro-hero">
    <h3>🏆 전문가 퀀트·영업 인텔리전스 TOP 10 <span class="tiny">현재 조회 ${fmt(n)}개 기준</span></h3>
    <div class="sub">카드를 누르면 해당 전문가 조건이 즉시 필터로 적용됩니다.</div>
    <div class="pro-kpis">
      <div class="pro-kpi" data-pro-q="leadA"><div class="k">🏆 영업 우선 S·A</div><div class="v num" style="color:var(--accent)">${fmt(saCnt)}</div><div class="s">커스텀 70점+</div></div>
      <div class="pro-kpi" data-pro-q="credHi"><div class="k">🛡 신용 우량 AAA~A</div><div class="v num" style="color:var(--c3)">${fmt(hiCred)}</div><div class="s">안전도 66점+</div></div>
      <div class="pro-kpi" data-pro-q="r40"><div class="k">🔥 Rule of 40+</div><div class="v num" style="color:var(--c6)">${fmt(r40Cnt)}</div><div class="s">성장률+이익률 ≥40</div></div>
      <div class="pro-kpi" data-pro-q="nozb"><div class="k">⚠ 한계·부실 징후</div><div class="v num" style="color:var(--c8)">${fmt(zombCnt)}</div><div class="s">누르면 제외 필터</div></div>
    </div>
  </div>

  <div class="card">
    <h3>⑦ 영업 우선순위(ICP) 전략 가중치 커스텀</h3>
    <div class="sub">전략 프리셋을 누르거나 슬라이더를 조절하면 12만 기업 우선순위가 즉시 재계산됩니다.</div>
    <div class="chips" id="proWPresets">${Object.entries(PRO_PRESETS).map(([k, p]) => `<button class="chip" data-wp="${k}">${p.name}</button>`).join('')}
      <button class="chip" data-pro-sort="lead" style="border-color:var(--accent);color:var(--accent);font-weight:700">우선순위순 정렬 ↗</button>
    </div>
    <div class="wgrid">${wItems.map(([k, l]) => `<div class="wrow"><span>${l}</span><b id="wv_${k}">${PRO_W[k]}%</b><input type="range" min="0" max="50" step="5" value="${PRO_W[k]}" data-wk="${k}"></div>`).join('')}</div>
  </div>

  <div class="card">
    <h3>① 경영·재무 신용등급 분포 (Hybrid Z-Score)</h3>
    <div class="sub">수익성·성장성·인력안정·급여지불력·업력·국세청 휴폐업 종합 (4.3만+ 평가) · 누르면 필터</div>
    ${bar([
      { k: 'hi', l: '우량 (AAA · AA · A)', v: credDist[1] + credDist[2] + credDist[3], c: 'var(--c3)' },
      { k: 'mid', l: '보통 (BBB · BB)', v: credDist[4] + credDist[5], c: 'var(--c1)' },
      { k: 'lo', l: '주의·부실 (B · CCC · D)', v: credDist[6] + credDist[7] + credDist[8], c: 'var(--c8)' },
    ], 'data-pro-cr')}
  </div>

  <div class="card">
    <h3>② 성장·수익 모멘텀 패턴 (Rule of 40)</h3>
    <div class="sub">DART 매출·영업이익 × 국민연금 인원증감 교차 분석 · 행을 누르면 즉시 필터</div>
    ${bar([
      { k: 'prof3', l: '💎 고마진 우량 (이익률 10%+)', v: prof3Cnt, c: 'var(--c3)' },
      { k: 'cagr20', l: '🚀 매출 고성장 (+20% 이상)', v: cagr20Cnt, c: 'var(--c7)' },
      { k: 'r40', l: '🔥 Rule of 40+ (초우량 스타)', v: r40Cnt, c: 'var(--c6)' },
      { k: 'grow2', l: '⚡ 매출·인원 동반성장', v: grow2Cnt, c: 'var(--c1)' },
      { k: 'slump', l: '⚠ 영업적자·성장둔화 경보', v: slumpCnt, c: 'var(--c8)' },
    ], 'data-pro-pt')}
  </div>

  <div class="card">
    <h3>⑤ HR 조직 활력도 & 인재 유출 레이더</h3>
    <div class="sub">국민연금 월 입사율·퇴사율·순증률 4유형 분류 (가입자 5인 이상) · 누르면 필터</div>
    ${bar([
      { k: '1', l: HR_LBL[1], v: hrDist[1], c: 'var(--c3)' },
      { k: '2', l: HR_LBL[2], v: hrDist[2], c: 'var(--c1)' },
      { k: '3', l: HR_LBL[3], v: hrDist[3], c: 'var(--c4)' },
      { k: '4', l: HR_LBL[4], v: hrDist[4], c: 'var(--c8)' },
    ], 'data-pro-hr')}
  </div>

  <div class="card">
    <h3>⑧ 시장 집중도(HHI) & ⑨ 파레토(80/20) · 지니계수</h3>
    <div class="sub">현재 조회 시장의 독과점 구조와 상위 기업 쏠림도 분석 (매출 확보 ${fmt(revs.length)}개사 기준)</div>
    <div class="fkpi" style="margin-bottom:10px">
      <div><span>HHI 지수</span><b class="num">${revs.length >= 5 ? fmt(Math.round(hhi)) : '-'}</b><em>${revs.length >= 5 ? hhiLbl : '자료 부족'}</em></div>
      <div><span>CR3 / CR10</span><b class="num">${revs.length >= 5 ? cr3.toFixed(0) + '%' : '-'}</b><em>상위10개 ${revs.length >= 5 ? cr10.toFixed(0) + '%' : '-'}</em></div>
      <div><span>상위 10% 점유</span><b class="num">${revs.length >= 5 ? top10p.toFixed(1) + '%' : '-'}</b><em>상위20% ${revs.length >= 5 ? top20p.toFixed(1) + '%' : '-'}</em></div>
      <div><span>지니계수 (Gini)</span><b class="num">${ok(gini) ? gini.toFixed(2) : '-'}</b><em>1에 가까울수록 양극화</em></div>
    </div>
    ${paretoSvg}
  </div>

  <div class="card">
    <h3>⑧ 지역 특화 업종 클러스터 (입지계수 LQ TOP 10)</h3>
    <div class="sub">${lqRows.length ? '전국 평균 대비 현재 지역/조건에 통계적으로 특화·집적된 업종 (LQ ≥ 1.3) · 누르면 필터' : '시·도나 시·군·구 등 특정 지역을 선택하면 전국 대비 특화 업종(LQ)이 자동 계산됩니다.'}</div>
    ${lqRows.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>특화 업종</th><th>지역 기업</th><th>전국 대비(LQ)</th></tr></thead><tbody>
      ${lqRows.slice(0, 10).map(x => `<tr data-pro-ind="${x.ind}"><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(META.industries[x.ind])}</td><td class="num">${fmt(x.c)}개</td><td class="num"><b style="color:var(--accent)">${x.lq.toFixed(2)}배</b></td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>

  <div class="card">
    <h3>④ 1인당 매출 생산성 TOP 12 (알짜 강소기업)</h3>
    <div class="sub">직원 10인 이상 중 1인당 매출액 최상위 · 누르면 기업 상세</div>
    ${rpeTop.length ? `<ul class="peers">${rpeTop.slice(0, 12).map(([i, v]) => `<li data-pro-i="${i}"><span>${esc(ROWS[i][0])} <span class="tiny">${esc(META.industries[ROWS[i][12]].slice(0, 14))}</span></span><span class="num"><b>${v.toFixed(1)}억/인</b> <span class="tiny">(${fmt(Math.round(empOf(i)))}명)</span></span></li>`).join('')}</ul>` : '<p class="tiny">해당 조건에 10인 이상 매출 자료 기업이 없습니다.</p>'}
  </div>`;
}

/* ---- #10 Side-by-Side 5-Company Comparison ---- */
function toggleCompare(i) {
  const idx = CMP.indexOf(i);
  if (idx >= 0) { CMP.splice(idx, 1); toast('비교함에서 뺐습니다'); }
  else {
    if (CMP.length >= 5) { toast('최대 5개 기업까지 비교할 수 있습니다'); return; }
    CMP.push(i); toast(`비교함에 담았습니다 (${CMP.length}/5)`);
  }
  renderCompareTray();
  const rowEl = $(`#list .item[data-i="${i}"]`); if (rowEl) rowEl.outerHTML = itemHTML(i);
}
function renderCompareTray() {
  const tray = $('#cmpTray'); if (!tray) return;
  tray.hidden = CMP.length === 0;
  $('#cmpCnt').textContent = CMP.length;
  $('#cmpNames').innerHTML = CMP.map(i => `<span class="cpill">${esc(ROWS[i][0].slice(0, 10))}<button type="button" data-cmprm="${i}">✕</button></span>`).join('');
}
function openCompare() {
  if (!CMP.length) return;
  const cols = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c7)', 'var(--c4)'];
  const series = CMP.map((i, k) => ({ vals: peerAxes(i), color: cols[k % cols.length], name: ROWS[i][0] }));
  const metrics = [
    ['법인구분', i => META.corp[ROWS[i][5]], null],
    ['업종', i => META.industries[ROWS[i][12]].slice(0, 18), null],
    ['사업자상태', i => STAT ? STAT_LBL[STAT[i]] : '-', null],
    ['🏆 영업 우선순위', i => LEAD[i] + '점 (' + leadGrade(LEAD[i])[0] + ')', i => LEAD[i]],
    ['🛡 신용등급(Z)', i => CRED_G[i] ? `${CRED_LBL[CRED_G[i]]} (${Math.round(Z_SCR[i])})` : '-', i => Z_SCR[i]],
    ['매출액(당기)', i => EN && ok(EN.rev[i]) ? fmtEok(EN.rev[i]) : '-', i => revEok(i)],
    ['영업이익', i => EN && ok(EN.op[i]) ? fmtEok(EN.op[i]) : '-', i => EN ? EN.op[i] : NaN],
    ['영업이익률', i => ok(opMargin(i)) ? opMargin(i).toFixed(1) + '%' : '-', i => opMargin(i)],
    ['매출성장(YoY/CAGR)', i => ok(CAGR[i]) ? (CAGR[i] >= 0 ? '+' : '') + CAGR[i].toFixed(1) + '%' : '-', i => CAGR[i]],
    ['🔥 Rule of 40', i => ok(RULE40[i]) ? RULE40[i].toFixed(1) : '-', i => RULE40[i]],
    ['인건비 매출배수', i => ok(PAY_EFF[i]) ? PAY_EFF[i].toFixed(1) + 'x' : '-', i => PAY_EFF[i]],
    ['직원수', i => ok(empOf(i)) ? fmt(Math.round(empOf(i))) + '명' : '-', i => empOf(i)],
    ['1인당 매출', i => ok(RPE[i]) ? RPE[i].toFixed(1) + '억' : '-', i => RPE[i]],
    ['평균 연봉', i => fmtSal(i), i => SAL[i]],
    ['월 입사 / 순증', i => EN && ok(EN.nps_new[i]) ? `${EN.nps_new[i]}명 (${ok(NET[i]) ? (NET[i] >= 0 ? '+' : '') + NET[i] : '-'})` : '-', i => NET[i]],
    ['HR 조직 활력', i => HR_REG[i] ? HR_LBL[HR_REG[i]] : '-', null],
    ['AI 도입 적합도', i => AI_S[i] + '점', i => AI_S[i]],
    ['전망 점수', i => ok(OUT[i]) ? OUT[i] + '점' : '-', i => OUT[i]],
    ['업종 백분위', i => IND_PCT[i] ? `상위 ${100 - IND_PCT[i]}%` : '-', i => IND_PCT[i]],
  ];

  const rowsHtml = metrics.map(([lbl, fn, numFn]) => {
    let best = -Infinity;
    if (numFn) CMP.forEach(i => { const v = numFn(i); if (ok(v) && v > best) best = v; });
    return `<tr><td>${lbl}</td>${CMP.map(i => {
      const v = numFn ? numFn(i) : NaN;
      const win = numFn && CMP.length > 1 && ok(v) && v === best && best > -Infinity;
      return `<td class="num${win ? ' win' : ''}">${esc(fn(i))}</td>`;
    }).join('')}</tr>`;
  }).join('');

  $('#cmpBody').innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <div style="width:220px;margin:0 auto">${radarSVG(series)}</div>
      <div style="flex:1;min-width:200px">
        <div class="tiny" style="margin-bottom:6px"><b>6축 업종 상대평가 겹침 비교</b> (점선=업종 중앙값)</div>
        <div class="lg">${series.map(s => `<span><span class="dot" style="background:${s.color}"></span><b>${esc(s.name)}</b></span>`).join('')}</div>
        <p class="tiny" style="margin:8px 0 0">아래 표에서 녹색 강조는 비교 대상 중 해당 지표 1위 기업입니다.</p>
      </div>
    </div>
    <div class="tblwrap"><table class="tbl cmp-tbl"><thead><tr><th>지표</th>${CMP.map((i, k) => `<th><span class="dot" style="background:${cols[k % cols.length]}"></span> ${esc(ROWS[i][0])}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;

  $('#cmpCopyBtn').onclick = () => {
    const tsv = [['지표', ...CMP.map(i => ROWS[i][0])].join('\t'), ...metrics.map(([lbl, fn]) => [lbl, ...CMP.map(i => fn(i))].join('\t'))].join('\n');
    copy(tsv, '비교 표를 복사했습니다 (엑셀/노션 붙여넣기)');
  };
  $('#cmpModal').classList.add('on'); $('#cmpModal').setAttribute('aria-hidden', 'false'); updateScrim();
}
function closeCompare() { $('#cmpModal').classList.remove('on'); $('#cmpModal').setAttribute('aria-hidden', 'true'); updateScrim(); }

/* ---- 1-Page Executive Briefing Report ---- */
function openBriefing(i) {
  const r = ROWS[i], m = memoOf(i);
  const lines = [
    `[기업 분석 브리핑] ${r[0]}${r[3].trim() ? ` (${CORP_SHORT[r[5]]} ${r[3].trim()})` : ` (${META.corp[r[5]]})`}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `• 대표자: ${r[4] || '-'}  |  설립일: ${estStr(r[13])} (${age(r[13]) ?? '-'}년)`,
    `• 업종: ${META.industries[r[12]]}`,
    `• 사업자번호: ${r[6]}  |  상태: ${STAT ? STAT_LBL[STAT[i]] : '미확인'}`,
    `• 주소: ${r[7] || '-'}`,
    `• 연락처: ${r[8] || '-'}  |  홈페이지: ${r[10] || '-'}`,
    ``,
    `[전문가 퀀트 진단]`,
    `• 영업 우선순위: ${LEAD[i]}점 (${leadGrade(LEAD[i])[0]}등급)  |  AI 적합도: ${AI_S[i]}점 (${AICAT[AI_C[i]][0]})`,
    `• 신용등급(Z-Score): ${CRED_G[i] ? `${CRED_LBL[CRED_G[i]]} (${Math.round(Z_SCR[i])}점)` : '-'}  |  전망점수: ${ok(OUT[i]) ? OUT[i] + '점' : '-'}`,
    `• 매출액: ${EN && ok(EN.rev[i]) ? fmtEok(EN.rev[i]) : '-'}  |  영업이익: ${EN && ok(EN.op[i]) ? fmtEok(EN.op[i]) : '-'} (${ok(opMargin(i)) ? opMargin(i).toFixed(1) + '%' : '-'})`,
    `• 매출성장(YoY/CAGR): ${ok(CAGR[i]) ? (CAGR[i] >= 0 ? '+' : '') + CAGR[i].toFixed(1) + '%' : '-'}  |  Rule of 40: ${ok(RULE40[i]) ? RULE40[i].toFixed(1) : '-'}  |  인건비배수: ${ok(PAY_EFF[i]) ? PAY_EFF[i].toFixed(1) + 'x' : '-'}`,
    `• 직원수: ${ok(empOf(i)) ? fmt(Math.round(empOf(i))) + '명' : '-'}  |  1인당 매출: ${ok(RPE[i]) ? RPE[i].toFixed(1) + '억' : '-'}  |  평균연봉: ${fmtSal(i)}`,
    `• HR 활력: ${HR_REG[i] ? HR_LBL[HR_REG[i]] : '-'}  |  업종 상대위치: ${IND_PCT[i] ? `상위 ${100 - IND_PCT[i]}%` : '-'}`,
    `• 추천 AI 제안: ${AICAT[AI_C[i]][3][0]}`,
  ];
  if (TAGM && TAGM[i]) lines.push(`• 인증·선정: ${TAGS.filter((_, k) => TAGM[i] & (1 << k)).map(t => t.label).join(', ')}`);
  if (m && (m.stage || m.text)) lines.push('', `[내 영업 메모 (${m.stage || '기록'})]`, m.text || '');

  const txt = lines.join('\n');
  $('#briefBody').textContent = txt;
  $('#briefCopyBtn').onclick = () => copy(txt, '1페이지 기업 브리핑을 복사했습니다');
  $('#briefModal').classList.add('on'); $('#briefModal').setAttribute('aria-hidden', 'false'); updateScrim();
}
function closeBriefing() { $('#briefModal').classList.remove('on'); $('#briefModal').setAttribute('aria-hidden', 'true'); updateScrim(); }

/* ---- Saved Filter Presets ---- */
function renderPresets() {
  const el = $('#presetList'); if (!el) return;
  el.innerHTML = PRESETS.length
    ? PRESETS.map((p, k) => `<div class="preset-item"><button type="button" class="load" data-pload="${k}">🔖 ${esc(p.name)}</button><button type="button" class="cp" data-pdel="${k}">✕</button></div>`).join('')
    : '<div class="tiny">자주 쓰는 검색 조건을 저장해 원클릭으로 불러오세요.</div>';
}
function applySavedState(st) {
  resetAll();
  Object.assign(S, st);
  $('#q').value = S.q || ''; $('#searchBox').classList.toggle('has', !!S.q);
  $('#fName').value = S.name || ''; $('#fAddr').value = S.addr || ''; $('#fTel').value = S.tel || '';
  $('#fHome').value = S.home || ''; $('#fFrom').value = S.from || ''; $('#fTo').value = S.to || ''; $('#fFm').value = S.fm || '';
  $('#fHasHome').checked = !!S.hasHome; $('#fFav').checked = !!S.fav; $('#fHasMemo').checked = !!S.hasMemo;
  $('#fSido').value = S.sido || ''; fillSgg();
  run();
}

function proSyncChips() {
  $$('#leadChips .chip').forEach(b => b.setAttribute('aria-pressed', S.leadG === b.dataset.lg));
  $$('#credChips .chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.cr === 'nozb' ? !!S.nozb : S.cred === b.dataset.cr));
  $$('#patChips .chip').forEach(b => b.setAttribute('aria-pressed', S.pat.includes(b.dataset.pt)));
  $$('#hrChips .chip').forEach(b => b.setAttribute('aria-pressed', S.hr.includes(+b.dataset.hr)));
  $$('#rpeChips .chip').forEach(b => b.setAttribute('aria-pressed', S.rpeMin === +b.dataset.rpe));
}

function initPro() {
  renderPresets();
  $('#savePresetBtn').onclick = () => {
    const name = $('#presetNameIn').value.trim();
    if (!name) { toast('프리셋 이름을 입력하세요'); $('#presetNameIn').focus(); return; }
    const snap = JSON.parse(JSON.stringify(S));
    const idx = PRESETS.findIndex(p => p.name === name);
    if (idx >= 0) PRESETS[idx] = { name, state: snap };
    else PRESETS.unshift({ name, state: snap });
    store.set('presets', PRESETS);
    $('#presetNameIn').value = '';
    renderPresets();
    toast(`조건 프리셋 "${name}" 저장`);
  };
  $('#presetList').onclick = e => {
    const ld = e.target.closest('[data-pload]');
    if (ld) { applySavedState(PRESETS[+ld.dataset.pload].state); openFilter(false); toast(`"${PRESETS[+ld.dataset.pload].name}" 적용 · ${fmt(RES.length)}개`); return; }
    const dl = e.target.closest('[data-pdel]');
    if (dl) { PRESETS.splice(+dl.dataset.pdel, 1); store.set('presets', PRESETS); renderPresets(); toast('프리셋 삭제'); }
  };

  $('#proLeadPreset').onclick = () => { S.leadG = 'A'; S.nozb = true; S.sort = 'lead'; run(); openFilter(false); if (isMobile()) setView('list'); toast(`🏆 영업 우선 S·A등급 ${fmt(RES.length)}개`); };
  $('#leadChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.leadG = S.leadG === b.dataset.lg ? '' : b.dataset.lg; if (S.leadG && S.sort === 'rel') S.sort = 'lead'; run(); };
  $('#credChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; if (b.dataset.cr === 'nozb') S.nozb = !S.nozb; else S.cred = S.cred === b.dataset.cr ? '' : b.dataset.cr; run(); };
  $('#patChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const v = b.dataset.pt; S.pat = S.pat.includes(v) ? S.pat.filter(x => x !== v) : [...S.pat, v]; run(); };
  $('#hrChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const v = +b.dataset.hr; S.hr = S.hr.includes(v) ? S.hr.filter(x => x !== v) : [...S.hr, v]; run(); };
  $('#rpeChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const v = +b.dataset.rpe; S.rpeMin = S.rpeMin === v ? 0 : v; run(); };

  // Compare Tray
  $('#cmpNames').onclick = e => { const b = e.target.closest('[data-cmprm]'); if (b) toggleCompare(+b.dataset.cmprm); };
  $('#cmpOpenBtn').onclick = openCompare;
  $('#cmpClearBtn').onclick = () => { const prev = [...CMP]; CMP = []; renderCompareTray(); prev.forEach(i => { const el = $(`#list .item[data-i="${i}"]`); if (el) el.outerHTML = itemHTML(i); }); };

  // Pro Lab Interactions
  $('#pro').addEventListener('click', e => {
    const q = e.target.closest('[data-pro-q]');
    if (q) {
      const k = q.dataset.proQ;
      if (k === 'leadA') { S.leadG = 'A'; S.sort = 'lead'; }
      else if (k === 'credHi') { S.cred = 'hi'; S.sort = 'z'; }
      else if (k === 'r40') { if (!S.pat.includes('r40')) S.pat.push('r40'); S.sort = 'roe'; }
      else if (k === 'nozb') { S.nozb = true; }
      run(); if (isMobile()) setView('list'); toast(`조건 적용 · ${fmt(RES.length)}개`); return;
    }
    const wp = e.target.closest('[data-wp]');
    if (wp) { PRO_W = Object.assign({}, PRO_PRESETS[wp.dataset.wp].w); store.set('proW', PRO_W); recomputeLead(); S.sort = 'lead'; run(); toast(`전략 "${PRO_PRESETS[wp.dataset.wp].name}" 적용`); return; }
    if (e.target.closest('[data-pro-sort]')) { S.sort = 'lead'; run(); if (isMobile()) setView('list'); toast('영업 우선순위순으로 정렬했습니다'); return; }
    const cr = e.target.closest('[data-pro-cr]'); if (cr) { S.cred = cr.dataset.proCr; run(); return; }
    const pt = e.target.closest('[data-pro-pt]'); if (pt) { const v = pt.dataset.proPt; if (!S.pat.includes(v)) S.pat.push(v); run(); return; }
    const hr = e.target.closest('[data-pro-hr]'); if (hr) { const v = +hr.dataset.proHr; if (!S.hr.includes(v)) S.hr.push(v); run(); return; }
    const ind = e.target.closest('[data-pro-ind]'); if (ind) { const v = +ind.dataset.proInd; if (!S.ind.includes(v)) S.ind.push(v); run(); toast('특화 업종 필터 추가'); return; }
    const ci = e.target.closest('[data-pro-i]'); if (ci) { openDetail(+ci.dataset.proI); return; }
  });

  $('#pro').addEventListener('input', e => {
    const r = e.target.closest('input[data-wk]'); if (!r) return;
    const k = r.dataset.wk; PRO_W[k] = +r.value;
    const lbl = $(`#wv_${k}`); if (lbl) lbl.textContent = PRO_W[k] + '%';
    store.set('proW', PRO_W);
    clearTimeout(initPro.t);
    initPro.t = setTimeout(() => { recomputeLead(); run(); }, 160);
  });
}

/* ==================== Boot & Lock Flow ==================== */
async function startAppWithKey(key) {
  VAULT_KEY = key;
  $('#lockScreen').hidden = true;
  $('#loader').hidden = false;
  try {
    await loadData();
    if (!APP_BOOTED) {
      APP_BOOTED = true;
      await initSales();
      initFilters();
      initPro();
      initList();
      initMap();
      initStats();
      initNav();
      setSido('', '');
    }
    $('#appShell').hidden = false;
    run();
    setTimeout(() => {
      $('#loader').style.transition = 'opacity .25s';
      $('#loader').style.opacity = 0;
      setTimeout(() => { $('#loader').hidden = true; $('#loader').style.opacity = 1; }, 260);
    }, 80);
  } catch (err) {
    console.error(err);
    $('#ltxt').textContent = '복호화 또는 데이터 로드 실패: ' + err.message;
    await idb.delKey();
  }
}

async function initVault() {
  // PWA Service Worker & install prompt
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = $('#pwaInstallBtn');
    if (btn) {
      btn.hidden = false;
      btn.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        btn.hidden = true;
      };
    }
  });

  // Password visibility toggle
  $('#pwToggle').onclick = () => {
    const inp = $('#pwInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  try {
    const res = await fetch('./data/vault.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('vault.json 로드 실패');
    VAULT_META = await res.json();
  } catch (err) {
    $('#lockErr').textContent = '데이터 메타 정보를 불러올 수 없습니다: ' + err.message;
    return;
  }

  // Try remembered non-extractable CryptoKey on this device
  const saved = await idb.getKey();
  if (saved && saved.salt === VAULT_META.salt && saved.key) {
    const valid = await verifyKey(saved.key, VAULT_META);
    if (valid) {
      await startAppWithKey(saved.key);
      return;
    }
    await idb.delKey();
  }

  $('#pwInput').focus();
  $('#lockForm').onsubmit = async e => {
    e.preventDefault();
    const pw = $('#pwInput').value;
    const errEl = $('#lockErr');
    const btn = $('#pwSubmit');
    if (!pw) return;
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = '키 검증 중…';
    try {
      const key = await deriveVaultKey(pw, VAULT_META.salt, VAULT_META.iter);
      const valid = await verifyKey(key, VAULT_META);
      if (!valid) {
        errEl.textContent = '비밀번호가 일치하지 않습니다.';
        btn.disabled = false;
        btn.textContent = '잠금 해제';
        $('#pwInput').select();
        return;
      }
      if ($('#pwRemember').checked) {
        await idb.setKey({ salt: VAULT_META.salt, key });
      }
      $('#pwInput').value = '';
      await startAppWithKey(key);
    } catch (err) {
      errEl.textContent = '인증 오류: ' + err.message;
      btn.disabled = false;
      btn.textContent = '잠금 해제';
    }
  };
}

initVault();
})();
