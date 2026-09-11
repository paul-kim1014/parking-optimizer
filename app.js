/* 자리먼저 화면 — 방문객 웹앱 · 운영 대시보드 · 전광판 · 시뮬레이터 */
(function () {
  'use strict';
  const E = window.ParkEngine;
  const fac = E.buildFacility();
  const ZN = E.ZONES, FL = E.FLOORS;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const clock = t => { const m = Math.round(t / 60) + 420; return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); };
  const dur = s => { s = Math.max(0, Math.round(s)); if (s < 60) return s + '초'; const m = Math.floor(s / 60), r = s % 60; return r ? `${m}분 ${r}초` : `${m}분`; };
  const pct = (x, d) => (x * 100).toFixed(d || 0) + '%';
  const tok = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const STATUS_KO = ['빈자리', '배정 보관(hold)', '주차 중', '차단 · 센서 불일치', '평시 폐쇄'];
  const LANE_KO = ['북측', '중앙', '남측'];
  const SIGN_FONT = '"Barlow Condensed", "IBM Plex Sans KR", sans-serif';
  const SEEDS = [
    { seed: 20260914, label: '9월 14일 (월) — 기본' },
    { seed: 20260915, label: '9월 15일 (화)' },
    { seed: 20260916, label: '9월 16일 (수)' },
  ];

  const S = {
    view: 'visitor', t: 10200, floor: 1, sel: null, playing: false, timer: null,
    p: { seed: 0, compliance: 0.65, participation: 0.6, etaShare: 0.45, holdCap: 0.7, b3: false, w: Object.assign({}, E.DEFAULT_W) },
    day: null, base: null, runs: {}, live: null, liveOps: [], sweep: [], sweepToken: 0, score: null, fcCache: {}, actual: null,
  };
  const VIS = { step: 0, plate: '3456', dis: false, ev: false, large: false, eta: 11100, share: true, consent: false, rank: 0, reassigned: null, rating: 0 };
  const APPT = 12600; // 10:30 심장내과

  // ---------- 시나리오 실행 ----------
  function runScenario() {
    const p = S.p;
    S.day = E.generateDay({ seed: SEEDS[p.seed].seed });
    S.base = { compliance: p.compliance, participation: p.participation, etaShare: p.etaShare, holdCap: p.holdCap, weights: p.w, ops: p.b3 ? [{ t: 0, type: 'openB3D' }] : [] };
    S.runs.none = E.simulate(fac, S.day, Object.assign({}, S.base, { policy: 'none' }));
    S.runs.greedy = E.simulate(fac, S.day, Object.assign({}, S.base, { policy: 'greedy' }));
    S.runs.rolling = E.simulate(fac, S.day, Object.assign({}, S.base, { policy: 'rolling', record: true }));
    S.liveOps = []; S.live = S.runs.rolling;
    S.score = E.forecastScore(S.day);
    S.actual = E.actualBuckets(S.day);
    S.fcCache = {};
    startSweep();
  }
  function rerunLive() {
    S.live = S.liveOps.length
      ? E.simulate(fac, S.day, Object.assign({}, S.base, { policy: 'rolling', record: true, ops: S.base.ops.concat(S.liveOps) }))
      : S.runs.rolling;
  }
  function startSweep() {
    const token = ++S.sweepToken; S.sweep = [];
    const none = S.runs.none.metrics;
    let i = 0;
    const next = () => {
      if (token !== S.sweepToken) return;
      if (i > 10) { if (S.view === 'sim') renderSim(); return; }
      const c = i++ / 10;
      const r = E.simulate(fac, S.day, Object.assign({}, S.base, { policy: 'rolling', compliance: c }));
      S.sweep.push({ c, entry: 1 - r.metrics.peakEntry / none.peakEntry, search: 1 - r.metrics.search / none.search });
      if (S.view === 'sim' && (i === 6 || i === 11)) renderSim();
      setTimeout(next, 0);
    };
    setTimeout(next, 40);
  }

  const idxAt = t => Math.max(0, Math.min(144, Math.round(t / 300)));
  const snapAt = (run, t) => run.snaps[Math.min(run.snaps.length - 1, idxAt(t))];
  const serAt = (run, t) => run.series[Math.min(run.series.length - 1, idxAt(t))];
  function fc(b0, b1, issue) {
    const k = b0 + '|' + b1 + '|' + issue;
    return S.fcCache[k] || (S.fcCache[k] = E.forecastBucket(S.day, b0, b1, issue));
  }
  function turnOf(slot, ramp) {
    if (slot.lane === 1) return { arrow: '↑', word: '직진' };
    const left = (ramp === 0) === (slot.lane === 0);
    return left ? { arrow: '←', word: '좌회전' } : { arrow: '→', word: '우회전' };
  }
  function freeByFloor(status) {
    const n = [0, 0, 0];
    for (let s = 0; s < fac.N; s++) if (status[s] === E.FREE) n[fac.slots[s].f]++;
    return n;
  }
  function niceScale(v, n) {
    const raw = Math.max(v, 1e-6) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(x => x * p).find(x => x >= raw);
    return { step, max: step * n };
  }

  // ---------- 층 지도 (디지털 트윈) ----------
  const MW = 104, MH = 55, OX = 2, OY = 5;
  function drawFloor(cv, f, status, opt) {
    opt = opt || {};
    const wCss = Math.max(240, cv.parentElement.clientWidth);
    const k = wCss / MW, hCss = Math.round(MH * k), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(wCss * dpr); cv.height = Math.round(hCss * dpr); cv.style.height = hCss + 'px';
    cv.dataset.k = k;
    const g = cv.getContext('2d');
    g.setTransform(dpr * k, 0, 0, dpr * k, OX * dpr * k, OY * dpr * k);
    const C = { surface: tok('--surface'), lane: tok('--lane'), free: tok('--free'), edge: tok('--free-edge'), occ: tok('--occ'), paint: tok('--paint'), crit: tok('--crit'), ink: tok('--ink'), ink3: tok('--ink-3'), ground: tok('--ground'), sign: tok('--sign'), ok: tok('--ok'), rule: tok('--rule') };
    g.fillStyle = C.surface; g.fillRect(-OX, -OY, MW, MH);
    g.fillStyle = C.lane;
    E.LANE_Y.forEach(y => g.fillRect(0, y - 3, 100, 6));
    g.fillRect(0, 5, 10, 38); g.fillRect(90, 5, 10, 38);
    // 램프
    g.textAlign = 'center'; g.textBaseline = 'middle';
    E.RAMPS.forEach((r, i) => {
      const x = i === 0 ? 0.6 : 95.4;
      g.fillStyle = C.rule; g.fillRect(x, 13, 4, 22);
      g.strokeStyle = C.lane; g.lineWidth = 0.3;
      for (let y = 14; y < 35; y += 1.5) { g.beginPath(); g.moveTo(x + 0.4, y); g.lineTo(x + 2, y - 0.8); g.lineTo(x + 3.6, y); g.stroke(); }
      g.save(); g.translate(x + 2, 24); g.rotate(i === 0 ? -Math.PI / 2 : Math.PI / 2);
      g.fillStyle = C.ink; g.font = `600 2.1px ${SIGN_FONT}`; g.fillText(r.name, 0, 0); g.restore();
    });
    // 구역 표시
    g.fillStyle = C.ink3; g.font = `600 2.5px ${SIGN_FONT}`;
    'ABCD'.split('').forEach((z, i) => g.fillText(z + '구역', 20 + 20 * i, -2.2));
    g.strokeStyle = C.rule; g.lineWidth = 0.15; g.setLineDash([0.6, 0.6]);
    [30, 50, 70].forEach(x => { g.beginPath(); g.moveTo(x, -1); g.lineTo(x, 48); g.stroke(); });
    g.setLineDash([]);
    // 슬롯
    for (const s of fac.slots) {
      if (s.f !== f) continue;
      const st = status[s.i];
      const x = s.x - 1.1, y = E.ROW_Y[s.r] + 0.3, w = 2.2, h = 4.4;
      if (st === E.CLOSED) { g.strokeStyle = C.edge; g.lineWidth = 0.16; g.setLineDash([0.5, 0.5]); g.strokeRect(x, y, w, h); g.setLineDash([]); continue; }
      g.fillStyle = st === E.FREE ? C.free : st === E.HELD ? C.paint : st === E.OCC ? C.occ : C.crit;
      g.fillRect(x, y, w, h);
      if (st === E.FREE) { g.strokeStyle = C.edge; g.lineWidth = 0.14; g.strokeRect(x, y, w, h); }
      if (s.disabled || s.ev) { g.fillStyle = s.disabled ? C.sign : C.ok; g.beginPath(); g.arc(s.x, s.y, 0.5, 0, 6.2832); g.fill(); }
    }
    // 승강기 코어
    E.ELEV.forEach(e => {
      const x = E.X0 + E.SW * e.cols[0], y = E.ROW_Y[e.rows[0]];
      g.fillStyle = C.ink; g.fillRect(x + 0.2, y + 0.3, 7.1, 9.4);
      g.fillStyle = C.ground; g.font = `700 3.2px ${SIGN_FONT}`; g.fillText(e.id, x + 3.75, y + 4.4);
      g.font = `500 1.7px ${SIGN_FONT}`; g.fillText(e.bld, x + 3.75, y + 7.2);
    });
    // 방문객 경로
    if (opt.hl) {
      const s = fac.slots[opt.hl.s], ly = E.LANE_Y[s.lane], rx = E.RAMPS[opt.hl.ramp].x, el = E.ELEV[opt.hl.elev];
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.strokeStyle = C.ink; g.lineWidth = 0.5; g.setLineDash([1.2, 0.8]);
      g.beginPath(); g.moveTo(rx, 24); if (s.lane !== 1) g.lineTo(rx, ly); g.lineTo(s.x, ly); g.lineTo(s.x, s.y); g.stroke();
      g.strokeStyle = C.sign; g.lineWidth = 0.65; g.setLineDash([0.1, 1]);
      g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(s.x, ly); g.lineTo(el.x, ly); g.lineTo(el.x, el.y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.sign; g.fillRect(s.x - 1.1, E.ROW_Y[s.r] + 0.3, 2.2, 4.4);
      g.strokeStyle = C.ink; g.lineWidth = 0.4; g.strokeRect(s.x - 1.5, E.ROW_Y[s.r] - 0.1, 3, 5.2);
      g.fillStyle = C.ink; g.beginPath(); g.arc(rx, 24, 0.9, 0, 6.2832); g.fill();
    }
    if (opt.sel != null && fac.slots[opt.sel].f === f) {
      const s = fac.slots[opt.sel];
      g.strokeStyle = C.sign; g.lineWidth = 0.45; g.strokeRect(s.x - 1.5, E.ROW_Y[s.r] - 0.1, 3, 5.2);
    }
  }
  function slotAt(cv, f, ev) {
    const k = +cv.dataset.k, rect = cv.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) / k - OX, my = (ev.clientY - rect.top) / k - OY;
    let best = null, bd = 9;
    for (const s of fac.slots) {
      if (s.f !== f) continue;
      const d = Math.abs(mx - s.x) * 2 + Math.abs(my - s.y);
      if (Math.abs(mx - s.x) <= 1.6 && my >= E.ROW_Y[s.r] - 0.5 && my <= E.ROW_Y[s.r] + 5.5 && d < bd) { bd = d; best = s.i; }
    }
    return best;
  }

  // ---------- LED 전광판 ----------
  function drawLED(cv, lines, colors) {
    const cols = 150, rows = 34;
    const off = drawLED.off || (drawLED.off = document.createElement('canvas'));
    off.width = cols; off.height = rows;
    const o = off.getContext('2d', { willReadFrequently: true });
    o.clearRect(0, 0, cols, rows); o.fillStyle = '#fff'; o.textAlign = 'center'; o.textBaseline = 'middle';
    lines.forEach((ln, i) => {
      let fs = 15;
      const font = n => `700 ${n}px "IBM Plex Sans KR", "Apple SD Gothic Neo", sans-serif`;
      o.font = font(fs);
      while (o.measureText(ln).width > cols - 4 && fs > 10) o.font = font(--fs);
      o.fillText(ln, cols / 2, i * 17 + 9);
    });
    const d = o.getImageData(0, 0, cols, rows).data;
    const wCss = cv.clientWidth || 300, dot = wCss / cols, hCss = dot * rows, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(wCss * dpr); cv.height = Math.round(hCss * dpr); cv.style.height = (hCss + 14) + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#060807'; g.fillRect(0, 0, wCss, hCss);
    const paths = [new Path2D(), new Path2D(), new Path2D()], r = dot * 0.36;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const lit = d[(y * cols + x) * 4 + 3] > 110;
      const p = lit ? paths[y < 17 ? 0 : 1] : paths[2];
      const cx = x * dot + dot / 2, cy = y * dot + dot / 2;
      p.moveTo(cx + r, cy); p.arc(cx, cy, r, 0, 6.2832);
    }
    g.fillStyle = '#1A1711'; g.fill(paths[2]);
    g.fillStyle = colors[0]; g.fill(paths[0]);
    g.fillStyle = colors[1]; g.fill(paths[1]);
  }

  // ---------- SVG 차트 ----------
  function chart(el, cfg) {
    const W = Math.max(260, Math.floor(el.clientWidth)), H = cfg.h || 220;
    const m = Object.assign({ l: 36, r: 14, t: cfg.now != null ? 24 : 14, b: 24 }, cfg.m || {});
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const [x0, x1] = cfg.x, [y0, y1] = cfg.y;
    const X = v => m.l + (v - x0) / (x1 - x0) * iw;
    const Y = v => m.t + ih - (v - y0) / (y1 - y0) * ih;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(cfg.label || '')}">`;
    (cfg.yTicks || []).forEach(v => { s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${cfg.yFmt ? cfg.yFmt(v) : v}</text>`; });
    (cfg.xTicks || []).forEach(t => { s += `<text class="tick" x="${X(t.v)}" y="${H - 6}" text-anchor="middle">${t.label}</text>`; });
    if (cfg.band) {
      const p = cfg.band.pts;
      let d = p.map((q, i) => (i ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(q[2]).toFixed(1)).join('');
      d += p.slice().reverse().map(q => 'L' + X(q[0]).toFixed(1) + ' ' + Y(q[1]).toFixed(1)).join('') + 'Z';
      s += `<path d="${d}" style="fill:${cfg.band.color};fill-opacity:.16;stroke:none"/>`;
    }
    if (cfg.bars) {
      const bw = cfg.bars.w;
      cfg.bars.pts.forEach(q => { const hh = Y(y0) - Y(q[1]); if (hh > 0) s += `<rect x="${(X(q[0]) - bw / 2).toFixed(1)}" y="${Y(q[1]).toFixed(1)}" width="${bw}" height="${hh.toFixed(1)}" rx="2" style="fill:${cfg.bars.color}"/>`; });
    }
    s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${Y(y0)}" y2="${Y(y0)}"/>`;
    (cfg.hlines || []).forEach(l => { s += `<line class="target" x1="${m.l}" x2="${W - m.r}" y1="${Y(l.y)}" y2="${Y(l.y)}"/><text class="dlabel" x="${m.l + 6}" y="${Y(l.y) - 6}">${esc(l.label)}</text>`; });
    const labels = [];
    (cfg.series || []).forEach(se => {
      const d = se.pts.map((q, i) => (i ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(q[1]).toFixed(1)).join('');
      s += `<path d="${d}" style="fill:none;stroke:${se.color};stroke-width:${se.w || 2};stroke-linejoin:round;stroke-linecap:round"/>`;
      if (se.mark) { const q = se.mark; s += `<circle cx="${X(q[0])}" cy="${Y(q[1])}" r="4" style="fill:${se.color};stroke:var(--surface);stroke-width:2"/>`; }
      if (se.endLabel) { const q = se.pts[se.pts.length - 1]; labels.push({ x: X(q[0]) + 8, y: Y(q[1]) + 4, text: se.endLabel }); }
    });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    labels.forEach(l => { s += `<text class="dlabel" x="${l.x}" y="${l.y}">${esc(l.text)}</text>`; });
    if (cfg.now != null) s += `<line class="now" x1="${X(cfg.now)}" x2="${X(cfg.now)}" y1="${m.t - 6}" y2="${Y(y0)}"/><text class="nowlbl" x="${X(cfg.now)}" y="${m.t - 10}" text-anchor="middle">${esc(cfg.nowLabel || '지금')}</text>`;
    s += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${Y(y0)}" style="display:none"/>`;
    s += `<rect x="${m.l}" y="0" width="${iw}" height="${H}" style="fill:transparent"/></svg><div class="tip" hidden></div>`;
    const legend = cfg.legend ? `<div class="chart-legend">${cfg.legend.map(l => `<span><i class="${l.kind || ''}" style="background:${l.color}"></i>${esc(l.label)}</span>`).join('')}</div>` : '';
    el.innerHTML = legend + s;
    if (!cfg.tip || !cfg.snap) return;
    const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), xh = svg.querySelector('.xh');
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * W / r.width;
      const v = x0 + (px - m.l) / iw * (x1 - x0);
      let best = cfg.snap[0];
      for (const x of cfg.snap) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
      xh.setAttribute('x1', X(best)); xh.setAttribute('x2', X(best)); xh.style.display = '';
      tip.innerHTML = cfg.tip(best); tip.hidden = false;
      const left = X(best) * r.width / W, tw = tip.offsetWidth;
      tip.style.left = (left + 12 + tw > r.width ? left - 12 - tw : left + 12) + 'px';
      tip.style.top = (svg.offsetTop + 4) + 'px';
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; xh.style.display = 'none'; });
  }
  const tipRow = (color, label, val) => `<div class="row"><i style="background:${color}"></i>${esc(label)} <b>${val}</b></div>`;

  // ---------- 방문객 ----------
  const RAIL = [
    { when: 'D-1', act: '진료 예약 확인 알림톡 수신', sys: '예약 시각 · 진료과를 예측 엔진에 반영하고, 알림톡에 "주차 자리 미리 받기" 링크를 넣습니다.' },
    { when: '출발 시', act: '링크를 열어 도착 예정 시각 입력 · 내비 ETA 공유 허용', sys: '개별 도착 분포(평균 · 표준편차)를 갱신하고 배정 후보를 계산합니다.' },
    { when: '도착 15분 전', act: '배정 알림 수신', sys: '5분마다 도는 롤링 호라이즌 배정 결과로 슬롯을 hold하고 전광판 · 관제에 반영합니다.' },
    { when: '진입', act: '번호판 인식 → 전광판 방향 안내', sys: 'hold를 확정하고, 배정된 램프로 진입을 분산합니다.' },
    { when: '주차 후', act: '웹앱 도보 안내', sys: '점유 센서로 주차를 확인하고 배정 준수 로그를 남깁니다.' },
    { when: '출차', act: '정산은 기존 방식 그대로', sys: '실제 체류 시간을 출차 예측 학습 데이터로 쌓습니다.' },
  ];
  function vPlan() {
    const veh = { zone: 0, disabled: VIS.dis, ev: VIS.ev, evWant: VIS.ev, large: VIS.large };
    const at = VIS.eta - 900;
    const sn = snapAt(S.runs.rolling, at);
    const ctx = E.ctxFromSnap(fac, sn);
    const cands = E.rankSlots(fac, sn.status, veh, ctx, S.p.w, 6);
    const pick = cands[Math.min(VIS.rank, cands.length - 1)];
    const sd = VIS.share ? 240 : 480;
    const hour = Math.min(12, Math.floor(VIS.eta / 3600));
    const wp = E.walkParts(fac, pick.s, 0, hour);
    return { veh, at, sn, ctx, cands, pick, sd, holdExp: VIS.eta + 2 * sd + 600, wp, slot: fac.slots[pick.s] };
  }
  function baselineNear(t) {
    const vs = S.runs.none.V.filter(v => Math.abs(v.arr - t) <= 1800 && v.parkedAt != null);
    const avg = k => vs.reduce((a, v) => a + v[k], 0) / Math.max(1, vs.length);
    return { n: vs.length, search: avg('search'), walk: avg('walk'), gate: avg('gateWait') };
  }

  function renderVisitor() {
    const P = vPlan();
    const step = VIS.step;
    const times = ['18:00', clock(VIS.eta - 1800), clock(P.at), clock(VIS.eta), clock(VIS.eta + P.pick.drive)];
    let body = '';
    if (step === 0) {
      body = `<div class="chat">
        <div class="chat-day mono">9월 13일 (일) 오후 6:00</div>
        <div class="bubble">
          <div class="bubble-from"><span class="psign sm" aria-hidden="true">P</span>한결종합병원 · 알림톡</div>
          <p><b>김하늘</b> 님, 내일 진료 예약을 알려드립니다.</p>
          <dl><dt>일시</dt><dd>9월 14일(월) 10:30</dd><dt>진료과</dt><dd>본관 3층 심장내과</dd></dl>
          <p>도착 전에 주차 자리를 미리 받으면 층을 돌며 빈자리를 찾지 않아도 됩니다.</p>
          <button class="btn paint" type="button" data-act="next">주차 자리 미리 받기</button>
        </div>
        <p class="fine">가상 시설 · 가상 환자 예시입니다.</p>
      </div>`;
    } else if (step === 1) {
      const lead = Math.round((APPT - VIS.eta) / 60);
      body = `<h2>출발 전에 알려주세요</h2>
        <p class="lead">입력한 도착 시각의 15분 전에 자리를 배정해 알림으로 보내드립니다.</p>
        <div class="resv"><span>예약</span><b>9월 14일(월) 10:30</b><span>목적지</span><b>본관 3층 심장내과</b></div>
        <div class="field"><label for="plate">차량 번호 끝 4자리</label><input id="plate" class="plate" inputmode="numeric" maxlength="4" autocomplete="off" value="${esc(VIS.plate)}"></div>
        <div class="field"><span class="lbl">차량 조건</span><div class="opts">
          <button type="button" class="opt" data-act="attr" data-k="dis" aria-pressed="${VIS.dis}">장애인 주차</button>
          <button type="button" class="opt" data-act="attr" data-k="ev" aria-pressed="${VIS.ev}">전기차 충전</button>
          <button type="button" class="opt" data-act="attr" data-k="large" aria-pressed="${VIS.large}">대형차</button>
        </div></div>
        <div class="field"><span class="lbl">도착 예정 시각</span><div class="stepper">
          <button type="button" data-act="eta" data-d="-300" aria-label="5분 앞당기기">−5분</button>
          <output>${clock(VIS.eta)}<small>${lead >= 0 ? `예약 ${lead}분 전` : `예약 ${-lead}분 후`}</small></output>
          <button type="button" data-act="eta" data-d="300" aria-label="5분 늦추기">+5분</button>
        </div></div>
        <label class="switch"><input type="checkbox" data-act="share" ${VIS.share ? 'checked' : ''}><span>내비 ETA 자동 공유<small>켜면 도착 시각 오차가 줄어(σ 8분 → 4분) 자리 보관 시간을 정확히 잡습니다.</small></span></label>
        <label class="switch"><input type="checkbox" data-act="consent" ${VIS.consent ? 'checked' : ''}><span>출발 · 도착 시각 공유에 동의합니다<small>주차 안내에만 쓰고, 세션이 끝나면 24시간 안에 원본을 지웁니다.</small></span></label>
        <button class="btn" type="button" data-act="next" ${VIS.consent ? '' : 'disabled'}>자리 받기</button>
        ${VIS.consent ? '' : '<p class="fine">동의에 체크하면 버튼이 켜집니다.</p>'}`;
    } else if (step === 2) {
      const sl = P.slot, tn = turnOf(sl, P.pick.ramp);
      body = `${VIS.reassigned ? `<div class="notice"><b>자리가 바뀌었어요.</b> ${esc(VIS.reassigned)}에 다른 차량이 먼저 주차해, 목적지에서 가까운 다음 자리로 다시 배정했습니다.</div>` : ''}
        <p class="fine mono">${clock(P.at)} 배정 · 도착 15분 전 알림</p>
        <div class="slotsign" aria-label="배정 자리 ${FL[sl.f]} ${sl.zone}구역 ${sl.num}번">
          <div class="flr">${FL[sl.f]}</div><div class="zn">${sl.zone}구역 · ${LANE_KO[sl.lane]} 통로</div><div class="no">${sl.num}<small>번</small></div>
        </div>
        <p style="margin:0;font-size:14px"><b>본관 3층 심장내과</b>와 가장 가까운 <b>${P.wp.elev} 승강기</b> 쪽 자리예요.</p>
        <div class="facts">
          <div><span>주차장 안 주행</span><b>${dur(P.pick.drive)}</b></div>
          <div><span>진료과까지 도보</span><b>${dur(P.pick.walk)}</b></div>
          <div><span>자리 보관</span><b>${clock(P.holdExp)}까지</b></div>
          <div><span>진입 램프</span><b>${E.RAMPS[P.pick.ramp].name}</b></div>
        </div>
        <div class="ph-map"><canvas id="phMap" aria-label="배정 자리와 경로 지도"></canvas></div>
        <ol class="route">
          <li>${E.RAMPS[P.pick.ramp].name}로 들어와 ${FL[sl.f]}까지 내려가세요</li>
          <li>${tn.word === '직진' ? '중앙 통로로 직진' : `${tn.word} 후 ${LANE_KO[sl.lane]} 통로`}</li>
          <li>${sl.zone}구역 ${sl.num}번 · 노란 표시등이 켜진 자리</li>
        </ol>
        <button class="btn" type="button" data-act="next">게이트 진입</button>
        ${VIS.reassigned ? '' : '<button class="linkbtn" type="button" data-act="reassign">다른 차가 먼저 주차하면?</button>'}`;
    } else if (step === 3) {
      body = `<h2>게이트 통과</h2>
        <p class="lead">번호판을 인식하면 보관 중인 자리가 확정되고, 전광판이 방향을 알려줍니다.</p>
        <canvas id="phLed" class="led" aria-label="게이트 전광판"></canvas>
        <div class="facts">
          <div><span>인식 번호</span><b class="mono">··${esc(VIS.plate)}</b></div>
          <div><span>자리 상태</span><b>hold → 확정</b></div>
          <div><span>진입 램프</span><b>${E.RAMPS[P.pick.ramp].name}</b></div>
          <div><span>자리까지</span><b>${dur(P.pick.drive)}</b></div>
        </div>
        <button class="btn" type="button" data-act="next">주차 완료</button>`;
    } else {
      const wp = P.wp, parkT = VIS.eta + P.pick.drive, arriveT = parkT + wp.total;
      const spare = Math.round((APPT - arriveT) / 60);
      body = `<h2>진료과까지 이렇게 가세요</h2>
        <ol class="steps">
          <li><span class="n done">✓</span><span>${P.slot.label}에 주차 확인 (점유 센서)</span><span class="t">${clock(parkT)}</span></li>
          <li><span class="n">1</span><span>${wp.elev} 승강기까지 ${wp.toElevM}m 걷기</span><span class="t">${dur(wp.toElevS)}</span></li>
          <li><span class="n">2</span><span>승강기 대기 (이 시간대 평균)</span><span class="t">${dur(wp.waitS)}</span></li>
          <li><span class="n">3</span><span>${ZN[0].fl}층으로 이동</span><span class="t">${dur(wp.rideS)}</span></li>
          <li><span class="n">4</span><span>내려서 심장내과 입구까지 ${wp.lobbyM}m</span><span class="t">${dur(wp.lobbyS)}</span></li>
        </ol>
        <div class="facts">
          <div><span>진료과 도착 예상</span><b>${clock(arriveT)}</b></div>
          <div><span>예약까지 여유</span><b>${spare}분</b></div>
        </div>
        <div class="field"><span class="lbl">오늘 주차 안내가 도움이 됐나요? (1문항)</span>
          <div class="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-act="rate" data-v="${n}" aria-pressed="${VIS.rating === n}">${n}</button>`).join('')}</div>
        </div>
        ${VIS.rating ? '<p class="fine">응답을 기록했습니다(예시). 출차 정산은 기존 방식 그대로입니다.</p><button class="btn ghost" type="button" data-act="restart">처음부터 다시 보기</button>' : ''}`;
    }
    $('#screen').innerHTML = `<div class="ph-status mono"><span>${times[step]}</span><span>LTE</span></div>
      <div class="ph-app"><span class="psign sm" aria-hidden="true">P</span>자리먼저${step > 0 ? '<button class="linkbtn" type="button" data-act="back" style="margin-left:10px">이전</button>' : ''}<span class="ph-step">${step + 1}/5</span></div>
      <div class="scr">${body}</div>`;

    const cur = VIS.step === 4 && VIS.rating ? 5 : VIS.step;
    $('#rail').innerHTML = RAIL.map((r, i) => `<li class="${i < cur ? 'past' : i === cur ? 'cur' : ''}"><span class="when">${r.when}</span><span class="dot"></span><div class="body"><b>${r.act}</b><p>${r.sys}</p></div></li>`).join('');
    renderDetail(P);

    if (step === 2) {
      const status = P.sn.status.slice();
      drawFloor($('#phMap'), P.slot.f, status, { hl: { s: P.pick.s, ramp: P.pick.ramp, elev: P.wp.elevIdx } });
    }
    if (step === 3) {
      const tn = turnOf(P.slot, P.pick.ramp);
      drawLED($('#phLed'), [`${VIS.plate} 차량`, `${FL[P.slot.f]} ${P.slot.zone}-${P.slot.num} ${tn.arrow}${tn.word}`], ['#7CFF9B', '#FFB02E']);
    }
  }

  function renderDetail(P) {
    const el = $('#detail');
    if (VIS.step <= 1) {
      const sd = VIS.share ? 240 : 480;
      el.innerHTML = `<h3>엔진이 받는 입력</h3>
        <p class="muted">번호판 · 연락처 원문은 플랫폼에 저장하지 않습니다. 예약 어댑터가 익명 토큰과 예약 시각 · 목적지 존만 넘깁니다.</p>
        <div class="tbl-wrap"><table class="data">
          <tbody>
            <tr><td>예약</td><td>10:30 · 본관 3층 심장내과 (존 CARD)</td></tr>
            <tr><td>도착 분포</td><td>${VIS.step === 0 ? '예약 기반 사전분포 · 평균 10:08, σ 11분' : `${VIS.share ? '내비 ETA' : '직접 입력'} · 평균 ${clock(VIS.eta)}, σ ${sd / 60}분`}</td></tr>
            <tr><td>배정 시점</td><td>${clock(VIS.eta - 900)} (도착 15분 전, 5분 주기 재계산)</td></tr>
            <tr><td>hold 유효</td><td>${clock(VIS.eta + 2 * sd + 600)}까지 (도착 + 2σ + 10분)</td></tr>
            <tr><td>차량 조건</td><td>${[VIS.dis && '장애인', VIS.ev && '전기차 충전', VIS.large && '대형차'].filter(Boolean).join(' · ') || '없음'}</td></tr>
          </tbody>
        </table></div>`;
      return;
    }
    const w = S.p.w, b = baselineNear(VIS.eta);
    const free = P.sn.status.reduce((a, s) => a + (s === E.FREE ? 1 : 0), 0);
    const held = P.sn.status.reduce((a, s) => a + (s === E.HELD ? 1 : 0), 0);
    const rows = P.cands.slice(0, 5).map((c, i) => `<tr class="${c.s === P.pick.s ? 'pick' : ''}"><td>${i + 1}</td><td class="lab">${fac.slots[c.s].label}</td><td>${E.RAMPS[c.ramp].id}</td><td>${Math.round(c.drive)}</td><td>${Math.round(c.walk)}</td><td>${Math.round(c.rampP)}</td><td>${Math.round(c.floorP)}</td><td>${Math.round(c.mis)}</td><td><b>${Math.round(c.total)}</b></td></tr>`).join('');
    const us = P.pick.drive + P.pick.walk, them = b.search + b.walk;
    el.innerHTML = `<h3>배정 엔진 계산 내역 · ${clock(P.at)} 주차장 상태 기준</h3>
      <p class="muted">빈자리 ${free}면 · hold ${held}면 · 서측 게이트 대기 ${Math.round(Math.max(0, P.sn.gateNext[0] - P.sn.t))}초. cost = ${w.w1}·주행 + ${w.w2}·도보(승강기 대기 포함) + ${w.w3}·램프 혼잡 + ${w.w4}·층 균형 + ${w.w5}·속성 불일치, 단위는 초 환산입니다.</p>
      <div class="tbl-wrap"><table class="data">
        <thead><tr><th>순위</th><th>슬롯</th><th>램프</th><th>주행</th><th>도보</th><th>램프 혼잡</th><th>층 균형</th><th>속성</th><th>비용</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="compare">
        <div class="us"><span>자리먼저 안내</span><b>${dur(us)}</b><small>주행 ${dur(P.pick.drive)} + 도보 ${dur(P.pick.walk)}</small></div>
        <div><span>혼자 찾을 때 (같은 시간대 평균)</span><b>${dur(them)}</b><small>탐색 ${dur(b.search)} + 도보 ${dur(b.walk)} · 시뮬레이션 ${b.n}대</small></div>
      </div>`;
  }

  function visitorClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || btn.tagName === 'INPUT') return;
    const act = btn.dataset.act;
    if (act === 'next') { VIS.step = Math.min(4, VIS.step + 1); }
    else if (act === 'back') { VIS.step = Math.max(0, VIS.step - 1); }
    else if (act === 'attr') { VIS[btn.dataset.k] = !VIS[btn.dataset.k]; VIS.rank = 0; VIS.reassigned = null; }
    else if (act === 'eta') { VIS.eta = Math.max(8400, Math.min(13500, VIS.eta + +btn.dataset.d)); VIS.rank = 0; VIS.reassigned = null; }
    else if (act === 'reassign') { VIS.reassigned = vPlan().slot.label; VIS.rank = 1; }
    else if (act === 'rate') { VIS.rating = +btn.dataset.v; }
    else if (act === 'restart') { Object.assign(VIS, { step: 0, rank: 0, reassigned: null, rating: 0, consent: false }); }
    else return;
    renderVisitor();
    const scr = $('.scr');
    if (scr && (act === 'next' || act === 'back' || act === 'restart')) { scr.scrollTop = 0; if (window.innerWidth <= 760) $('#screen').scrollIntoView({ block: 'start' }); }
  }
  function visitorChange(ev) {
    const act = ev.target.dataset.act;
    if (act === 'share') { VIS.share = ev.target.checked; renderVisitor(); }
    else if (act === 'consent') { VIS.consent = ev.target.checked; renderVisitor(); }
  }
  function visitorInput(ev) {
    if (ev.target.id === 'plate') { ev.target.value = ev.target.value.replace(/\D/g, '').slice(0, 4); VIS.plate = ev.target.value || '0000'; }
  }

  // ---------- 운영 대시보드 ----------
  const OPS = [
    { type: 'openB3D', name: 'B3 D구역 임시 개방', desc: '평시 폐쇄 42면을 지금부터 연다' },
    { type: 'staffW', name: '서측 램프 유도요원 배치', desc: '게이트 처리 11초 → 8초, 비배정 차량 20%를 동측으로 유도' },
    { type: 'engineOff', name: '배정 엔진 중지 (열화 모드 점검)', desc: 'hold를 모두 풀고 기존 방식 주차로 전환' },
  ];
  function renderOps() {
    const run = S.live, t = S.t, sn = snapAt(run, t), se = serAt(run, t);
    const open = se.open[0] + se.open[1] + se.open[2], occ = se.occ[0] + se.occ[1] + se.occ[2], held = se.held[0] + se.held[1] + se.held[2];
    const free = open - occ - held;
    const n30 = fc(t, t + 1800, t);
    const asg = run.V.filter(v => v.part && v.arr <= t && v.assignedAt >= 0);
    const comp = asg.length ? asg.filter(v => v.comply).length / asg.length : 0;
    const gw = se.gateWait.map(Math.round);
    const gateChip = w => w >= 45 ? '<span class="chip crit">병목</span>' : w >= 20 ? '<span class="chip warn">대기 증가</span>' : '<span class="chip ok">원활</span>';
    $('#kpis').innerHTML = [
      { l: '현재 점유율', v: pct((occ + held) / open), sub: `주차 ${occ} · 빈자리 ${free} / ${open}면` },
      { l: '배정 보관 (hold)', v: held + '<small>면</small>', sub: `가용 대비 ${pct(held / Math.max(1, free + held))} · 상한 ${pct(S.p.holdCap)}` },
      { l: '다음 30분 도착 예측', v: Math.round(n30.p50) + '<small>대</small>', sub: `P10–P90 ${Math.round(n30.p10)}–${Math.round(n30.p90)}대` },
      { l: '서측 게이트 대기', v: gw[0] + '<small>초</small>', sub: `${gateChip(gw[0])} 탐색 중 ${sn.searching[0]}대` },
      { l: '동측 게이트 대기', v: gw[1] + '<small>초</small>', sub: `${gateChip(gw[1])} 탐색 중 ${sn.searching[1]}대` },
      { l: '오늘 배정 준수율', v: asg.length ? pct(comp) : '—', sub: `${asg.length}대 기준 · ${comp >= 0.6 ? '<span class="chip ok">H2 60% 이상</span>' : '<span class="chip warn">H2 기준 미달</span>'}` },
    ].map(k => `<div class="kpi"><span class="lbl">${k.l}</span><span class="val">${k.v}</span><span class="sub">${k.sub}</span></div>`).join('');

    // 지도
    $$('#floorSeg button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.f === S.floor)));
    drawFloor($('#opsMap'), S.floor, sn.status, { sel: S.sel });
    if (S.sel != null) {
      const s = fac.slots[S.sel], st = sn.status[S.sel], hv = sn.holder[S.sel];
      const attrs = [s.disabled && '장애인 전용', s.ev && '전기차 충전', s.compact && '경차'].filter(Boolean).join(' · ');
      const who = st === E.HELD && hv >= 0 ? ` — 차량 ··${run.V[hv].plate4} 보관 중, 도착 예상 ${clock(run.V[hv].eta)}` : '';
      $('#slotInfo').innerHTML = `<b>${s.label}</b> ${STATUS_KO[st]}${who}${attrs ? ` · ${attrs}` : ''}`;
    }
    $('#floorBars').innerHTML = [0, 1, 2].map(f => {
      const o = se.open[f] || 1, a = se.occ[f] / o, h = se.held[f] / o;
      return `<div class="fbar"><strong>${FL[f]}</strong>${pct(a + h)} · hold ${se.held[f]}<div class="track"><i style="width:${a * 100}%;background:var(--occ)"></i><i style="width:${h * 100}%;background:var(--paint)"></i></div></div>`;
    }).join('');

    // 도착 예측
    const bNow = Math.floor(t / 900);
    const bs = []; for (let b = Math.max(0, bNow - 6); b <= Math.min(47, bNow + 8); b++) bs.push(b);
    const pts = bs.map(b => {
      const started = b * 900 < t;
      const f = started ? fc(b * 900, b * 900 + 900, b * 900 - 1800) : fc(b * 900, b * 900 + 900, t);
      return { b, x: b * 900 + 450, f, past: (b + 1) * 900 <= t, act: S.actual[b] };
    });
    const ymax = niceScale(Math.max(...pts.map(p => Math.max(p.f.p90, p.past ? p.act : 0))) * 1.08, 4);
    const fcEl = $('#fcChart');
    const bw = Math.max(4, (fcEl.clientWidth - 50) / bs.length * 0.5);
    chart(fcEl, {
      h: 230, label: '15분 단위 도착 대수 예측과 실측',
      x: [bs[0] * 900, (bs[bs.length - 1] + 1) * 900], y: [0, ymax.max],
      yTicks: [0, 1, 2, 3, 4].map(i => i * ymax.step),
      xTicks: bs.filter(b => b % 2 === 0).map(b => ({ v: b * 900, label: clock(b * 900) })),
      bars: { pts: pts.filter(p => p.past).map(p => [p.x, p.act]), w: bw, color: 'var(--occ)' },
      band: { pts: pts.map(p => [p.x, p.f.p10, p.f.p90]), color: 'var(--ink)' },
      series: [{ pts: pts.map(p => [p.x, p.f.p50]), color: 'var(--ink)' }],
      now: t, nowLabel: '지금 ' + clock(t),
      legend: [{ label: '실측 도착', color: 'var(--occ)', kind: 'bar' }, { label: 'P50 예측', color: 'var(--ink)' }, { label: 'P10–P90', color: 'var(--ink)', kind: 'band' }],
      snap: pts.map(p => p.x),
      tip: x => { const p = pts.find(q => q.x === x); return `<div class="mono">${clock(p.b * 900)}–${clock(p.b * 900 + 900)}</div>${tipRow('var(--ink)', 'P50', Math.round(p.f.p50) + '대')}<div>P10–P90 <b>${Math.round(p.f.p10)}–${Math.round(p.f.p90)}대</b></div>${p.past ? tipRow('var(--occ)', '실측', p.act + '대') : '<div class="fine">아직 오지 않은 구간</div>'}`; },
    });
    $('#fcMeta').textContent = `오늘 MAPE ${pct(S.score.mape, 1)} · P10–P90 적중 ${pct(S.score.coverage)}`;

    // 층별 점유율
    const occEl = $('#occChart');
    const ser = run.series.filter(s => s.t <= E.T_END);
    const rate = (s, f) => s.open[f] ? (s.occ[f] + s.held[f]) / s.open[f] * 100 : 0;
    const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
    const nowS = serAt(run, t);
    chart(occEl, {
      h: 210, label: '층별 점유율 추이', m: { r: 64 },
      x: [0, E.T_END], y: [0, 100], yTicks: [0, 25, 50, 75, 100], yFmt: v => v + '%',
      xTicks: [0, 2, 4, 6, 8, 10, 12].map(h => ({ v: h * 3600, label: pad(7 + h) + '시' })),
      series: [0, 1, 2].map(f => ({ pts: ser.map(s => [s.t, rate(s, f)]), color: colors[f], endLabel: `${FL[f]} ${Math.round(rate(nowS, f))}%`, mark: [t, rate(nowS, f)] })),
      now: t,
      legend: [0, 1, 2].map(f => ({ label: FL[f], color: colors[f] })),
      snap: ser.map(s => s.t),
      tip: x => { const s = serAt(run, x); return `<div class="mono">${clock(x)}</div>` + [0, 1, 2].map(f => tipRow(colors[f], FL[f], Math.round(rate(s, f)) + '%')).join(''); },
    });

    // 경보
    const alerts = [];
    [0, 1, 2].forEach(f => {
      const r = se.open[f] ? (se.occ[f] + se.held[f]) / se.open[f] : 0;
      if (r >= 0.95) alerts.push({ sev: 'crit', text: `${FL[f]} 만차 임박 — 점유 ${pct(r)}` });
      else if (r >= 0.88) alerts.push({ sev: 'warn', text: `${FL[f]} 혼잡 — 점유 ${pct(r)}` });
    });
    ['서측', '동측'].forEach((nm, k) => {
      if (gw[k] >= 45) alerts.push({ sev: 'crit', text: `${nm} 램프 병목 — 진입 대기 ${gw[k]}초` });
      else if (gw[k] >= 20) alerts.push({ sev: 'warn', text: `${nm} 램프 대기 증가 — ${gw[k]}초` });
    });
    if (n30.p90 > free * 0.5) alerts.push({ sev: n30.p90 > free ? 'crit' : 'warn', text: `다음 30분 도착 P90 ${Math.round(n30.p90)}대 · 빈자리 ${free}면` });
    const closedNow = sn.status.some(st => st === E.CLOSED);
    if (closedNow && (occ + held) / open >= 0.8) alerts.push({ sev: 'info', text: 'B3 D구역 임시 개방을 권장합니다 (+42면)', op: 'openB3D' });
    const chip = { crit: '<span class="chip crit"><i class="hatch"></i>경보</span>', warn: '<span class="chip warn">주의</span>', info: '<span class="chip info">제안</span>', ok: '<span class="chip ok">정상</span>' };
    if (!alerts.length) alerts.push({ sev: 'ok', text: '모든 층과 램프가 정상 범위입니다' });
    $('#alerts').innerHTML = alerts.map(a => `<li>${chip[a.sev]}<span>${a.text}</span>${a.op ? `<button class="btn sm ghost" type="button" data-op="${a.op}">적용</button>` : '<span></span>'}</li>`).join('');

    // 운영 조치
    $('#opsActions').innerHTML = OPS.map(o => {
      const applied = S.liveOps.find(x => x.type === o.type);
      const always = o.type === 'openB3D' && S.p.b3;
      return `<button class="opbtn" type="button" data-op="${o.type}" ${applied || always ? 'disabled' : ''}><b>${o.name}</b><span>${always ? '시뮬레이터 설정에서 상시 개방 중' : o.desc}</span>${applied ? `<span class="chip held">${clock(applied.t)} 적용</span>` : always ? '<span class="chip neutral">상시</span>' : '<span class="chip neutral">한 번 누르면 적용</span>'}</button>`;
    }).join('') + (S.liveOps.length ? '<button class="linkbtn" type="button" data-op="reset">조치 모두 취소</button>' : '');
    if (S.liveOps.length) {
      const a = S.runs.rolling.metrics, b = S.live.metrics;
      const row = (label, x, y) => `${label} <b>${dur(x)} → ${dur(y)}</b>`;
      $('#opResult').innerHTML = `<div class="op-result">조치를 반영해 하루를 다시 계산했습니다 (조치 전 → 후, 하루 전체): ${row('평균 탐색', a.search, b.search)} · ${row('피크 진입', a.peakEntry, b.peakEntry)} · ${row('게이트 대기', a.gate, b.gate)}</div>`;
    } else $('#opResult').innerHTML = '';

    // 예외
    const KIND = { ignore: ['warn', '배정 무시'], conflict: ['crit', '이중 점유'], sensor: ['crit', '센서'], expire: ['neutral', 'hold 만료'], reassign: ['info', '재배정'], op: ['held', '운영 조치'] };
    const ex = run.log.filter(e => KIND[e.kind] && e.t <= t && e.t > t - 3600).slice(-9).reverse();
    $('#exceptions').innerHTML = ex.length ? ex.map(e => `<li><span class="mono">${clock(e.t)}</span><span class="chip ${KIND[e.kind][0]}">${KIND[e.kind][1]}</span><span>${esc(e.text)}</span></li>`).join('') : '<li class="empty">최근 60분 동안 예외가 없습니다.</li>';
  }
  function applyOp(type) {
    if (type === 'reset') { S.liveOps = []; }
    else if (!S.liveOps.find(o => o.type === type)) S.liveOps.push({ t: Math.max(300, S.t), type });
    rerunLive();
    renderOps();
  }

  // ---------- 전광판 ----------
  function renderBoard() {
    const run = S.live, t = S.t, sn = snapAt(run, t), fr = freeByFloor(sn.status);
    const vacancy = `B1 ${fr[0]} B2 ${fr[1]} B3 ${fr[2]}`;
    [0, 1].forEach(ramp => {
      let e = null;
      for (let i = run.log.length - 1; i >= 0; i--) { const x = run.log[i]; if (x.t > t) continue; if (x.kind === 'enter' && x.ramp === ramp) { e = x; break; } }
      const id = ramp === 0 ? 'W' : 'E';
      let lines, note;
      if (e && t - e.t <= 240) {
        const v = run.V[e.v];
        if (e.guided) {
          const s = fac.slots[e.s], tn = turnOf(s, ramp);
          lines = [`${v.plate4} 차량`, `${FL[s.f]} ${s.zone}-${s.num} ${tn.arrow}${tn.word}`];
          note = `배정 차량 인식 · hold 확정 → ${s.label}로 방향 안내`;
        } else {
          lines = [`${v.plate4} 차량`, vacancy];
          note = '배정 없는 차량 · 층별 빈자리 표시 (기존 방식)';
        }
        $('#cap' + id).textContent = '최근 인식 ' + clock(e.t);
      } else {
        lines = ['한결종합병원', `빈자리 ${fr[0] + fr[1] + fr[2]}`];
        note = '대기 중 · 진입 차량 없음';
        $('#cap' + id).textContent = clock(t);
      }
      drawLED($('#led' + id), lines, ['#7CFF9B', '#FFB02E']);
      $('#note' + id).textContent = note;
    });
    const KIND = { enter: '입차', 'assign': '배정', 'gate-assign': '게이트 배정', reassign: '재배정', ignore: '배정 무시', conflict: '이중 점유', sensor: '센서', expire: 'hold 만료', op: '운영 조치' };
    const rows = run.log.filter(e => e.t <= t && e.t > t - 1800).slice(-40).reverse();
    $('#evlog').innerHTML = `<thead><tr><th>시각</th><th>구분</th><th>게이트</th><th>내용</th></tr></thead><tbody>` +
      (rows.length ? rows.map(e => `<tr><td class="mono">${clock(e.t)}</td><td>${KIND[e.kind] || e.kind}</td><td>${e.ramp != null ? E.RAMPS[e.ramp].id : '—'}</td><td style="text-align:left">${esc(e.text)}</td></tr>`).join('') : '<tr><td colspan="4">최근 30분 기록이 없습니다.</td></tr>') + '</tbody>';
  }

  // ---------- 시뮬레이터 ----------
  function renderSim() {
    const n = S.runs.none.metrics, g = S.runs.greedy.metrics, r = S.runs.rolling.metrics;
    const h3 = 1 - r.walkGuided / r.walkOthers, h4 = 1 - r.peakEntry / n.peakEntry;
    const H = [
      { id: 'H1', txt: '30분 단위 도착 대수 예측', res: pct(S.score.mape, 1), sub: `MAPE · 목표 20% 이내 · P10–P90 적중 ${pct(S.score.coverage)}`, ok: S.score.mape <= 0.2 },
      { id: 'H2', txt: '배정 슬롯 준수율', res: pct(S.p.compliance), sub: '입력한 가정 · 목표 60% 이상 · 파일럿 실측 필요', ok: null },
      { id: 'H3', txt: '주차 후 도보 · 승강기 대기', res: '−' + pct(Math.max(0, h3)), sub: `배정군 ${dur(r.walkGuided)} vs 비배정군 ${dur(r.walkOthers)} · 목표 25%`, ok: h3 >= 0.25 },
      { id: 'H4', txt: '피크 진입 시간 (09–11시)', res: '−' + pct(Math.max(0, h4)), sub: `${dur(n.peakEntry)} → ${dur(r.peakEntry)} · 목표 20%`, ok: h4 >= 0.2 },
    ];
    $('#hyps').innerHTML = H.map(h => `<div class="hyp"><div class="hid"><b>${h.id}</b>${h.ok == null ? '<span class="chip neutral">가정값</span>' : h.ok ? '<span class="chip ok">기준 충족</span>' : '<span class="chip warn">기준 미달</span>'}</div><p>${h.txt}</p><div class="res">${h.res}</div><p>${h.sub}</p></div>`).join('');

    const M = [
      ['평균 탐색 시간', '게이트 통과 → 주차 완료', 'search', 'sec', true],
      ['피크 진입 소요', '09–11시 도착, 게이트 대기 + 탐색', 'peakEntry', 'sec', true],
      ['평균 도보 + 승강기', '주차 → 진료과 입구', 'walk', 'sec', true],
      ['게이트 대기', '하루 평균', 'gate', 'sec', true],
      ['층별 점유율 편차', '09–15시 평균', 'floorStd', 'pp', true],
      ['재배정률', '배정 차량 대비', 'reassignRate', 'pct', false],
      ['hold 만료율', '늦게 온 차량', 'expireRate', 'pct', false],
      ['배정 실패율', '참여했지만 자리 없이 도착', 'failRate', 'pct', false],
    ];
    const fmt = (v, u) => u === 'sec' ? dur(v) : u === 'pp' ? v.toFixed(1) + '%p' : pct(v, 1);
    const cell = (m, run, row) => {
      if (run === n && !row[4]) return '<td class="muted">—</td>';
      const v = m[row[2]];
      let d = '';
      if (row[4] && run !== n && n[row[2]] > 0) { const x = (v - n[row[2]]) / n[row[2]]; d = `<span class="dlt ${x < 0 ? 'good' : 'bad'}">${x < 0 ? '▼' : '▲'}${pct(Math.abs(x))}</span>`; }
      return `<td><b>${fmt(v, row[3])}</b>${d}</td>`;
    };
    $('#cmpTable').innerHTML = `<thead><tr><th>지표</th><th>자율 탐색 (현재 방식)</th><th>그리디 배정</th><th>롤링 호라이즌 배정</th></tr></thead><tbody>` +
      M.map(row => `<tr><td class="metric">${row[0]}<small>${row[1]}</small></td>${cell(n, S.runs.none, row)}${cell(g, S.runs.greedy, row)}${cell(r, S.runs.rolling, row)}</tr>`).join('') + '</tbody>';
    $('#cmpMeta').textContent = `도착 ${r.n.toLocaleString()}대 · 링크 참여 ${r.participants}대 · 안내 따른 차량 ${r.guided}대`;
    const parts = [];
    parts.push(`롤링 호라이즌은 다음 30분 도착 차량을 함께 놓고 풀기 때문에, 그리디보다 재배정률이 <b>${pct(g.reassignRate, 1)} → ${pct(r.reassignRate, 1)}</b>로 낮습니다.`);
    if (h3 < 0.25) parts.push(`H3는 <b>${pct(h3)}</b>로 기준(25%)에 못 미칩니다. 도보 시간의 절반 이상이 승강기 대기 · 탑승이라 슬롯 배정만으로 줄일 수 있는 몫에 한계가 있고, 승강기별 대기 분산이 다음 검증 과제입니다.`);
    $('#insightPolicy').innerHTML = parts.join(' ');

    const sw = S.sweep, el = $('#sweepChart');
    if (sw.length < 11) { el.innerHTML = `<p class="empty">준수율 0~100% 시뮬레이션 계산 중… (${sw.length}/11)</p>`; $('#insightSweep').textContent = ''; return; }
    const vals = sw.flatMap(p => [p.entry, p.search]).map(v => v * 100);
    const lo = Math.min(0, Math.floor(Math.min(...vals) / 10) * 10), sc = niceScale(Math.max(...vals) * 1.1, 4);
    const ticks = []; for (let v = lo; v <= sc.max + 1e-9; v += sc.step) ticks.push(Math.round(v * 10) / 10);
    const cols = ['var(--s1)', 'var(--s2)'];
    chart(el, {
      h: 240, label: '준수율별 감소율', m: { r: 96 },
      x: [0, 100], y: [lo, sc.max], yTicks: ticks, yFmt: v => v + '%',
      xTicks: [0, 20, 40, 60, 80, 100].map(v => ({ v, label: v + '%' })),
      hlines: [{ y: 20, label: 'H4 기준 20%' }],
      series: [
        { pts: sw.map(p => [p.c * 100, p.entry * 100]), color: cols[0], endLabel: '피크 진입 시간' },
        { pts: sw.map(p => [p.c * 100, p.search * 100]), color: cols[1], endLabel: '평균 탐색 시간' },
      ],
      now: S.p.compliance * 100, nowLabel: '현재 가정',
      legend: [{ label: '피크 진입 시간 감소 (H4)', color: cols[0] }, { label: '평균 탐색 시간 감소', color: cols[1] }],
      snap: sw.map(p => p.c * 100),
      tip: x => { const p = sw.find(q => Math.abs(q.c * 100 - x) < 1e-6); return `<div class="mono">준수율 ${Math.round(x)}%</div>${tipRow(cols[0], '피크 진입', '−' + pct(p.entry, 1))}${tipRow(cols[1], '평균 탐색', '−' + pct(p.search, 1))}`; },
    });
    let cross = null;
    for (let i = 1; i < sw.length; i++) if (sw[i - 1].entry < 0.2 && sw[i].entry >= 0.2) { cross = (sw[i - 1].c + (0.2 - sw[i - 1].entry) / (sw[i].entry - sw[i - 1].entry) * 0.1) * 100; break; }
    if (sw[0].entry >= 0.2) cross = 0;
    $('#insightSweep').innerHTML = cross == null
      ? '준수율 0~100% 전 구간에서 H4 기준(20%)에 못 미칩니다. 가중치나 hold 상한을 바꿔 보세요.'
      : `준수율이 약 <b>${Math.round(cross)}%</b>를 넘으면 피크 진입 시간 20% 감소(H4)를 달성합니다. 준수율이 낮아도 효과가 0이 되지 않고 비례해 줄어든다는 점이 R2(방문객이 배정을 따르지 않음)의 완충 근거입니다.`;
  }

  function bindSim() {
    const sel = $('#simSeed');
    sel.innerHTML = SEEDS.map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
    const map = [['simComp', 'compliance', 'oComp', 100], ['simPart', 'participation', 'oPart', 100], ['simEta', 'etaShare', 'oEta', 100], ['simCap', 'holdCap', 'oCap', 100]];
    const sync = () => {
      sel.value = S.p.seed;
      map.forEach(([id, k, o, mul]) => { $('#' + id).value = Math.round(S.p[k] * mul); $('#' + o).textContent = Math.round(S.p[k] * mul) + '%'; });
      ['w1', 'w2', 'w3', 'w4', 'w5'].forEach(k => { $('#' + k).value = S.p.w[k]; $('#o' + k).textContent = S.p.w[k].toFixed(1); });
      $('#simB3').checked = S.p.b3;
    };
    sync();
    const stale = () => { $('#simStale').hidden = false; };
    sel.addEventListener('change', () => { S.p.seed = +sel.value; stale(); });
    map.forEach(([id, k, o]) => $('#' + id).addEventListener('input', e => { S.p[k] = +e.target.value / 100; $('#' + o).textContent = e.target.value + '%'; stale(); }));
    ['w1', 'w2', 'w3', 'w4', 'w5'].forEach(k => $('#' + k).addEventListener('input', e => { S.p.w[k] = +e.target.value; $('#o' + k).textContent = (+e.target.value).toFixed(1); stale(); }));
    $('#simB3').addEventListener('change', e => { S.p.b3 = e.target.checked; stale(); });
    $('#simRun').addEventListener('click', () => {
      const btn = $('#simRun'); btn.disabled = true; btn.textContent = '계산 중…';
      setTimeout(() => {
        S.p.w = Object.assign({}, S.p.w);
        runScenario(); VIS.rank = 0; VIS.reassigned = null;
        $('#simStale').hidden = true; btn.disabled = false; btn.textContent = '시뮬레이션 실행';
        renderSim();
      }, 20);
    });
  }

  // ---------- 공통 ----------
  const PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 16 16"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>';
  function setPlaying(on) {
    S.playing = on;
    clearInterval(S.timer);
    if (on) {
      if (S.t >= E.T_END) S.t = 0;
      S.timer = setInterval(() => { S.t = Math.min(E.T_END, S.t + 300); if (S.t >= E.T_END) setPlaying(false); render(); }, 700);
    }
    $('#play').innerHTML = on ? PAUSE : PLAY;
    $('#play').setAttribute('aria-label', on ? '일시 정지' : '시간 흐름 재생');
  }
  function render() {
    const v = S.view;
    $('.app').dataset.view = v;
    $$('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
    $$('.view').forEach(sec => { sec.hidden = sec.id !== 'view-' + v; });
    $('#time').value = S.t; $('#timeOut').textContent = clock(S.t);
    if (v === 'visitor') renderVisitor();
    else if (v === 'ops') renderOps();
    else if (v === 'board') renderBoard();
    else if (v === 'sim') renderSim();
  }
  function go(v) {
    S.view = v;
    try { history.replaceState(null, '', '#' + v); } catch (e) { /* 샌드박스에서는 무시 */ }
    render();
    window.scrollTo(0, 0);
  }

  function init() {
    runScenario();
    bindSim();
    const h = (location.hash || '').slice(1);
    if (['visitor', 'ops', 'board', 'sim', 'notes'].includes(h)) S.view = h;
    $$('.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
    $('#time').addEventListener('input', e => { S.t = +e.target.value; render(); });
    $('#play').addEventListener('click', () => setPlaying(!S.playing));
    $('#screen').addEventListener('click', visitorClick);
    $('#screen').addEventListener('change', visitorChange);
    $('#screen').addEventListener('input', visitorInput);
    $('#floorSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.floor = +b.dataset.f; S.sel = null; $('#slotInfo').textContent = '슬롯을 누르면 상태와 보관 중인 차량이 표시됩니다.'; renderOps(); });
    $('#opsMap').addEventListener('click', e => { const s = slotAt($('#opsMap'), S.floor, e); if (s != null) { S.sel = s; renderOps(); } });
    $('#view-ops').addEventListener('click', e => { const b = e.target.closest('[data-op]'); if (b && !b.disabled) applyOp(b.dataset.op); });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', render);
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    render();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
      Promise.all(['700 15px "IBM Plex Sans KR"', '600 12px "Barlow Condensed"'].map(f => document.fonts.load(f, '가B2').catch(() => null))).then(render);
    });
  }
  init();
})();
