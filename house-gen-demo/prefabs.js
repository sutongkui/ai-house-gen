// ============================================================================
// prefabs.js — 预制件库（方块占位版）
// 每个预制件 = 若干个局部坐标下的盒子：{ s:[sx,sy,sz], p:[x,y,z], m:材质, rx?:绕X倾角, full?:是否贯通整段 }
// 局部坐标：原点在墙线中心、楼层地面；+x 沿墙；+y 向上；+z 指向室外。
// 将来替换成美术资产时，只需把这里换成 prefab id → 模型资源 的映射。
// ============================================================================

export const PALETTES = {
  chinese:  { wall: '#EEE9DD', trim: '#8C8B86', column: '#8E2B22', roof: '#3F444A', ridge: '#2C3034', gable: '#8E2B22', door: '#7A2E22', frame: '#5B3A22', glass: '#E8E0C8', floor: '#B89F7F', terrace: '#A9A39A', railing: '#6B3A26' },
  japanese: { wall: '#F1EDE3', trim: '#4A3B2C', column: '#4A3B2C', roof: '#4B5157', ridge: '#33383D', gable: '#4A3B2C', door: '#5A4632', frame: '#4A3B2C', glass: '#F2ECDC', floor: '#C2A57E', terrace: '#9E8B70', railing: '#4A3B2C' },
  modern:   { wall: '#F5F5F3', trim: '#3A3D42', column: '#3A3D42', roof: '#5B6066', ridge: '#3A3D42', gable: '#F5F5F3', door: '#2F3338', frame: '#2F3338', glass: '#8FB3CB', floor: '#C9C3B9', terrace: '#B5AEA3', railing: '#2F3338' },
  european: { wall: '#EFE3C8', trim: '#F7F4EC', column: '#F7F4EC', roof: '#9C4A33', ridge: '#7E3A28', gable: '#EFE3C8', door: '#5E3B26', frame: '#FFFFFF', glass: '#9DB8C6', floor: '#B9A07F', terrace: '#ADA595', railing: '#F7F4EC' },
  nordic:   { wall: '#E9E4DA', trim: '#B98E5E', column: '#B98E5E', roof: '#3B3B3B', ridge: '#262626', gable: '#E9E4DA', door: '#2C2C2C', frame: '#2C2C2C', glass: '#A7BFCB', floor: '#D1B48C', terrace: '#B7A68C', railing: '#2C2C2C' },
};

export const MAT_LABEL = {
  wall: '墙体', trim: '基座/收边', column: '柱', roof: '屋面', ridge: '屋脊', gable: '山花',
  door: '门', frame: '窗框/格栅', glass: '玻璃/窗纸', floor: '楼板', terrace: '露台', railing: '栏杆',
};

export const CAT_LABEL = {
  wall: '墙段', door: '门', window: '窗', post: '转角柱', floor: '楼板砖', terrace: '露台砖',
  railing: '栏杆', eave: '腰檐', column: '廊柱', roof: '屋顶', plinth: '台基', steps: '台阶',
};

const T = 0.2;

function windowParts(p, style) {
  const { w, h, sill, winH } = p;
  const head = h - sill - winH;
  const parts = [
    { s: [w, sill, T], p: [0, sill / 2, 0], m: 'wall', full: true },
    { s: [w, head, T], p: [0, sill + winH + head / 2, 0], m: 'wall', full: true },
    { s: [w - 0.1, winH - 0.1, 0.04], p: [0, sill + winH / 2, 0], m: 'glass' },
    { s: [0.06, winH, T * 0.7], p: [-w / 2 + 0.03, sill + winH / 2, 0], m: 'frame' },
    { s: [0.06, winH, T * 0.7], p: [w / 2 - 0.03, sill + winH / 2, 0], m: 'frame' },
    { s: [w, 0.06, T * 0.7], p: [0, sill + 0.03, 0], m: 'frame' },
    { s: [w, 0.06, T * 0.7], p: [0, sill + winH - 0.03, 0], m: 'frame' },
  ];
  const yc = sill + winH / 2;
  if (style === 'chinese' || style === 'japanese') {
    const nv = Math.max(2, Math.round(w / 0.25));
    for (let k = 1; k < nv; k++) parts.push({ s: [0.03, winH - 0.1, 0.05], p: [-w / 2 + (k * w) / nv, yc, 0.03], m: 'frame' });
    const nh = Math.max(2, Math.round(winH / (style === 'japanese' ? 0.3 : 0.25)));
    for (let k = 1; k < nh; k++) parts.push({ s: [w - 0.1, 0.03, 0.05], p: [0, sill + (k * winH) / nh, 0.03], m: 'frame' });
  } else if (style === 'european' || style === 'nordic') {
    parts.push({ s: [0.05, winH - 0.1, 0.06], p: [0, yc, 0.03], m: 'frame' });
    parts.push({ s: [w - 0.1, 0.05, 0.06], p: [0, sill + winH * 0.62, 0.03], m: 'frame' });
    if (style === 'european') parts.push({ s: [w + 0.16, 0.08, 0.3], p: [0, sill - 0.04, 0.08], m: 'trim' });
  } else {
    const nm = Math.max(0, Math.round(w / 1.5) - 1);
    for (let k = 1; k <= nm; k++) parts.push({ s: [0.05, winH - 0.1, 0.06], p: [-w / 2 + (k * w) / (nm + 1), yc, 0.03], m: 'frame' });
  }
  return parts;
}

function doorParts(p, style) {
  const { w, h, doorH } = p;
  const parts = [
    { s: [w, h - doorH, T], p: [0, doorH + (h - doorH) / 2, 0], m: 'wall', full: true },
    { s: [w - 0.12, doorH, T * 0.5], p: [0, doorH / 2, 0], m: 'door' },
    { s: [0.08, doorH, T + 0.04], p: [-w / 2 + 0.04, doorH / 2, 0], m: 'frame' },
    { s: [0.08, doorH, T + 0.04], p: [w / 2 - 0.04, doorH / 2, 0], m: 'frame' },
    { s: [w, 0.1, T + 0.04], p: [0, doorH, 0], m: 'frame' },
  ];
  if (w >= 1.4) {
    const leaves = style === 'chinese' && w >= 2.2 ? 4 : 2;
    for (let k = 1; k < leaves; k++) parts.push({ s: [0.04, doorH, T * 0.5 + 0.03], p: [-w / 2 + (k * w) / leaves, doorH / 2, 0], m: 'frame' });
  }
  if (style === 'chinese' || style === 'japanese') {
    parts.push({ s: [w - 0.12, 0.04, T * 0.5 + 0.03], p: [0, doorH * 0.62, 0], m: 'frame' });
  }
  return parts;
}

function railingParts(p, style) {
  const { len } = p;
  const parts = [
    { s: [len, 0.06, 0.07], p: [0, 1.0, 0], m: 'railing', full: true },
    { s: [0.07, 1.0, 0.07], p: [-len / 2 + 0.035, 0.5, 0], m: 'railing' },
  ];
  if (style === 'modern') {
    parts.push({ s: [len - 0.08, 0.9, 0.02], p: [0, 0.5, 0], m: 'glass' });
  } else {
    parts.push({ s: [len, 0.05, 0.06], p: [0, 0.12, 0], m: 'railing', full: true });
    const nb = Math.max(1, Math.round(len / 0.14));
    for (let k = 1; k < nb; k++) parts.push({ s: [0.03, 0.85, 0.03], p: [-len / 2 + (k * len) / nb, 0.55, 0], m: 'railing' });
  }
  return parts;
}

export function buildParts(pl, style) {
  const p = pl.params || {};
  const id = pl.prefab;
  if (id.startsWith('wall_')) return [{ s: [p.len, p.h, T], p: [0, p.h / 2, 0], m: 'wall', full: true }];
  if (id.startsWith('door_')) return doorParts(p, style);
  if (id.startsWith('window_')) return windowParts(p, style);
  if (id === 'corner_post') {
    const asColumn = style === 'chinese' || style === 'japanese';
    return [{ s: asColumn ? [0.3, p.h, 0.3] : [0.22, p.h, 0.22], p: [0, p.h / 2, 0], m: asColumn ? 'column' : style === 'nordic' ? 'trim' : 'wall' }];
  }
  if (id.startsWith('floor_tile')) return [{ s: [p.size - 0.01, 0.15, p.size - 0.01], p: [0, -0.075, 0], m: 'floor' }];
  if (id.startsWith('terrace_tile')) return [{ s: [p.size, 0.15, p.size], p: [0, -0.075, 0], m: 'terrace' }];
  if (id.startsWith('railing_')) return railingParts(p, style);
  if (id === 'eave_band') {
    const a = (24 * Math.PI) / 180;
    return [
      { s: [p.len, 0.12, p.depth], p: [0, -0.06 - (Math.sin(a) * p.depth) / 2, (Math.cos(a) * p.depth) / 2], rx: a, m: 'roof' },
      { s: [p.len - 2 * p.depth + 0.2, 0.18, 0.16], p: [0, -0.12, 0.12], m: style === 'chinese' ? 'column' : 'trim' },
    ];
  }
  if (id === 'column') {
    const asWood = style === 'chinese' || style === 'japanese';
    const parts = [{ s: asWood ? [0.3, p.h, 0.3] : [0.2, p.h, 0.2], p: [0, p.h / 2, 0], m: asWood ? 'column' : 'trim' }];
    if (asWood) parts.push({ s: [0.44, 0.14, 0.44], p: [0, 0.07, 0], m: 'trim' });
    return parts;
  }
  if (id === 'plinth') return [{ s: [p.w, p.h, p.d], p: [0, p.h / 2, 0], m: 'trim' }];
  if (id === 'steps') {
    const parts = [];
    for (let k = 0; k < p.n; k++) {
      const hh = (p.h * (p.n - k)) / p.n;
      parts.push({ s: [p.w, hh, p.tread], p: [0, hh / 2, (k + 0.5) * p.tread], m: 'trim' });
    }
    return parts;
  }
  if (id === 'roof_slab') return [{ s: [p.w, 0.3, p.d], p: [0, 0.15, 0], m: 'trim' }];
  if (id === 'parapet') return [
    { s: [p.len + 0.2, 0.8, 0.22], p: [0, 0.4, 0], m: 'wall', full: true },
    { s: [p.len + 0.26, 0.06, 0.3], p: [0, 0.83, 0], m: 'trim', full: true },
  ];
  return null; // 屋顶等生成器类预制件由渲染器单独处理
}
