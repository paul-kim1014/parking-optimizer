/* 자리먼저 엔진 — 주차장 디지털 트윈 · 도착 예측 · 배정 최적화 · 이산 사건 시뮬레이터
 * 기획서 v0.1의 6~8장을 브라우저에서 돌아가도록 옮긴 MVP 구현.
 * 시각 t는 07:00 기준 초(0 = 07:00, 43200 = 19:00). */
(function (root) {
  'use strict';

  const TICK = 300;               // 롤링 호라이즌 재계산 · 스냅숏 주기 (5분)
  const T_END = 12 * 3600;        // 19:00
  const ARR_END = 11 * 3600;      // 18:00 이후 도착은 지표에서 제외
  const FREE = 0, HELD = 1, OCC = 2, BLOCKED = 3, CLOSED = 4;
  const INF = 1e7;

  // ---------- 난수 · 통계 ----------
  function rngFrom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
  function pick(r, w) { let s = 0; for (const x of w) s += x; let v = r() * s; for (let i = 0; i < w.length; i++) { v -= w[i]; if (v <= 0) return i; } return w.length - 1; }
  function Phi(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  // ---------- 7.1 주차장 그래프 모델 (가상 파일럿 시설) ----------
  const FLOORS = ['B1', 'B2', 'B3'];
  const COLS = 32, X0 = 10, SW = 2.5, SD = 5, W = 100, H = 48;
  const ROW_Y = [0, 11, 16, 27, 32, 43];
  const ROW_LANE = [0, 0, 1, 1, 2, 2];
  const LANE_Y = [8, 24, 40];
  const RAMPS = [{ id: 'W', name: '서측 램프', x: 5 }, { id: 'E', name: '동측 램프', x: 95 }];
  const ELEV = [
    { id: 'E1', bld: '본관', cols: [6, 7, 8], rows: [1, 2], base: 25 },
    { id: 'E2', bld: '본관', cols: [15, 16, 17], rows: [1, 2], base: 38 },
    { id: 'E3', bld: '외래동', cols: [20, 21, 22], rows: [3, 4], base: 30 },
    { id: 'E4', bld: '외래동', cols: [27, 28, 29], rows: [3, 4], base: 26 },
  ];
  ELEV.forEach(e => { e.x = X0 + SW * e.cols[0] + SW * 1.5; e.y = (ROW_Y[e.rows[0]] + ROW_Y[e.rows[1]] + SD) / 2; });

  // 목적지 존: lobby = 승강기 하차 후 진료과 입구까지 도보 거리(m)
  const ZONES = [
    { id: 'CARD', name: '본관 3층 심장내과', short: '심장내과', fl: 3, lobby: [55, 18, 150, 185], share: .16, dwell: 100 },
    { id: 'RAD', name: '본관 1층 영상의학과', short: '영상의학과', fl: 1, lobby: [20, 40, 130, 170], share: .12, dwell: 70 },
    { id: 'GI', name: '본관 5층 소화기내과', short: '소화기내과', fl: 5, lobby: [15, 50, 160, 195], share: .14, dwell: 120 },
    { id: 'ORTHO', name: '외래동 2층 정형외과', short: '정형외과', fl: 2, lobby: [150, 120, 15, 50], share: .16, dwell: 90 },
    { id: 'EYE', name: '외래동 4층 안과', short: '안과', fl: 4, lobby: [175, 140, 45, 15], share: .12, dwell: 80 },
    { id: 'ONC', name: '암센터 2층 종양내과', short: '종양내과', fl: 2, lobby: [190, 160, 60, 20], share: .14, dwell: 180 },
    { id: 'PED', name: '외래동 1층 소아청소년과', short: '소아청소년과', fl: 1, lobby: [140, 110, 20, 45], share: .16, dwell: 75 },
  ];
  const NZ = ZONES.length;

  // 시간대별 승강기 대기 배수 (07시~19시). 초기값 [가정], 파일럿 실측으로 대체
  const ELEV_MULT = [1.0, 1.5, 2.4, 2.4, 1.9, 1.3, 1.8, 1.8, 1.5, 1.2, 1.0, 0.9, 0.8];
  function elevWait(e, h) { return ELEV[e].base * ELEV_MULT[Math.max(0, Math.min(12, h))]; }

  function buildFacility() {
    const core = new Set();
    ELEV.forEach(e => e.rows.forEach(r => e.cols.forEach(c => core.add(r * COLS + c))));
    const slots = [];
    for (let f = 0; f < 3; f++) {
      let num = 0;
      for (let r = 0; r < 6; r++) for (let c = 0; c < COLS; c++) {
        if (core.has(r * COLS + c)) continue;
        num++;
        const zone = 'ABCD'[Math.floor(c / 8)];
        const s = { i: slots.length, f, r, c, num, zone, x: X0 + SW * c + SW / 2, y: ROW_Y[r] + SD / 2, lane: ROW_LANE[r] };
        s.label = `${FLOORS[f]}-${zone}-${String(num).padStart(3, '0')}`;
        s.disabled = f === 0 && ELEV.some(e => e.rows.includes(r) && (c === e.cols[0] - 1 || c === e.cols[2] + 1));
        s.ev = f < 2 && r === 5 && c >= 24;
        s.compact = (r === 0 || r === 5) && c < 3;
        s.closedDefault = f === 2 && zone === 'D';
        slots.push(s);
      }
    }
    const N = slots.length;
    // 엣지 비용: 차량 주행(게이트→슬롯)과 도보(슬롯→존, 승강기 대기 포함)
    const drive = new Float32Array(N * 2);
    const pos = new Float32Array(N * 2);
    const CIRC = 90 + 16 + 90 + 32 + 90;
    for (const s of slots) {
      for (let k = 0; k < 2; k++) {
        const xr = RAMPS[k].x;
        drive[s.i * 2 + k] = 30 * (s.f + 1) + (Math.abs(s.x - xr) + Math.abs(LANE_Y[s.lane] - 24)) / 2.8;
        // 자율 탐색 순회 경로상 위치: 중앙 통로 → 북측 → 남측
        const xx = k === 0 ? s.x : W - s.x;
        pos[s.i * 2 + k] = s.lane === 1 ? xx - 5 : s.lane === 0 ? 90 + 16 + (95 - xx) : 90 + 16 + 90 + 32 + (xx - 5);
      }
    }
    const order = FLOORS.map((_, f) => [0, 1].map(k => slots.filter(s => s.f === f).map(s => s.i).sort((a, b) => pos[a * 2 + k] - pos[b * 2 + k])));
    // walkTab[h][s*NZ+z] = 최적 승강기 경유 도보 시간, bestE = 그 승강기
    const walkTab = [], bestE = [];
    for (let h = 0; h <= 12; h++) {
      const wt = new Float32Array(N * NZ), be = new Uint8Array(N * NZ);
      for (const s of slots) for (let z = 0; z < NZ; z++) {
        let best = Infinity, bi = 0;
        for (let e = 0; e < 4; e++) {
          const E = ELEV[e];
          const walk = (Math.abs(s.x - E.x) + Math.abs(s.y - E.y)) / 1.1;
          const ride = 8 + 3 * (s.f + ZONES[z].fl);
          const v = walk + elevWait(e, h) + ride + ZONES[z].lobby[e] / 1.1;
          if (v < best) { best = v; bi = e; }
        }
        wt[s.i * NZ + z] = best; be[s.i * NZ + z] = bi;
      }
      walkTab.push(wt); bestE.push(be);
    }
    return { slots, N, drive, pos, order, CIRC, walkTab, bestE };
  }

  // 슬롯 → 목적지 도보 구성 요소 (방문객 안내 화면용)
  function walkParts(fac, s, z, h) {
    const sl = fac.slots[s], e = fac.bestE[h][s * NZ + z], E = ELEV[e], Z = ZONES[z];
    const toElev = Math.abs(sl.x - E.x) + Math.abs(sl.y - E.y);
    return { elev: E.id, elevIdx: e, toElevM: Math.round(toElev), toElevS: toElev / 1.1, waitS: elevWait(e, h), rideS: 8 + 3 * (sl.f + Z.fl), lobbyM: Z.lobby[e], lobbyS: Z.lobby[e] / 1.1, total: fac.walkTab[h][s * NZ + z] };
  }

  // ---------- 하루치 수요 생성 (합성 데이터) ----------
  const RES_PROFILE = [0.06, 0.14, 0.16, 0.14, 0.05, 0.10, 0.13, 0.11, 0.07, 0.04]; // 예약 시각 08~17시
  const WALK_PROFILE = [0.05, 0.09, 0.12, 0.12, 0.11, 0.09, 0.10, 0.10, 0.09, 0.08, 0.05]; // 비예약 도착 07~17시

  const DEFAULT_DAY = { seed: 20260914, nRes: 980, nWalk: 420, participation: 0.6, etaShare: 0.45, initialCars: 130 };

  function generateDay(cfg) {
    cfg = Object.assign({}, DEFAULT_DAY, cfg || {});
    const r = rngFrom(cfg.seed);
    const V = [];
    const zShare = ZONES.map(z => z.share);
    const mk = (res) => {
      const z = pick(r, zShare);
      const v = { res, zone: z, disabled: r() < 0.04, ev: r() < 0.07, large: r() < 0.05, uPart: r(), uShare: r(), uComply: r(), uLate: r(), rampPref: r() < 0.65 ? 0 : 1, plate4: String(1000 + Math.floor(r() * 9000)), seed: Math.floor(r() * 1e9) };
      v.evWant = v.ev && r() < 0.5;
      v.dwell = Math.exp(Math.log((res ? ZONES[z].dwell : 70) * 60) + 0.35 * gauss(r));
      return v;
    };
    for (let k = 0; k < cfg.nRes; k++) {
      const v = mk(true);
      const h = pick(r, RES_PROFILE);
      v.appt = (h + 1) * 3600 + Math.floor(r() * 6) * 600;
      let lead = 22 + 11 * gauss(r);
      lead = Math.max(-15, Math.min(60, lead));
      v.arr = v.appt - lead * 60;
      const lateMin = 20 + r() * 30;
      if (v.uLate < 0.04) v.arr += lateMin * 60; // 교통 지연 (ETA 미갱신)
      if (v.arr < 60) v.arr = 60 + r() * 600;
      const errShare = gauss(r) * 180;
      v.etaShared = v.arr - (v.uLate < 0.04 ? lateMin * 60 : 0) + errShare;
      V.push(v);
    }
    for (let k = 0; k < cfg.nWalk; k++) {
      const v = mk(false);
      const h = pick(r, WALK_PROFILE);
      v.arr = h * 3600 + r() * 3600;
      V.push(v);
    }
    V.sort((a, b) => a.arr - b.arr);
    V.forEach((v, i) => { v.id = i; });
    const init = [];
    for (let k = 0; k < cfg.initialCars; k++) init.push({ dep: 1800 + r() * 34200, seed: Math.floor(r() * 1e9) });
    const faults = [];
    for (let k = 0; k < 4; k++) faults.push({ t: 3600 + r() * 30000, u: r() });
    return { cfg, V, init, faults };
  }

  // 참여·ETA 공유 여부는 시나리오 파라미터에 따라 결정 (난수는 고정 → 정책 간 공정 비교)
  function applyParticipation(day, participation, etaShare) {
    for (const v of day.V) {
      v.part = v.res && v.uPart < participation;
      v.shared = v.part && v.uShare < etaShare;
      if (v.res) {
        v.eta0 = v.shared ? v.etaShared : v.appt - 22 * 60;
        v.sd0 = v.shared ? 240 : 660;
      }
    }
  }

  // ---------- 8.2 배정 최적화 ----------
  // 헝가리안 알고리즘 (n ≤ m 직사각 행렬, 포텐셜 방식)
  function hungarian(cost, n, m) {
    const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Float64Array(m + 1).fill(Infinity);
      const used = new Uint8Array(m + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0]; let delta = Infinity, j1 = 0;
        const row = cost[i0 - 1];
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = row[j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const ans = new Int32Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
    return ans;
  }

  const DEFAULT_W = { w1: 1.0, w2: 1.5, w3: 1.0, w4: 1.0, w5: 1.0 };

  // cost(v,s) = w1·drive + w2·walk + w3·ramp_penalty + w4·floor_balance + w5·mismatch
  function costParts(fac, v, s, ctx, w) {
    const sl = fac.slots[s];
    if (sl.disabled && !v.disabled) return null;
    if (sl.compact && v.large) return null;
    let mis = 0;
    if (v.disabled && !sl.disabled) mis += 60;
    if (sl.ev && !v.ev) mis += 120;
    if (v.evWant && !sl.ev) mis += 90;
    const d0 = w.w1 * fac.drive[s * 2] + w.w3 * ctx.rampPen[0];
    const d1 = w.w1 * fac.drive[s * 2 + 1] + w.w3 * ctx.rampPen[1];
    const ramp = d0 <= d1 ? 0 : 1;
    const drive = fac.drive[s * 2 + ramp];
    const walk = fac.walkTab[ctx.h][s * NZ + v.zone];
    const rampP = ctx.rampPen[ramp], floorP = ctx.floorPen[sl.f];
    const total = w.w1 * drive + w.w2 * walk + w.w3 * rampP + w.w4 * floorP + w.w5 * mis;
    return { s, ramp, drive, walk, rampP, floorP, mis, total };
  }
  function slotCost(fac, v, s, ctx, w) {
    const sl = fac.slots[s];
    if ((sl.disabled && !v.disabled) || (sl.compact && v.large)) return INF;
    let mis = 0;
    if (v.disabled && !sl.disabled) mis += 60;
    if (sl.ev && !v.ev) mis += 120;
    if (v.evWant && !sl.ev) mis += 90;
    const d0 = w.w1 * fac.drive[s * 2] + w.w3 * ctx.rampPen[0];
    const d1 = w.w1 * fac.drive[s * 2 + 1] + w.w3 * ctx.rampPen[1];
    return (d0 <= d1 ? d0 : d1) + w.w2 * fac.walkTab[ctx.h][s * NZ + v.zone] + w.w4 * ctx.floorPen[sl.f] + w.w5 * mis;
  }

  // 기록된 스냅숏에서 비용 계산 문맥 복원 (시뮬레이터 내부 ctxAt과 동일한 식, 배정 대기 차량 항 제외)
  function ctxFromSnap(fac, snap) {
    const t = snap.t, h = Math.min(12, Math.floor(t / 3600));
    const rampPen = [0, 1].map(k => Math.max(0, snap.gateNext[k] - t) + 2 * snap.searching[k]);
    const used = [0, 0, 0], open = [0, 0, 0];
    for (let s = 0; s < fac.N; s++) { const st = snap.status[s]; if (st === CLOSED || st === BLOCKED) continue; const f = fac.slots[s].f; open[f]++; if (st !== FREE) used[f]++; }
    const rates = open.map((o, f) => o ? used[f] / o : 1);
    const m = (rates[0] + rates[1] + rates[2]) / 3;
    return { h, t, rampPen, floorPen: rates.map(x => Math.max(0, x - m) * 300) };
  }

  // 특정 시점 상태에서 한 차량의 슬롯 후보 순위 (방문객 화면 · 설명용)
  function rankSlots(fac, status, v, ctx, w, limit) {
    const out = [];
    for (let s = 0; s < fac.N; s++) if (status[s] === FREE) { const c = costParts(fac, v, s, ctx, w); if (c) out.push(c); }
    out.sort((a, b) => a.total - b.total);
    return out.slice(0, limit || 5);
  }

  // ---------- 8.3 이산 사건 시뮬레이터 ----------
  class Heap {
    constructor() { this.a = []; this.n = 0; }
    push(t, type, x) {
      const a = this.a; const e = [t, this.n++, type, x]; a.push(e);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (lt(a[p], e)) break; a[i] = a[p]; i = p; }
      a[i] = e;
    }
    pop() {
      const a = this.a; const top = a[0]; const last = a.pop();
      if (a.length) {
        let i = 0; const n = a.length;
        for (;;) {
          let l = 2 * i + 1, r = l + 1, m = i;
          let best = last;
          if (l < n && lt(a[l], best)) { m = l; best = a[l]; }
          if (r < n && lt(a[r], best)) { m = r; best = a[r]; }
          if (m === i) break;
          a[i] = a[m]; i = m;
        }
        a[i] = last;
      }
      return top;
    }
    get size() { return this.a.length; }
  }
  function lt(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }

  const DEFAULT_OPT = { policy: 'rolling', compliance: 0.65, participation: 0.6, etaShare: 0.45, weights: DEFAULT_W, holdCap: 0.7, horizon: 1800, ops: [], record: false };

  function simulate(fac, day, opt) {
    opt = Object.assign({}, DEFAULT_OPT, opt || {});
    const w = Object.assign({}, DEFAULT_W, opt.weights || {});
    applyParticipation(day, opt.participation, opt.etaShare);
    const N = fac.N, S = fac.slots;
    const status = new Uint8Array(N), holder = new Int32Array(N).fill(-1), occBy = new Int32Array(N).fill(-1);
    for (const s of S) if (s.closedDefault) status[s.i] = CLOSED;
    const V = day.V.map(v => Object.assign({}, v, { slot: -1, ramp: -1, holdExp: 0, eta: v.eta0, sd: v.sd0, arrived: false, parkSlot: -1, gateWait: 0, search: 0, walk: 0, reassigns: 0, expired: 0, assignedAt: -1, firstEta: null, comply: false, via: null }));
    const heap = new Heap();
    const gateNext = [0, 0], searching = [0, 0];
    const flags = { engineOff: Infinity, staffW: Infinity };
    const log = [];
    const cnt = { assign: 0, reassign: 0, expire: 0, ignore: 0, gateAssign: 0, fail: 0, sensor: 0, gateRe: 0 };
    const snaps = [], series = [];
    const floorOpen = [0, 0, 0];
    const L = (t, kind, text, extra) => { if (log.length < 4000) log.push(Object.assign({ t, kind, text }, extra || {})); };
    const engineOn = t => opt.policy !== 'none' && t < flags.engineOff;

    // 초기 점유 차량
    const ir = rngFrom(day.cfg.seed ^ 0x51ED);
    const plain = S.filter(s => !s.closedDefault && !s.disabled && !s.ev && !s.compact).map(s => s.i);
    day.init.forEach((c, k) => {
      let s; do { s = plain[Math.floor(ir() * plain.length)]; } while (status[s] !== FREE);
      status[s] = OCC; occBy[s] = -2 - k;
      heap.push(c.dep, 'depart', { s, who: -2 - k });
    });
    for (const v of V) heap.push(v.arr, 'arrive', v);
    for (let t = 0; t <= T_END; t += TICK) heap.push(t, 'tick', null);
    for (const f of day.faults) heap.push(f.t, 'fault', f);
    for (const o of opt.ops) heap.push(o.t, 'op', o);

    function ctxAt(t) {
      const h = Math.min(12, Math.floor(t / 3600));
      const pend = [0, 0];
      for (const v of V) if (v.slot >= 0 && !v.arrived && v.eta - t < 1200) pend[v.ramp]++;
      const rampPen = [0, 1].map(k => Math.max(0, gateNext[k] - t) + 2 * searching[k] + 1.5 * pend[k]);
      const used = [0, 0, 0], open = [0, 0, 0];
      for (let s = 0; s < N; s++) { const st = status[s]; if (st === CLOSED || st === BLOCKED) continue; const f = S[s].f; open[f]++; if (st !== FREE) used[f]++; }
      const rates = open.map((o, f) => o ? used[f] / o : 1);
      const mean = (rates[0] + rates[1] + rates[2]) / 3;
      const floorPen = rates.map(x => Math.max(0, x - mean) * 300);
      return { h, rampPen, floorPen, t };
    }
    function holdBudget() {
      let fr = 0, he = 0;
      for (let s = 0; s < N; s++) { if (status[s] === FREE) fr++; else if (status[s] === HELD) he++; }
      return Math.floor(opt.holdCap * (fr + he)) - he;
    }
    function assign(v, s, ramp, t, kind) {
      status[s] = HELD; holder[s] = v.id; v.slot = s; v.ramp = ramp;
      v.holdExp = v.eta + 2 * v.sd + 600;
      if (v.assignedAt < 0) { v.assignedAt = t; v.firstEta = v.eta; }
      cnt.assign++;
      L(t, kind === 'gate' ? 'gate-assign' : 'assign', `${v.plate4} → ${S[s].label}`, { v: v.id, s, ramp });
    }
    function bestFor(v, t, rampFixed) {
      const ctx = ctxAt(t);
      let best = -1, bc = INF, br = 0;
      for (let s = 0; s < N; s++) if (status[s] === FREE) {
        let c;
        if (rampFixed != null) {
          const p = costParts(fac, v, s, { h: ctx.h, rampPen: [rampFixed === 0 ? 0 : INF, rampFixed === 1 ? 0 : INF], floorPen: ctx.floorPen }, w);
          c = p ? p.total : INF;
        } else c = slotCost(fac, v, s, ctx, w);
        if (c < bc) { bc = c; best = s; }
      }
      if (best >= 0 && rampFixed == null) { const p = costParts(fac, v, best, ctx, w); br = p.ramp; } else br = rampFixed;
      return { s: best, ramp: br };
    }
    function lostHold(u, t, why) {
      u.slot = -1; u.reassigns++; cnt.reassign++;
      if (engineOn(t) && !u.arrived) {
        const b = bestFor(u, t);
        if (b.s >= 0) { assign(u, b.s, b.ramp, t, 're'); L(t, 'reassign', `${u.plate4} 재배정 → ${S[b.s].label} (${why})`, { v: u.id, s: b.s }); }
      }
    }

    function tick(t) {
      // hold 만료 → 해제 후 재배정 대상
      for (const v of V) if (v.slot >= 0 && !v.arrived && v.holdExp < t) {
        const s = v.slot;
        if (holder[s] === v.id && status[s] === HELD) { status[s] = FREE; holder[s] = -1; }
        v.slot = -1; v.expired++; cnt.expire++;
        v.eta = t + 600; v.sd = 300;
        L(t, 'expire', `${v.plate4} hold 만료 · ${S[s].label} 해제`, { v: v.id, s });
      }
      if (engineOn(t)) {
        const commit = [], look = [];
        for (const v of V) {
          if (!v.part || v.arrived || v.slot >= 0) continue;
          if (v.eta - 900 <= t + TICK) commit.push(v);
          else if (opt.policy === 'rolling' && v.eta - 900 <= t + opt.horizon) look.push(v);
        }
        commit.sort((a, b) => a.eta - b.eta);
        let budget = holdBudget();
        if (commit.length && budget > 0) {
          const cm = commit.slice(0, budget);
          if (opt.policy === 'greedy') {
            for (const v of cm) { const b = bestFor(v, t); if (b.s >= 0) assign(v, b.s, b.ramp, t, 'assign'); }
          } else {
            const ctx = ctxAt(t);
            const free = []; for (let s = 0; s < N; s++) if (status[s] === FREE) free.push(s);
            const rows = cm.concat(look).slice(0, free.length);
            const K = 24;
            const colSet = new Set();
            const full = rows.map(v => {
              const c = new Float64Array(free.length);
              for (let j = 0; j < free.length; j++) c[j] = slotCost(fac, v, free[j], ctx, w);
              const idx = Array.from(c.keys()).sort((a, b) => c[a] - c[b]).slice(0, K);
              idx.forEach(j => colSet.add(j));
              return c;
            });
            let cols = Array.from(colSet);
            if (cols.length < rows.length) { for (let j = 0; j < free.length && cols.length < rows.length; j++) if (!colSet.has(j)) { colSet.add(j); cols.push(j); } }
            const mat = full.map(c => { const r = new Float64Array(cols.length); for (let k = 0; k < cols.length; k++) r[k] = c[cols[k]]; return r; });
            const ans = rows.length ? hungarian(mat, rows.length, cols.length) : [];
            for (let i = 0; i < cm.length; i++) {
              const k = ans[i]; if (k < 0 || mat[i][k] >= INF) continue;
              const s = free[cols[k]];
              const p = costParts(fac, cm[i], s, ctx, w);
              assign(cm[i], s, p.ramp, t, 'assign');
            }
          }
        }
      }
      // 기록
      const occ = [0, 0, 0], held = [0, 0, 0], open = [0, 0, 0];
      for (let s = 0; s < N; s++) { const st = status[s], f = S[s].f; if (st !== CLOSED && st !== BLOCKED) open[f]++; if (st === OCC) occ[f]++; else if (st === HELD) held[f]++; }
      floorOpen[0] = open[0]; floorOpen[1] = open[1]; floorOpen[2] = open[2];
      series.push({ t, occ, held, open, gateWait: [Math.max(0, gateNext[0] - t), Math.max(0, gateNext[1] - t)], searching: searching[0] + searching[1] });
      if (opt.record) snaps.push({ t, status: status.slice(), holder: holder.slice(), gateNext: gateNext.slice(), searching: searching.slice() });
    }

    function arrive(v, t) {
      v.arrived = true;
      if (engineOn(t) && v.part && v.slot < 0) {
        const b = bestFor(v, t);
        if (b.s >= 0) { assign(v, b.s, b.ramp, t, 'gate'); cnt.gateAssign++; v.via = 'gate'; }
      }
      if (v.part && engineOn(t) && v.slot < 0) cnt.fail++;
      v.comply = v.part && v.slot >= 0 && v.uComply < opt.compliance;
      let ramp;
      if (v.comply) ramp = v.ramp;
      else {
        ramp = v.rampPref;
        if (ramp === 0 && t >= flags.staffW && rngFrom(v.seed ^ 7)() < 0.2) ramp = 1;
      }
      const base = (ramp === 0 && t >= flags.staffW) ? 8 : 11;
      const svc = base + 1.0 * searching[ramp];
      const start = Math.max(t, gateNext[ramp]);
      gateNext[ramp] = start + svc;
      v.gateWait = start - t; v.entryRamp = ramp;
      heap.push(start + svc, 'enter', v);
    }

    function searchPark(v, t, extra) {
      const rr = rngFrom(v.seed ^ 0x9E3779B9 ^ Math.floor(extra));
      let time = extra, side = v.entryRamp;
      for (let f = 0; f < 3; f++) {
        time += 30;
        const ord = fac.order[f][side];
        for (const s of ord) {
          const st = status[s]; const sl = S[s];
          let ok = false;
          if (st === FREE) ok = true;
          else if (st === HELD) ok = holder[s] === v.id ? true : rr() < 0.25;
          if (!ok) continue;
          if (sl.disabled && !v.disabled) continue;
          if (sl.compact && v.large) continue;
          if (sl.ev && !v.ev && rr() > 0.1) continue;
          if (rr() < 0.15) continue;
          return { s, time: time + fac.pos[s * 2 + side] / 2.0 };
        }
        time += fac.CIRC / 2.0;
        side = 1 - side;
      }
      return { s: -1, time };
    }

    function enter(v, t) {
      if (v.comply) {
        let s = v.slot;
        if (s < 0 || holder[s] !== v.id || status[s] !== HELD) {
          const b = bestFor(v, t, v.entryRamp);
          s = b.s; cnt.gateRe++;
          if (s >= 0) { v.slot = s; L(t, 'reassign', `${v.plate4} 게이트 재배정 → ${S[s].label}`, { v: v.id, s }); }
        }
        if (s >= 0) {
          status[s] = OCC; occBy[s] = v.id; holder[s] = -1; v.parkSlot = s;
          v.search = fac.drive[s * 2 + v.entryRamp];
          L(t, 'enter', `${v.plate4} 입차 → ${S[s].label}`, { v: v.id, s, ramp: v.entryRamp, guided: true });
          heap.push(t + v.search, 'park', v);
          return;
        }
      }
      L(t, 'enter', `${v.plate4} 입차 (자율 탐색)`, { v: v.id, ramp: v.entryRamp, guided: false });
      searching[v.entryRamp]++; v.isSearching = true;
      doSearch(v, t, 0);
    }
    function doSearch(v, t, extra) {
      const res = searchPark(v, t, extra);
      if (res.s < 0) { heap.push(t + 120, 'research', { v, extra: res.time + 120 }); return; }
      const s = res.s;
      const prevHolder = status[s] === HELD ? holder[s] : -1;
      status[s] = OCC; occBy[s] = v.id; holder[s] = -1; v.parkSlot = s; v.search = res.time;
      if (prevHolder >= 0 && prevHolder !== v.id) {
        const u = V[prevHolder];
        L(t, 'conflict', `${S[s].label} 비배정 차량 점유 → ${u.plate4} 배정 해제`, { s });
        lostHold(u, t, '다른 차량 점유');
      }
      heap.push(t + (res.time - extra), 'park', v);
    }

    function park(v, t) {
      if (v.isSearching) { searching[v.entryRamp]--; v.isSearching = false; }
      const s = v.parkSlot;
      v.parkedAt = t;
      v.walk = fac.walkTab[Math.min(12, Math.floor(t / 3600))][s * NZ + v.zone];
      if (v.slot >= 0 && v.slot !== s) {
        const hs = v.slot;
        if (holder[hs] === v.id && status[hs] === HELD) { status[hs] = FREE; holder[hs] = -1; }
        cnt.ignore++;
        L(t, 'ignore', `${v.plate4} 배정 무시 · ${S[s].label}에 주차 (배정 ${S[hs].label} 해제)`, { v: v.id, s, hs });
      }
      heap.push(t + v.dwell, 'depart', { s, who: v.id });
    }

    function fault(f, t) {
      const cands = [];
      for (let s = 0; s < N; s++) if (status[s] === FREE || status[s] === HELD) cands.push(s);
      if (!cands.length) return;
      const s = cands[Math.floor(f.u * cands.length)];
      const hv = status[s] === HELD ? holder[s] : -1;
      status[s] = BLOCKED; holder[s] = -1; cnt.sensor++;
      L(t, 'sensor', `${S[s].label} 센서·LPR 불일치 → BLOCKED`, { s });
      if (hv >= 0) lostHold(V[hv], t, '센서 불일치');
      heap.push(t + 1200, 'unblock', s);
    }

    function op(o, t) {
      if (o.type === 'openB3D') {
        let n = 0; for (const s of S) if (s.closedDefault && status[s.i] === CLOSED) { status[s.i] = FREE; n++; }
        L(t, 'op', `운영 조치: B3 D구역 임시 개방 (+${n}면)`);
      } else if (o.type === 'staffW') {
        flags.staffW = t; L(t, 'op', '운영 조치: 서측 램프 진입 유도요원 배치');
      } else if (o.type === 'engineOff') {
        flags.engineOff = t;
        for (let s = 0; s < N; s++) if (status[s] === HELD) { status[s] = FREE; holder[s] = -1; }
        for (const v of V) if (!v.arrived) v.slot = -1;
        L(t, 'op', '배정 엔진 중지 — 열화 모드 (기존 방식 주차)');
      }
    }

    while (heap.size) {
      const [t, , type, x] = heap.pop();
      if (t > T_END + 6 * 3600) break;
      switch (type) {
        case 'tick': tick(t); break;
        case 'arrive': arrive(x, t); break;
        case 'enter': enter(x, t); break;
        case 'research': doSearch(x.v, t, x.extra); break;
        case 'park': park(x, t); break;
        case 'depart':
          if (status[x.s] === OCC && occBy[x.s] === x.who) { status[x.s] = FREE; occBy[x.s] = -1; }
          break;
        case 'fault': fault(x, t); break;
        case 'unblock': if (status[x] === BLOCKED) status[x] = FREE; break;
        case 'op': op(x, t); break;
      }
    }

    return { opt, V, log, cnt, snaps, series, metrics: metricsOf(fac, V, series, cnt, opt) };
  }

  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  function metricsOf(fac, V, series, cnt, opt) {
    const done = V.filter(v => v.arr < ARR_END && v.parkedAt != null);
    const peak = done.filter(v => v.arr >= 2 * 3600 && v.arr < 4 * 3600);
    const guided = done.filter(v => v.comply);
    const others = done.filter(v => !v.comply);
    const parts = V.filter(v => v.part && v.arr < ARR_END);
    const assigned = parts.filter(v => v.assignedAt >= 0);
    // 층별 점유율 편차 (09~15시 평균)
    const mid = series.filter(s => s.t >= 2 * 3600 && s.t <= 8 * 3600);
    const floorStd = mean(mid.map(s => {
      const r = s.open.map((o, f) => o ? (s.occ[f] + s.held[f]) / o : 0);
      const m = (r[0] + r[1] + r[2]) / 3;
      return Math.sqrt(r.reduce((a, x) => a + (x - m) * (x - m), 0) / 3) * 100;
    }));
    const peakOcc = Math.max(...series.map(s => (s.occ[0] + s.occ[1] + s.occ[2]) / Math.max(1, s.open[0] + s.open[1] + s.open[2])));
    // 개별 도착 예측 (알림 시점 기준)
    const etaErr = assigned.filter(v => v.firstEta != null).map(v => Math.abs(v.firstEta - v.arr) / 60);
    return {
      n: done.length,
      search: mean(done.map(v => v.search)),
      walk: mean(done.map(v => v.walk)),
      gate: mean(done.map(v => v.gateWait)),
      peakEntry: mean(peak.map(v => v.gateWait + v.search)),
      peakGate: mean(peak.map(v => v.gateWait)),
      walkGuided: mean(guided.map(v => v.walk)),
      walkOthers: mean(others.map(v => v.walk)),
      searchGuided: mean(guided.map(v => v.search)),
      searchOthers: mean(others.map(v => v.search)),
      guided: guided.length,
      participants: parts.length,
      assigned: assigned.length,
      complianceReal: assigned.length ? assigned.filter(v => v.comply).length / Math.max(1, assigned.filter(v => v.arrived).length) : 0,
      reassignRate: assigned.length ? cnt.reassign / assigned.length : 0,
      expireRate: assigned.length ? cnt.expire / assigned.length : 0,
      failRate: parts.length ? cnt.fail / parts.length : 0,
      floorStd, peakOcc,
      etaMAE: mean(etaErr), eta10: etaErr.length ? etaErr.filter(e => e <= 10).length / etaErr.length : 0,
    };
  }

  // ---------- 8.1 도착 예측 (집계) ----------
  // 발행 시점 issue에 알 수 있는 정보만 사용: 예약(사전분포) + 공유 ETA + 비예약 기저 수요
  function forecastBucket(day, b0, b1, issue) {
    let lam = 0;
    for (const v of day.V) {
      if (!v.res || v.arr <= issue) continue;
      const known = v.shared && issue >= v.eta0 - 45 * 60;
      const mu = known ? v.eta0 : v.appt - 22 * 60, sd = known ? 240 : 660;
      const tail = Math.max(0.02, 1 - Phi((issue - mu) / sd));
      const lo = Math.max(b0, issue);
      if (b1 <= lo) continue;
      lam += (Phi((b1 - mu) / sd) - Phi((lo - mu) / sd)) / tail;
    }
    const h = Math.floor(b0 / 3600);
    if (h >= 0 && h < WALK_PROFILE.length) lam += day.cfg.nWalk * WALK_PROFILE[h] * (b1 - Math.max(b0, issue)) / 3600;
    const sd = Math.sqrt(lam + (0.12 * lam) ** 2);
    return { p50: lam, p10: Math.max(0, lam - 1.2816 * sd), p90: lam + 1.2816 * sd };
  }
  function actualBuckets(day) {
    const a = new Array(48).fill(0);
    for (const v of day.V) { const b = Math.floor(v.arr / 900); if (b >= 0 && b < 48) a[b]++; }
    return a;
  }
  // 30분 전 발행 예측의 MAPE · P10~P90 커버리지 (H1)
  function forecastScore(day) {
    const act = actualBuckets(day);
    let ape = 0, n = 0, cov = 0;
    for (let b = 2; b < 44; b++) {
      const f = forecastBucket(day, b * 900, (b + 1) * 900, b * 900 - 1800);
      if (act[b] >= 5) { ape += Math.abs(f.p50 - act[b]) / act[b]; n++; }
      if (act[b] >= f.p10 && act[b] <= f.p90) cov++;
    }
    return { mape: n ? ape / n : 0, coverage: cov / 42 };
  }

  const API = {
    FREE, HELD, OCC, BLOCKED, CLOSED, TICK, T_END, ARR_END,
    FLOORS, RAMPS, ELEV, ZONES, COLS, ROW_Y, LANE_Y, X0, SW, SD, W, H, DEFAULT_W, DEFAULT_DAY, DEFAULT_OPT,
    buildFacility, generateDay, applyParticipation, simulate, hungarian, costParts, rankSlots, walkParts, ctxFromSnap,
    forecastBucket, actualBuckets, forecastScore, elevWait, rngFrom,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ParkEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
