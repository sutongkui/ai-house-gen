// ============================================================================
// solver.js  —  第一层「设计参数」 → 校验 → 第二层「预制件摆放指令」
// 纯函数、无渲染依赖，可在浏览器与 Node 中运行。
// 网格单位 GRID = 0.5m；平面坐标 x 向东、z 向南；S(南)为正立面。
// ============================================================================

export const GRID = 0.5;
export const STYLES = ['chinese', 'japanese', 'modern', 'european', 'nordic'];
export const ROOF_TYPES = ['flat', 'gable', 'hip', 'xieshan', 'pyramid'];
const SIDES = ['N', 'S', 'E', 'W'];
const MAX_EXTENT = 80; // 40m
const WALL_T = 0.2;

export const STYLE_DEFAULTS = {
  chinese:  { roof: 'xieshan', pitch: 30, overhang: 3, curve: true,  eave: true,  plinth: 1, fh: 7 },
  japanese: { roof: 'hip',     pitch: 27, overhang: 3, curve: true,  eave: true,  plinth: 1, fh: 6 },
  modern:   { roof: 'flat',    pitch: 0,  overhang: 0, curve: false, eave: false, plinth: 0, fh: 6 },
  european: { roof: 'hip',     pitch: 40, overhang: 1, curve: false, eave: false, plinth: 1, fh: 6 },
  nordic:   { roof: 'gable',   pitch: 45, overhang: 1, curve: false, eave: false, plinth: 0, fh: 6 },
};

const key = (x, z) => x + ',' + z;
const unkey = (k) => k.split(',').map(Number);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const sideCN = { N: '北', S: '南', E: '东', W: '西' };
const F = (i) => `第${i + 1}层`;

// ---------------------------------------------------------------------------
// 1) normalize：字段补全、取整、钳制（可自动修的记 warning，需要模型改的记 error）
// ---------------------------------------------------------------------------
function normalize(raw, errors, warnings) {
  const E = (code, msg, hard = true) => errors.push({ code, msg, hard });
  const W = (msg) => warnings.push(msg);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    E('E_FORMAT', '顶层必须是一个 JSON 对象');
    return null;
  }
  const spec = {};
  spec.name = String(raw.name || '未命名房屋').slice(0, 40);
  spec.design_notes = raw.design_notes ? String(raw.design_notes).slice(0, 200) : '';

  if (STYLES.includes(raw.style)) spec.style = raw.style;
  else { spec.style = 'modern'; W(`style "${raw.style}" 不在支持列表，按 modern 处理`); }
  const SD = STYLE_DEFAULTS[spec.style];

  const intField = (v, def, lo, hi, label) => {
    if (v === undefined || v === null) return def;
    if (!isNum(v)) { W(`${label} 不是数字，使用默认值 ${def}`); return def; }
    const r = Math.round(v);
    const c = clamp(r, lo, hi);
    if (c !== v) W(`${label}=${v} 已调整为 ${c}`);
    return c;
  };

  spec.floor_height = intField(raw.floor_height, SD.fh, 5, 9, 'floor_height');
  spec.plinth = intField(raw.plinth, SD.plinth, 0, 3, 'plinth');
  const FH = spec.floor_height;

  if (!Array.isArray(raw.floors) || raw.floors.length === 0) {
    E('E_FLOORS', 'floors 必须是非空数组');
    return null;
  }
  if (raw.floors.length > 6) E('E_FLOORS', `最多 6 层，当前 ${raw.floors.length} 层`);
  const nF = Math.min(raw.floors.length, 6);

  spec.floors = [];
  for (let i = 0; i < nF; i++) {
    const rf = raw.floors[i] || {};
    const fl = { blocks: [], doors: [], window: null, eave: false };
    if (!Array.isArray(rf.blocks) || rf.blocks.length === 0) {
      E('E_BLOCKS', `${F(i)} blocks 必须是非空数组`);
    } else {
      rf.blocks.forEach((b, bi) => {
        if (!Array.isArray(b) || b.length !== 4 || !b.every(isNum)) {
          E('E_BLOCKS', `${F(i)} block${bi} 必须是 [x, z, w, d] 四个数字`);
          return;
        }
        const rb = b.map((v) => Math.round(v));
        if (rb.some((v, k) => v !== b[k])) W(`${F(i)} block${bi} 已取整为 [${rb}]`);
        const [x, z, w, d] = rb;
        if (w < 4 || d < 4) E('E_BLOCKS', `${F(i)} block${bi} 宽深至少 4 格（2m），当前 w=${w}, d=${d}`);
        else if (x < 0 || z < 0 || x + w > MAX_EXTENT || z + d > MAX_EXTENT)
          E('E_BLOCKS', `${F(i)} block${bi} 超出 0~${MAX_EXTENT} 格的场地范围`);
        else fl.blocks.push(rb);
      });
    }
    // doors
    (Array.isArray(rf.doors) ? rf.doors : []).forEach((d, di) => {
      if (!d || typeof d !== 'object') return;
      const side = String(d.side || '').toUpperCase();
      if (!SIDES.includes(side)) { E('E_DOOR', `${F(i)} 门#${di} side 必须是 N/S/E/W`, false); return; }
      const block = isNum(d.block) ? Math.round(d.block) : 0;
      if (block < 0 || block >= (rf.blocks || []).length) { E('E_DOOR', `${F(i)} 门#${di} block=${d.block} 不存在`, false); return; }
      const at = isNum(d.at) ? clamp(d.at, 0, 1) : 0.5;
      const width = intField(d.width, 3, 2, 6, `${F(i)} 门#${di} width`);
      fl.doors.push({ block, side, at, width, idx: di });
    });
    // window rule
    if (rf.window === 'none' || rf.window === null || rf.window === false) fl.window = null;
    else {
      const rw = typeof rf.window === 'object' ? rf.window : {};
      const width = intField(rw.width, 3, 1, 10, `${F(i)} window.width`);
      let height = intField(rw.height, Math.min(3, FH - 2), 2, FH - 1, `${F(i)} window.height`);
      let sill = intField(rw.sill, 2, 0, FH - 2, `${F(i)} window.sill`);
      if (height + sill > FH - 1) {
        const nh = Math.max(2, FH - 1 - sill);
        const ns = FH - 1 - nh;
        W(`${F(i)} 窗高+窗台超过层高，已调整为 height=${nh}, sill=${ns}`);
        height = nh; sill = ns;
      }
      const gap = intField(rw.gap, 4, 1, 14, `${F(i)} window.gap`);
      fl.window = { width, height, sill, gap };
    }
    fl.eave = rf.eave === undefined ? (SD.eave && i < nF - 1) : !!rf.eave;
    if (i === nF - 1) fl.eave = false;
    spec.floors.push(fl);
  }

  // roof
  const rr = raw.roof && typeof raw.roof === 'object' ? raw.roof : {};
  const roofType = ROOF_TYPES.includes(rr.type) ? rr.type : SD.roof;
  if (rr.type && !ROOF_TYPES.includes(rr.type)) W(`roof.type "${rr.type}" 不支持，按 ${SD.roof} 处理`);
  spec.roof = {
    type: roofType,
    pitch: roofType === 'flat' ? 0 : intField(rr.pitch, SD.pitch || 30, 15, 55, 'roof.pitch'),
    overhang: intField(rr.overhang, SD.overhang, 0, 5, 'roof.overhang'),
    curve: rr.curve === undefined ? SD.curve : !!rr.curve,
  };

  // columns
  spec.columns = null;
  if (raw.columns && typeof raw.columns === 'object') {
    const side = String(raw.columns.side || 'S').toUpperCase();
    if (SIDES.includes(side)) {
      spec.columns = {
        side,
        spacing: intField(raw.columns.spacing, 7, 3, 14, 'columns.spacing'),
        offset: intField(raw.columns.offset, 3, 2, 6, 'columns.offset'),
      };
    }
  }
  return spec;
}

// ---------------------------------------------------------------------------
// 2) 栅格分析工具
// ---------------------------------------------------------------------------
function rasterize(blocks) {
  const occ = new Set();
  for (const [x, z, w, d] of blocks)
    for (let i = x; i < x + w; i++) for (let j = z; j < z + d; j++) occ.add(key(i, j));
  return occ;
}

function isConnected(occ) {
  if (occ.size === 0) return true;
  const start = occ.values().next().value;
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const [x, z] = unkey(q.pop());
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(x + dx, z + dz);
      if (occ.has(k) && !seen.has(k)) { seen.add(k); q.push(k); }
    }
  }
  return seen.size === occ.size;
}

// 外边界 → 合并成直线墙段 run：{dir, line, from, to}
// dir = 墙的朝外方向；N/S 墙沿 x 延伸，E/W 墙沿 z 延伸
function edgeRuns(cells, isOutside) {
  const buckets = { N: new Map(), S: new Map(), E: new Map(), W: new Map() };
  const push = (dir, line, s) => {
    const m = buckets[dir];
    if (!m.has(line)) m.set(line, []);
    m.get(line).push(s);
  };
  for (const k of cells) {
    const [x, z] = unkey(k);
    if (isOutside(x, z - 1)) push('N', z, x);
    if (isOutside(x, z + 1)) push('S', z + 1, x);
    if (isOutside(x - 1, z)) push('W', x, z);
    if (isOutside(x + 1, z)) push('E', x + 1, z);
  }
  const runs = [];
  for (const dir of SIDES) {
    for (const [line, arr] of buckets[dir]) {
      arr.sort((a, b) => a - b);
      let from = arr[0], prev = arr[0];
      for (let i = 1; i <= arr.length; i++) {
        if (i < arr.length && arr[i] === prev + 1) { prev = arr[i]; continue; }
        runs.push({ dir, line, from, to: prev + 1 });
        if (i < arr.length) { from = arr[i]; prev = arr[i]; }
      }
    }
  }
  return runs;
}

function bbox(cells) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const k of cells) {
    const [x, z] = unkey(k);
    x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x + 1); z1 = Math.max(z1, z + 1);
  }
  return { x0, z0, x1, z1 };
}

// 贪心矩形合并（行扫描）
function greedyRects(cells) {
  const used = new Set();
  const list = [...cells].map(unkey).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const rects = [];
  for (const [x, z] of list) {
    if (used.has(key(x, z))) continue;
    let w = 1;
    while (cells.has(key(x + w, z)) && !used.has(key(x + w, z))) w++;
    let d = 1;
    outer: while (true) {
      for (let i = x; i < x + w; i++) if (!cells.has(key(i, z + d)) || used.has(key(i, z + d))) break outer;
      d++;
    }
    for (let i = x; i < x + w; i++) for (let j = z; j < z + d; j++) used.add(key(i, j));
    rects.push([x, z, w, d]);
  }
  return rects;
}

function fillSolid(len) {
  const out = [];
  let r = len;
  while (r >= 4) { out.push(4); r -= 4; }
  if (r >= 2) { out.push(2); r -= 2; }
  if (r >= 1) out.push(1);
  return out;
}

const ROT = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 };
const OUT = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] };

// ---------------------------------------------------------------------------
// 3) compile：normalize → 校验 → 求解
// ---------------------------------------------------------------------------
export function compile(raw) {
  const errors = [];
  const warnings = [];
  const spec = normalize(raw, errors, warnings);
  if (!spec || errors.some((e) => e.hard)) return { ok: false, spec, errors, warnings, result: null };

  const n = spec.floors.length;
  const occ = spec.floors.map((f) => rasterize(f.blocks));

  // —— 连通性 ——
  occ.forEach((o, i) => {
    if (!isConnected(o)) errors.push({ code: 'E_DISCONNECTED', hard: true, msg: `${F(i)} 的矩形之间没有相接，平面不连通` });
  });
  // —— 上层必须落在下层之内 ——
  for (let i = 1; i < n; i++) {
    const over = [...occ[i]].filter((k) => !occ[i - 1].has(k));
    if (over.length) {
      const b = bbox(new Set(over));
      errors.push({
        code: 'E_OVERHANG', hard: true,
        msg: `${F(i)} 有 ${over.length} 格超出${F(i - 1)}范围（约 x ${b.x0}~${b.x1}, z ${b.z0}~${b.z1}），上层必须完全落在下层平面之内`,
      });
    }
  }
  if (errors.some((e) => e.hard)) return { ok: false, spec, errors, warnings, result: null };

  // —— 墙段 ——
  const runs = occ.map((o) => edgeRuns(o, (x, z) => !o.has(key(x, z))));

  // —— 门：定位到外墙 run 上 ——
  const doorsResolved = spec.floors.map(() => []);
  spec.floors.forEach((fl, i) => {
    for (const d of fl.doors) {
      const [bx, bz, bw, bd] = fl.blocks[d.block] || [];
      if (bx === undefined) continue;
      let line, from, to;
      if (d.side === 'S') { line = bz + bd; from = bx; to = bx + bw; }
      if (d.side === 'N') { line = bz; from = bx; to = bx + bw; }
      if (d.side === 'E') { line = bx + bw; from = bz; to = bz + bd; }
      if (d.side === 'W') { line = bx; from = bz; to = bz + bd; }
      const center = from + d.at * (to - from);
      const cell = clamp(Math.floor(center), from, to - 1);
      const run = runs[i].find((r) => r.dir === d.side && r.line === line && r.from <= cell && cell < r.to);
      const label = `${F(i)} 门#${d.idx}（block${d.block} ${sideCN[d.side]}侧 at=${d.at}）`;
      if (!run) {
        errors.push({ code: 'E_DOOR_NOT_EXTERIOR', hard: false, msg: `${label} 所在位置不是外墙（被同层其他矩形遮挡），请换一条外露的边或调整 at` });
        continue;
      }
      const minS = run.from + 1, maxS = run.to - 1 - d.width;
      if (maxS < minS) {
        errors.push({ code: 'E_DOOR_TOO_WIDE', hard: false, msg: `${label} 宽 ${d.width} 格，但该段外墙只有 ${run.to - run.from} 格，放不下（需距墙角≥1格）` });
        continue;
      }
      let start = Math.round(center - d.width / 2);
      if (start < minS || start > maxS) {
        const s2 = clamp(start, minS, maxS);
        warnings.push(`${label} 离墙角太近，已平移 ${s2 - start} 格`);
        start = s2;
      }
      doorsResolved[i].push({ run, start, width: d.width, side: d.side, label });
    }
    // 门之间重叠
    const ds = doorsResolved[i];
    for (let a = 0; a < ds.length; a++)
      for (let b = a + 1; b < ds.length; b++) {
        const A = ds[a], B = ds[b];
        if (A.run === B.run && A.start < B.start + B.width + 1 && B.start < A.start + A.width + 1) {
          errors.push({ code: 'E_OPENING_OVERLAP', hard: false, msg: `${A.label} 与 ${B.label} 重叠或间距不足 1 格` });
          B.dropped = true;
        }
      }
    doorsResolved[i] = ds.filter((d) => !d.dropped);
  });
  if (doorsResolved[0].length === 0) {
    errors.push({ code: 'E_NO_ENTRANCE', hard: false, msg: '一层没有有效的入户门：至少需要一扇落在外墙上的门' });
  }

  // 只生成建筑外壳 + 层间楼板：不含楼梯、隔墙、家具等室内元素

  // ------------------------------------------------------------------------
  // 求解：生成第二层摆放指令
  // ------------------------------------------------------------------------
  const G = GRID;
  const FH = spec.floor_height * G;
  const P = spec.plinth * G;
  const base = (i) => P + i * FH;
  const b0 = bbox(occ[0]);
  const ox = ((b0.x0 + b0.x1) / 2) * G, oz = ((b0.z0 + b0.z1) / 2) * G;
  const W = (xc, zc) => [xc * G - ox, zc * G - oz];
  const placements = [];
  const add = (p) => { p.pos = p.pos.map(r3); placements.push(p); };

  // 线上某点（沿 run 的 s 坐标，单位格）→ 世界坐标
  const runPoint = (run, s) => (run.dir === 'N' || run.dir === 'S') ? W(s, run.line) : W(run.line, s);

  const windowsResolved = spec.floors.map(() => []);

  // 地砖：能拼 1m 砖就拼，剩下用 0.5m 砖
  const emitTiles = (cells, kind, floor, y) => {
    const used = new Set();
    const sorted = [...cells].map(unkey).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [x, z] of sorted) {
      const k = key(x, z);
      if (used.has(k)) continue;
      const quad = [k, key(x + 1, z), key(x, z + 1), key(x + 1, z + 1)];
      if (quad.every((q) => cells.has(q) && !used.has(q))) {
        quad.forEach((q) => used.add(q));
        const [wx, wz] = W(x + 1, z + 1);
        add({ prefab: `${kind}_tile_1m`, cat: kind, floor, pos: [wx, y, wz], rot: 0, params: { size: 1.0 } });
      } else {
        used.add(k);
        const [wx, wz] = W(x + 0.5, z + 0.5);
        add({ prefab: `${kind}_tile_0.5m`, cat: kind, floor, pos: [wx, y, wz], rot: 0, params: { size: 0.5 } });
      }
    }
  };

  for (let i = 0; i < n; i++) {
    const fl = spec.floors[i];
    const y0 = base(i);

    // —— 楼板 / 地面砖 ——
    emitTiles(occ[i], 'floor', i, y0);

    // —— 外墙：门、自动窗、实墙填充 ——
    for (const run of runs[i]) {
      const openings = doorsResolved[i].filter((d) => d.run === run).map((d) => ({ type: 'door', start: d.start, width: d.width }));
      if (fl.window) {
        const { width: ww, gap } = fl.window;
        const uf = run.from + 1, ut = run.to - 1, L = ut - uf;
        const cnt = Math.floor((L + gap) / (ww + gap));
        if (cnt >= 1) {
          const total = cnt * ww + (cnt - 1) * gap;
          const s0 = uf + Math.floor((L - total) / 2);
          for (let k = 0; k < cnt; k++) {
            const s = s0 + k * (ww + gap);
            const clash = openings.some((o) => o.type === 'door' && s < o.start + o.width + 1 && o.start - 1 < s + ww);
            if (!clash) openings.push({ type: 'window', start: s, width: ww });
          }
        }
      }
      openings.sort((a, b) => a.start - b.start);
      windowsResolved[i].push(...openings.filter((o) => o.type === 'window').map((o) => ({ ...o, dir: run.dir, line: run.line })));

      const rot = ROT[run.dir];
      let cur = run.from;
      const emitSolid = (a, b) => {
        let s = a;
        for (const len of fillSolid(b - a)) {
          const [wx, wz] = runPoint(run, s + len / 2);
          add({ prefab: `wall_${len * G}m`, cat: 'wall', floor: i, pos: [wx, y0, wz], rot, params: { len: len * G, h: FH } });
          s += len;
        }
      };
      for (const o of openings) {
        if (o.start > cur) emitSolid(cur, o.start);
        const [wx, wz] = runPoint(run, o.start + o.width / 2);
        const w = o.width * G;
        if (o.type === 'door') {
          const doorH = clamp(FH - 0.8, 2.1, 2.8);
          add({ prefab: `door_${w}m`, cat: 'door', floor: i, pos: [wx, y0, wz], rot, params: { w, h: FH, doorH } });
        } else {
          const wr = fl.window;
          add({ prefab: `window_${w}m`, cat: 'window', floor: i, pos: [wx, y0, wz], rot, params: { w, h: FH, sill: wr.sill * G, winH: wr.height * G } });
        }
        cur = o.start + o.width;
      }
      if (cur < run.to) emitSolid(cur, run.to);
    }

    // —— 转角柱 ——
    const corners = new Map();
    for (const run of runs[i]) {
      for (const s of [run.from, run.to]) {
        const [wx, wz] = runPoint(run, s);
        corners.set(key(r3(wx), r3(wz)), [wx, wz]);
      }
    }
    for (const [wx, wz] of corners.values())
      add({ prefab: 'corner_post', cat: 'post', floor: i, pos: [wx, y0, wz], rot: 0, params: { h: FH } });

    // —— 腰檐 ——
    if (fl.eave) {
      for (const run of runs[i]) {
        const len = (run.to - run.from) * G;
        let depth = 1.0;
        if (i === 0 && spec.columns && spec.columns.side === run.dir) depth = spec.columns.offset * G + 0.6;
        const [wx, wz] = runPoint(run, (run.from + run.to) / 2);
        add({ prefab: 'eave_band', cat: 'eave', floor: i, pos: [wx, y0 + FH, wz], rot: ROT[run.dir], params: { len: len + 2 * depth, depth } });
      }
    }

    // —— 露台（本层被上层退让出来的部分）——
    if (i < n - 1) {
      const exposed = new Set([...occ[i]].filter((k) => !occ[i + 1].has(k)));
      const yT = base(i + 1);
      emitTiles(exposed, 'terrace', i + 1, yT);
      const rRuns = edgeRuns(exposed, (x, z) => !occ[i].has(key(x, z)));
      for (const run of rRuns) {
        let s = run.from;
        for (const len of fillSolid(run.to - run.from)) {
          const [wx, wz] = runPoint(run, s + len / 2);
          const [dx, dz] = OUT[run.dir];
          add({ prefab: `railing_${len * G}m`, cat: 'railing', floor: i + 1, pos: [wx - dx * 0.12, yT, wz - dz * 0.12], rot: ROT[run.dir], params: { len: len * G } });
          s += len;
        }
      }
    }
  }

  // —— 台基 ——
  if (spec.plinth > 0) {
    const pc = new Set();
    for (const k of occ[0]) {
      const [x, z] = unkey(k);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) pc.add(key(x + dx, z + dz));
    }
    if (spec.columns) {
      const ext = spec.columns.offset + 1;
      for (const run of runs[0].filter((r) => r.dir === spec.columns.side)) {
        const [dx, dz] = OUT[run.dir];
        for (let s = run.from - 1; s < run.to + 1; s++)
          for (let t = 0; t < ext; t++) {
            if (run.dir === 'S') pc.add(key(s, run.line + t));
            if (run.dir === 'N') pc.add(key(s, run.line - 1 - t));
            if (run.dir === 'E') pc.add(key(run.line + t, s));
            if (run.dir === 'W') pc.add(key(run.line - 1 - t, s));
          }
        void dx; void dz;
      }
    }
    for (const [x, z, w, d] of greedyRects(pc)) {
      const [wx, wz] = W(x + w / 2, z + d / 2);
      add({ prefab: 'plinth', cat: 'plinth', floor: 0, pos: [wx, 0, wz], rot: 0, params: { w: w * G, d: d * G, h: P } });
    }
    // 入户台阶
    for (const d of doorsResolved[0]) {
      const ext = (spec.columns && spec.columns.side === d.side ? spec.columns.offset + 1 : 1) * G;
      const [wx, wz] = runPoint(d.run, d.start + d.width / 2);
      const [dx, dz] = OUT[d.side];
      const nSteps = Math.max(2, Math.round(P / 0.16));
      add({ prefab: 'steps', cat: 'steps', floor: 0, pos: [wx + dx * ext, 0, wz + dz * ext], rot: ROT[d.side], params: { w: d.width * G + 0.4, h: P, n: nSteps, tread: 0.3 } });
    }
  }

  // —— 廊柱 ——
  if (spec.columns) {
    const { side, spacing, offset } = spec.columns;
    for (const run of runs[0].filter((r) => r.dir === side)) {
      const pts = [];
      for (let s = run.from; s <= run.to; s += spacing) pts.push(s);
      if (pts[pts.length - 1] !== run.to) pts.push(run.to);
      const [dx, dz] = OUT[side];
      for (const s of pts) {
        const [wx, wz] = runPoint(run, s);
        add({ prefab: 'column', cat: 'column', floor: 0, pos: [wx + dx * offset * G, base(0), wz + dz * offset * G], rot: 0, params: { h: FH } });
      }
    }
  }

  // —— 屋顶（顶层每个矩形一个屋顶生成器）——
  const top = n - 1;
  const yR = base(top) + FH;
  if (spec.roof.type === 'flat') {
    for (const [x, z, w, d] of greedyRects(occ[top])) {
      const [wx, wz] = W(x + w / 2, z + d / 2);
      add({ prefab: 'roof_slab', cat: 'roof', floor: n, pos: [wx, yR, wz], rot: 0, params: { w: w * G, d: d * G } });
    }
    for (const run of runs[top]) {
      const [wx, wz] = runPoint(run, (run.from + run.to) / 2);
      add({ prefab: 'parapet', cat: 'roof', floor: n, pos: [wx, yR, wz], rot: ROT[run.dir], params: { len: (run.to - run.from) * G } });
    }
  } else {
    for (const [x, z, w, d] of spec.floors[top].blocks) {
      const [wx, wz] = W(x + w / 2, z + d / 2);
      add({
        prefab: `roof_${spec.roof.type}`, cat: 'roof', floor: n, pos: [wx, yR, wz], rot: 0,
        params: { Lx: w * G, Lz: d * G, pitch: spec.roof.pitch, overhang: spec.roof.overhang * G, curve: spec.roof.curve },
      });
    }
  }

  // —— 统计 ——
  const all = new Set(occ.flatMap((o) => [...o]));
  const ball = bbox(all);
  let roofRise = 0;
  if (spec.roof.type !== 'flat') {
    for (const [, , w, d] of spec.floors[top].blocks)
      roofRise = Math.max(roofRise, (Math.min(w, d) * G / 2) * Math.tan((spec.roof.pitch * Math.PI) / 180));
  } else roofRise = 0.9;
  const counts = {};
  for (const p of placements) counts[p.prefab] = (counts[p.prefab] || 0) + 1;
  const area = occ.reduce((s, o) => s + o.size * G * G, 0);

  const result = {
    placements,
    counts,
    floorsCount: n,
    stats: {
      width: r3((ball.x1 - ball.x0) * G),
      depth: r3((ball.z1 - ball.z0) * G),
      height: r3(yR + roofRise),
      area: Math.round(area),
      prefabTotal: placements.length,
      windows: windowsResolved.reduce((s, a) => s + a.length, 0),
      doors: doorsResolved.reduce((s, a) => s + a.length, 0),
    },
    center: [0, 0],
  };

  const blocking = errors.filter((e) => e.hard);
  return { ok: errors.length === 0, partialOk: blocking.length === 0, spec, errors, warnings, result };
}

export const WALL_THICKNESS = WALL_T;
