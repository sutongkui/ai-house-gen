// ============================================================================
// app.js — UI、模型调用（WorkBuddy 云服务免密钥 LLM）、three.js 渲染
// ============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { compile } from './solver.js?v=20261114e';
import { buildParts, PALETTES, MAT_LABEL, CAT_LABEL } from './prefabs.js?v=20261114e';
import { SYSTEM_PROMPT, buildUserMessage, buildUserContent, buildRepairMessage, extractJSON, PRESETS, EXAMPLES } from './prompt.js?v=20261114e';

// 最大轮数（含第 1 轮生成）：玩家可在页面上修改，默认 5，范围 1~10，记在浏览器本地
const ROUNDS_DEFAULT = 5, ROUNDS_MIN = 1, ROUNDS_MAX = 10, ROUNDS_KEY = 'houseGen.maxRounds';
function clampRounds(v) {
  if (v === null || v === undefined || String(v).trim() === '') return ROUNDS_DEFAULT;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, n)) : ROUNDS_DEFAULT;
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function isLocalPreview() {
  return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
}

function explainLLMError(e) {
  if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return '已手动停止。';
  const code = (e && e.error && e.error.code) || '';
  const rid = e && e.requestId ? `（请求编号 ${e.requestId}）` : '';
  if (code.startsWith('auth_')) return `云服务鉴权失败：当前页面的来源域名与应用域名不一致。本地预览时常见，发布后在正式链接中即可正常调用；也可以先点「预设示例」体验求解与渲染。${rid}`;
  if (code === 'quota_rate_limited') return `调用太频繁，请 ${Math.ceil((e.retryAfterMs || 3000) / 1000)} 秒后再试。${rid}`;
  if (code.startsWith('quota_')) return `模型调用额度已用尽，请在 WorkBuddy 控制台查看额度。${rid}`;
  if (code === 'gateway_network_error') {
    return `网络错误：连不上云服务。公司网络下请先打开 iOA 再刷新页面；也可以用「复制提示词」手动模式，或点预设示例体验求解与渲染。${rid}`;
  }
  if (code === 'gateway_stream_interrupted') return `模型输出中途断开，请重试。${rid}`;
  if (code === 'model_not_granted') return `云服务返回 model_not_granted：该模型当前未对本应用开放（服务端判定，与前端代码无关），请换「已开通」分组里的模型。${rid}`;
  if (code.startsWith('gateway_') || code.startsWith('model_')) return `模型服务暂时不可用，请重试或换一个模型。${rid}`;
  if (code.startsWith('request_')) return `请求参数与所选模型不匹配，请换一个模型。${rid}`;
  if (e && (e.status === 502 || e.status === 504)) return `模型思考太久、首字超时被云服务网关切断（HTTP ${e.status}）。请换一个响应更快的模型，或稍后重试。${rid}`;
  return `调用失败：${(e && e.message) || '未知错误'}${rid}`;
}

// ----------------------------------------------------------------------------
// three.js 场景
// ----------------------------------------------------------------------------
const wrap = $('canvasWrap');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#F4F2ED');
scene.fog = new THREE.Fog('#F4F2ED', 90, 200);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
camera.position.set(22, 16, 28);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight('#ffffff', '#c9c2b2', 1.1));
const sun = new THREE.DirectionalLight('#fff6e8', 2.0);
sun.position.set(18, 30, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#E3DFD4', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(80, 80, '#cfc9bb', '#d9d4c8');
grid.position.y = -0.01;
scene.add(grid);

const houseGroup = new THREE.Group();
scene.add(houseGroup);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const matCache = {};

function getMats(style) {
  if (matCache[style]) return matCache[style];
  const pal = PALETTES[style];
  const mats = {};
  for (const [k, c] of Object.entries(pal)) {
    const opts = { color: c, roughness: 0.85, metalness: 0 };
    if (k === 'glass') {
      Object.assign(opts, style === 'modern' || style === 'european' || style === 'nordic'
        ? { roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.6 }
        : { roughness: 0.9, transparent: true, opacity: 0.92 });
    }
    if (k === 'roof') { opts.side = THREE.DoubleSide; opts.roughness = 0.75; }
    if (k === 'gable' || k === 'wall') opts.side = THREE.DoubleSide;
    mats[k] = new THREE.MeshStandardMaterial(opts);
  }
  matCache[style] = mats;
  return mats;
}

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap);
resize();
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();

// —— 屋顶生成器：gable / hip / xieshan / pyramid，可选檐角起翘 ——
function roofObject(pl, style, mats) {
  const { Lx, Lz, pitch, overhang: o, curve } = pl.params;
  const type = pl.prefab.slice(5);
  let lx = Lx, lz = Lz, extraRot = 0;
  if (lz > lx) { [lx, lz] = [lz, lx]; extraRot = Math.PI / 2; }
  const t = Math.tan((pitch * Math.PI) / 180);
  const A = lx / 2 + o, B = lz / 2 + o;
  const ye = -o * t, H = B * t, yr = ye + H;
  const roofQ = [], gableQ = [], ridges = [];
  const V = (x, y, z) => [x, y, z];

  if (type === 'gable') {
    roofQ.push([V(-A, ye, B), V(A, ye, B), V(A, yr, 0), V(-A, yr, 0)]);
    roofQ.push([V(A, ye, -B), V(-A, ye, -B), V(-A, yr, 0), V(A, yr, 0)]);
    for (const sx of [-1, 1]) {
      const x = (sx * lx) / 2;
      gableQ.push([V(x, 0, -lz / 2), V(x, 0, lz / 2), V(x, yr, 0), V(x, yr, 0)]);
    }
    ridges.push({ len: 2 * A, y: yr });
  } else if (type === 'hip' || type === 'pyramid') {
    const r = type === 'pyramid' ? 0 : A - B;
    roofQ.push([V(-A, ye, B), V(A, ye, B), V(r, yr, 0), V(-r, yr, 0)]);
    roofQ.push([V(A, ye, -B), V(-A, ye, -B), V(-r, yr, 0), V(r, yr, 0)]);
    roofQ.push([V(A, ye, B), V(A, ye, -B), V(r, yr, 0), V(r, yr, 0)]);
    roofQ.push([V(-A, ye, -B), V(-A, ye, B), V(-r, yr, 0), V(-r, yr, 0)]);
    if (r > 0.1) ridges.push({ len: 2 * r, y: yr });
  } else if (type === 'xieshan') {
    const k = 0.45, h1 = k * H, tt = k * B;
    const A2 = A - tt, B2 = B - tt, y1 = ye + h1;
    roofQ.push([V(-A, ye, B), V(A, ye, B), V(A2, y1, B2), V(-A2, y1, B2)]);
    roofQ.push([V(A, ye, -B), V(-A, ye, -B), V(-A2, y1, -B2), V(A2, y1, -B2)]);
    roofQ.push([V(A, ye, B), V(A, ye, -B), V(A2, y1, -B2), V(A2, y1, B2)]);
    roofQ.push([V(-A, ye, -B), V(-A, ye, B), V(-A2, y1, B2), V(-A2, y1, -B2)]);
    roofQ.push([V(-A2, y1, B2), V(A2, y1, B2), V(A2, yr, 0), V(-A2, yr, 0)]);
    roofQ.push([V(A2, y1, -B2), V(-A2, y1, -B2), V(-A2, yr, 0), V(A2, yr, 0)]);
    for (const sx of [-1, 1]) gableQ.push([V(sx * A2, y1, B2), V(sx * A2, y1, -B2), V(sx * A2, yr, 0), V(sx * A2, yr, 0)]);
    ridges.push({ len: 2 * A2, y: yr });
  }

  const doCurve = curve && (style === 'chinese' || style === 'japanese');
  const lift = style === 'chinese' ? 0.55 + 0.1 * o : 0.3;
  const deform = (p) => {
    if (!doCurve) return p;
    const u = Math.min(1, Math.abs(p[0]) / A), w = Math.min(1, Math.abs(p[2]) / B);
    const frac = Math.max(0, Math.min(1, (p[1] - ye) / H));
    const dy = lift * Math.pow(u, 6) * Math.pow(w, 6) - 0.07 * H * Math.sin(Math.PI * frac);
    return [p[0], p[1] + dy, p[2]];
  };
  const N = doCurve ? 10 : 1;
  const lerp = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
  const toGeom = (quads) => {
    const pos = [];
    for (const [p0, p1, p2, p3] of quads) {
      const P = (u, v) => deform(lerp(lerp(p0, p1, u), lerp(p3, p2, u), v));
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const a = P(i / N, j / N), b = P((i + 1) / N, j / N), c = P((i + 1) / N, (j + 1) / N), d = P(i / N, (j + 1) / N);
          pos.push(...a, ...b, ...c, ...a, ...c, ...d);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  };

  const grp = new THREE.Group();
  const roofMesh = new THREE.Mesh(toGeom(roofQ), mats.roof);
  roofMesh.castShadow = roofMesh.receiveShadow = true;
  grp.add(roofMesh);
  if (gableQ.length) {
    const gm = new THREE.Mesh(toGeom(gableQ), type === 'gable' ? mats.wall : mats.gable);
    gm.castShadow = gm.receiveShadow = true;
    grp.add(gm);
  }
  for (const r of ridges) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(r.len, 0.24, 0.3), mats.ridge);
    m.position.set(0, r.y + 0.08, 0);
    m.castShadow = true;
    grp.add(m);
    if (style === 'chinese') {
      for (const sx of [-1, 1]) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.6, 0.36), mats.ridge);
        c.position.set((sx * r.len) / 2, r.y + 0.35, 0);
        c.castShadow = true;
        grp.add(c);
      }
    }
  }
  grp.position.set(pl.pos[0], pl.pos[1], pl.pos[2]);
  grp.rotation.y = (pl.rot || 0) + extraRot;
  return grp;
}

const view = { limit: Infinity, explode: 0, seams: true };
let current = null; // { compiled, rawSpec, source }

function disposeGroup(g) {
  g.traverse((o) => { if (o.geometry && o.geometry !== unitBox) o.geometry.dispose(); });
  g.clear();
}

function buildHouse(fit) {
  disposeGroup(houseGroup);
  if (!current || !current.compiled.result) return;
  const { spec, result } = current.compiled;
  const style = spec.style;
  const mats = getMats(style);
  const buckets = {};
  const mRun = new THREE.Matrix4(), mPart = new THREE.Matrix4();
  const q = new THREE.Quaternion(), eul = new THREE.Euler(), vp = new THREE.Vector3(), vs = new THREE.Vector3();

  for (const pl of result.placements) {
    if (pl.floor >= view.limit) continue;
    const dy = pl.floor * view.explode;
    if (pl.prefab.startsWith('roof_') && pl.prefab !== 'roof_slab') {
      const ro = roofObject(pl, style, mats);
      ro.position.y += dy;
      houseGroup.add(ro);
      continue;
    }
    const parts = buildParts(pl, style);
    if (!parts) continue;
    mRun.makeRotationY(pl.rot || 0).setPosition(pl.pos[0], pl.pos[1] + dy, pl.pos[2]);
    for (const part of parts) {
      let sx = part.s[0];
      if (view.seams && part.full) sx = Math.max(0.01, sx - 0.04);
      eul.set(part.rx || 0, 0, 0);
      q.setFromEuler(eul);
      mPart.compose(vp.set(part.p[0], part.p[1], part.p[2]), q, vs.set(sx, part.s[1], part.s[2]));
      (buckets[part.m] ||= []).push(new THREE.Matrix4().multiplyMatrices(mRun, mPart));
    }
  }
  for (const [m, arr] of Object.entries(buckets)) {
    const im = new THREE.InstancedMesh(unitBox, mats[m], arr.length);
    arr.forEach((M, i) => im.setMatrixAt(i, M));
    im.castShadow = true;
    im.receiveShadow = true;
    houseGroup.add(im);
  }

  const box = new THREE.Box3().setFromObject(houseGroup);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const R = Math.max(size.x, size.y, size.z);
  sun.position.set(center.x + R * 0.9, R * 1.6 + 10, center.z + R * 1.1);
  sun.target.position.copy(center);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -R * 1.2; sc.right = sc.top = R * 1.2; sc.near = 1; sc.far = R * 6 + 40;
  sc.updateProjectionMatrix();
  if (fit) {
    controls.target.set(center.x, center.y * 0.7, center.z);
    const dist = R * 1.75 + 6;
    camera.position.set(center.x + dist * 0.62, center.y + dist * 0.5, center.z + dist * 0.85);
    controls.update();
  }
}

// ----------------------------------------------------------------------------
// UI
// ----------------------------------------------------------------------------
const promptEl = $('prompt');
const genBtn = $('gen');
const stopBtn = $('stop');
const modelSel = $('model');
let abortCtl = null;

EXAMPLES.forEach((t) => {
  const c = el('button', 'chip', t);
  c.onclick = () => { promptEl.value = t; promptEl.focus(); };
  $('examples').appendChild(c);
});
PRESETS.forEach((p) => {
  const c = el('button', 'chip ghost', p.label);
  c.onclick = () => loadSpec(p.spec, { kind: 'preset', label: p.label });
  $('presets').appendChild(c);
});

// tabs
document.querySelectorAll('.tab-btn').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === b.dataset.tab));
  };
});

// pipeline steps
const STEPS = [
  ['llm', '模型规划', '一句话 → 设计参数'],
  ['parse', '解析', '提取 JSON'],
  ['check', '校验', '约束检查 / 回传修复'],
  ['solve', '求解', '参数 → 预制件摆放'],
  ['render', '渲染', '方块占位预览'],
];
const stepEls = {};
STEPS.forEach(([id, name, sub]) => {
  const li = el('li', 'step');
  li.appendChild(el('span', 'dot'));
  const tx = el('div', 'step-text');
  tx.appendChild(el('b', '', name));
  tx.appendChild(el('span', 'sub', sub));
  li.appendChild(tx);
  const st = el('span', 'step-status', '');
  li.appendChild(st);
  $('steps').appendChild(li);
  stepEls[id] = { li, st };
});
function setStep(id, state, text = '') {
  const s = stepEls[id];
  s.li.className = 'step ' + state;
  s.st.textContent = text;
}
function resetSteps() { STEPS.forEach(([id]) => setStep(id, '')); }
function log(msg, kind = '') {
  const li = el('li', kind);
  const t = new Date();
  li.appendChild(el('span', 'time', `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`));
  li.appendChild(el('span', '', msg));
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}

// —— 模型列表（从后端 /api/config 读取，key 不进前端）——
async function loadModels() {
  modelSel.innerHTML = '';
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    const effortLabels = cfg.effort_labels || {};
    const providers = cfg.models || [];
    for (const p of providers) {
      modelMeta[p.id] = { id: p.id, name: p.label, supportsImages: p.supportsImages };
      const o = el('option', '', `${p.label}  · ${effortLabels[p.effort] || p.effort}` + (p.supportsImages ? '' : '  · 无图'));
      o.value = p.id;
      modelSel.appendChild(o);
    }
    log(`已加载 ${providers.length} 个直连模型，思考档位已在列表中标注。`, 'ok');
  } catch (e) {
    modelSel.appendChild(el('option', '', '模型配置加载失败'));
    genBtn.disabled = true;
    log('模型配置加载失败，请确认 dev_server 已运行。', 'err');
  }
}

// —— 手动模式：复制提示词到任意聊天模型，再把返回的 JSON 粘回「设计参数」——
$('copyPrompt').onclick = async () => {
  const text = promptEl.value.trim() || EXAMPLES[0];
  const full = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserMessage(refImage ? promptEl.value.trim() : text, !!refImage)}`;
  try {
    await navigator.clipboard.writeText(full);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = full; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  document.querySelector('[data-tab="tab-spec"]').click();
  $('specEditor').value = '';
  $('specEditor').placeholder = '把模型返回的 JSON 粘贴到这里，然后点「按编辑后的参数重新求解」';
  $('specEditor').focus();
  log(`已复制完整提示词（${full.length} 字）。粘贴到任意聊天模型${refImage ? '，并把参考图一起发给它' : ''}，把它返回的 JSON 粘到「设计参数」里再点重新求解。`, 'ok');
};

// —— 直连 LLM 调用（经本地 /api/llm 代理转发到混元/DeepSeek，规避 CORS）——
const modelMeta = {};
const defaultEffort = () => undefined;   // 兼容 generate() 的调用；直连模型无需动态降档

async function callLLM(messages, signal, onProgress) {
  const resp = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelSel.value, messages }),
    signal,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    let code = '', msg = `HTTP ${resp.status}`;
    try { const j = JSON.parse(t); if (j.error) { code = j.error.code || j.error.type || ''; msg = j.error.message || msg; } } catch (_) {}
    const e = new Error(msg);
    e.status = resp.status;
    if (code) e.error = { code, message: msg };
    throw e;
  }
  const j = await resp.json();
  const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const usage = j.usage || null;
  onProgress(content, 0);
  return { content, usage };
}

async function callWithFallback(messages, signal, onProgress) {
  return await callLLM(messages, signal, onProgress);
}

// —— 最大轮数输入框 ——
const roundsEl = $('maxRounds');
function roundsHintText(n) { return n > 1 ? `1 轮生成 + 最多 ${n - 1} 轮修复` : '只生成 1 轮，不修复'; }
function readRounds() {
  const n = clampRounds(roundsEl.value);
  roundsEl.value = String(n);
  $('roundsHint').textContent = roundsHintText(n);
  return n;
}
(function initRounds() {
  let saved = null;
  try { saved = localStorage.getItem(ROUNDS_KEY); } catch (_) { /* 隐私模式等不可用时忽略 */ }
  roundsEl.value = String(saved === null ? ROUNDS_DEFAULT : clampRounds(saved));
  readRounds();
  roundsEl.addEventListener('input', () => {
    const n = Number(roundsEl.value);
    if (roundsEl.value !== '' && Number.isFinite(n)) $('roundsHint').textContent = roundsHintText(clampRounds(n));
  });
  roundsEl.addEventListener('change', () => {
    const n = readRounds();
    try { localStorage.setItem(ROUNDS_KEY, String(n)); } catch (_) { /* ignore */ }
  });
})();

// ----------------------------------------------------------------------------
// 参考图：选择 / 拖入 / 粘贴 → 压缩到长边 1280 的 JPEG → 作为多模态消息发给模型
// ----------------------------------------------------------------------------
const IMG_MAX_EDGE = 1280, IMG_MAX_BYTES = 20 * 1024 * 1024;
let refImage = null; // { dataUrl, name, w, h, kb }

function imageOk(id) {
  const m = modelMeta[id];
  if (!m) return true;                               // 未知能力：不拦截，以实际调用结果为准
  return m.supportsImages !== false && m.disabledMultimodal !== true;
}

async function loadImageFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { log(`「${file.name}」不是图片文件。`, 'err'); return; }
  if (file.size > IMG_MAX_BYTES) { log(`图片太大（${(file.size / 1048576).toFixed(1)} MB），请小于 20 MB。`, 'err'); return; }
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (_) { log(`「${file.name}」无法解码，请换 PNG/JPEG 图片。`, 'err'); return; }
  const k = Math.min(1, IMG_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);    // 透明背景铺白，避免 JPEG 变黑
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  // 质量 0.86 时实测会丢细节（三层楼阁 4 次里 3 次被读成两层），0.95 时 6/6 正确
  const dataUrl = cv.toDataURL('image/jpeg', 0.95);
  const kb = Math.round((dataUrl.length * 3) / 4 / 1024);
  refImage = { dataUrl, name: file.name || '粘贴的图片', w, h, kb };
  $('imgThumb').src = dataUrl;
  $('imgName').textContent = refImage.name;
  $('imgInfo').textContent = `${w}×${h} · ${kb} KB${k < 1 ? '（已压缩）' : ''}`;
  $('imgEmpty').hidden = true;
  $('imgPreview').hidden = false;
  if (promptEl.value.trim() === EXAMPLES[0]) promptEl.value = '';   // 默认示例句不当作补充要求
  promptEl.placeholder = '可留空；或写补充要求，如"改成两层""换成日式"';
  log(`已添加参考图「${refImage.name}」（${w}×${h}，${kb} KB）。`, 'ok');
  if (!imageOk(modelSel.value)) {
    const alt = [...modelSel.options].find((o) => o.value && imageOk(o.value));
    if (alt) { modelSel.value = alt.value; log(`原模型不支持图片，已切换到「${alt.textContent.split('  ·')[0]}」。`, 'warn'); }
  }
}

function clearImage() {
  refImage = null;
  $('imgInput').value = '';
  $('imgThumb').removeAttribute('src');
  $('imgPreview').hidden = true;
  $('imgEmpty').hidden = false;
  promptEl.placeholder = '';
  log('已移除参考图。');
}

(function initImageInput() {
  const zone = $('imgZone'), input = $('imgInput');
  zone.addEventListener('click', (e) => {
    if (e.target.closest('#imgClear') || e.target.closest('#imgPreview')) return;
    input.click();
  });
  zone.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !refImage) { e.preventDefault(); input.click(); } });
  $('imgThumb').addEventListener('click', () => input.click());
  $('imgClear').addEventListener('click', (e) => { e.stopPropagation(); clearImage(); });
  input.addEventListener('change', () => loadImageFile(input.files && input.files[0]));
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => loadImageFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
  document.addEventListener('paste', (e) => {
    if (document.activeElement && document.activeElement.id === 'specEditor') return;
    if (zone.classList.contains('busy')) return;
    const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (item) { e.preventDefault(); loadImageFile(item.getAsFile()); }
  });
})();

function setBusy(b) {
  genBtn.disabled = b;
  stopBtn.hidden = !b;
  promptEl.disabled = b;
  roundsEl.disabled = b;
  $('imgZone').classList.toggle('busy', b);
  document.querySelectorAll('#presets .chip').forEach((c) => (c.disabled = b));
}

async function generate() {
  const text = promptEl.value.trim();
  if (!text && !refImage) { promptEl.focus(); return; }
  if (refImage && !imageOk(modelSel.value)) {
    log(`当前模型「${modelSel.options[modelSel.selectedIndex].textContent.split('  ·')[0]}」不支持图片输入，请换一个模型或移除参考图。`, 'err');
    return;
  }
  const usedImage = refImage;
  if (!modelSel.value) { log('模型未就绪。', 'err'); return; }
  setBusy(true);
  resetSteps();
  $('log').innerHTML = '';
  $('raw').textContent = '';
  const modelName = modelSel.options[modelSel.selectedIndex].textContent.split('  ·')[0];
  log(usedImage
    ? `参考图「${usedImage.name}」（${usedImage.w}×${usedImage.h}，${usedImage.kb} KB）${text ? ` + 补充要求「${text}」` : ''} · 模型 ${modelName}`
    : `需求：「${text}」 · 模型 ${modelName}`);
  abortCtl = new AbortController();
  const t0 = performance.now();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent(text, usedImage && usedImage.dataUrl) },
  ];
  const history = [];
  let best = null, totalTokens = 0;
  const callState = { effort: defaultEffort(modelSel.value), gotOutput: false };
  const maxRounds = readRounds();
  log(`最大轮数 ${maxRounds}（1 轮生成${maxRounds > 1 ? ` + 最多 ${maxRounds - 1} 轮修复` : '，不修复'}）。`);
  if (callState.effort) log(`${modelName} 使用低思考档位（避免网关首字超时）。`);

  try {
    for (let round = 1; round <= maxRounds; round++) {
      setStep('llm', 'run', round === 1 ? '生成中…' : `第 ${round} 轮修复…`);
      setStep('parse', ''); setStep('check', '');
      const tr = performance.now();
      callState.gotOutput = false;
      const { content, usage } = await callWithFallback(messages, abortCtl.signal, (c, r) => {
        if (c || r) callState.gotOutput = true;
        const s = ((performance.now() - tr) / 1000).toFixed(1);
        setStep('llm', 'run', c ? `输出中 ${c.length} 字 · ${s}s` : r ? `思考中 ${r} 字 · ${s}s` : `等待中 ${s}s`);
        $('raw').textContent = c;
      }, callState);
      if (usage && usage.total_tokens) totalTokens += usage.total_tokens;
      const secs = ((performance.now() - tr) / 1000).toFixed(1);
      setStep('llm', 'ok', `第 ${round} 轮 ${secs}s`);
      log(`第 ${round} 轮：模型返回 ${content.length} 字，用时 ${secs}s`);

      setStep('parse', 'run');
      const parsed = extractJSON(content);
      let errors;
      let compiled = null;
      if (!parsed.ok) {
        setStep('parse', 'err', '失败');
        errors = [{ code: 'E_JSON', msg: parsed.error + '。请只输出一个合法的 JSON 对象。' }];
      } else {
        setStep('parse', 'ok');
        setStep('check', 'run');
        compiled = compile(parsed.value);
        errors = compiled.errors;
        if (compiled.partialOk && (!best || compiled.errors.length < best.compiled.errors.length)) best = { compiled, raw: parsed.value };
      }
      history.push({ round, errors: errors.map((e) => `[${e.code}] ${e.msg}`) });

      if (errors.length === 0) {
        setStep('check', 'ok', round > 1 ? `修复后通过（${round} 轮）` : '一次通过');
        log(round > 1 ? `第 ${round} 轮通过校验。` : '一次通过校验。', 'ok');
        best = { compiled, raw: parsed.value };
        break;
      }
      setStep('check', 'warn', `${errors.length} 个问题`);
      errors.forEach((e) => log(`[${e.code}] ${e.msg}`, 'warn'));
      if (round < maxRounds) {
        log(`把 ${errors.length} 个问题回传给模型修复…`);
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: buildRepairMessage(errors) });
      }
    }

    const total = ((performance.now() - t0) / 1000).toFixed(1);
    if (!best) {
      setStep('check', 'err', '未通过');
      log(`${maxRounds} 轮后仍无法得到可用的设计参数。可以调大「最大轮数」、换个说法或换个模型。`, 'err');
      renderCheck(null, history);
    } else {
      if (best.compiled.errors.length) log(`仍有 ${best.compiled.errors.length} 个问题未修复，已丢弃出错的门窗后继续求解。`, 'warn');
      loadCompiled(best.compiled, best.raw, { kind: 'llm', model: modelName, rounds: history.length, secs: total, tokens: totalTokens, image: usedImage }, history);
    }
  } catch (e) {
    setStep('llm', 'err', '失败');
    log(explainLLMError(e), 'err');
  } finally {
    setBusy(false);
    abortCtl = null;
  }
}

genBtn.onclick = generate;
stopBtn.onclick = () => abortCtl && abortCtl.abort();
promptEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

function loadSpec(rawSpec, source) {
  resetSteps();
  setStep('llm', 'skip', source.kind === 'preset' ? '预设，未调用' : '手动编辑');
  setStep('parse', 'ok');
  const compiled = compile(rawSpec);
  if (!compiled.partialOk) {
    setStep('check', 'err', `${compiled.errors.length} 个问题`);
    compiled.errors.forEach((e) => log(`[${e.code}] ${e.msg}`, 'err'));
    renderCheck(compiled, []);
    document.querySelector('[data-tab="tab-check"]').click();
    return;
  }
  setStep('check', compiled.errors.length ? 'warn' : 'ok', compiled.errors.length ? `${compiled.errors.length} 个问题` : '通过');
  loadCompiled(compiled, rawSpec, source, []);
}

function loadCompiled(compiled, rawSpec, source, history) {
  setStep('solve', 'run');
  current = { compiled, rawSpec, source };
  setStep('solve', 'ok', `${compiled.result.stats.prefabTotal} 个预制件`);
  setStep('render', 'run');
  updateFloorSelect(compiled.result.floorsCount);
  buildHouse(true);
  setStep('render', 'ok');
  $('empty').hidden = true;
  $('specEditor').value = JSON.stringify(rawSpec, null, 2);
  renderPlacements(compiled);
  renderCheck(compiled, history);
  renderHud(compiled, source);
  renderLegend(compiled.spec.style);
  refreshDock();
}

// —— 视图控制 ——
function updateFloorSelect(n) {
  const sel = $('floorLimit');
  sel.innerHTML = '';
  const all = el('option', '', '全部（含屋顶）');
  all.value = 'all';
  sel.appendChild(all);
  for (let k = n; k >= 1; k--) {
    const o = el('option', '', `剖切到 ${k} 层`);
    o.value = String(k);
    sel.appendChild(o);
  }
  sel.value = 'all';
  view.limit = Infinity;
}
$('floorLimit').onchange = (e) => { view.limit = e.target.value === 'all' ? Infinity : Number(e.target.value); buildHouse(false); };
$('explode').oninput = (e) => { view.explode = Number(e.target.value); buildHouse(false); };
$('seams').onchange = (e) => { view.seams = e.target.checked; buildHouse(false); };
$('resetView').onclick = () => buildHouse(true);

// —— 面板渲染 ——
function renderHud(compiled, source) {
  const { spec, result } = compiled;
  $('hudName').textContent = spec.name;
  $('hudNotes').textContent = spec.design_notes || '';
  const src = source.kind === 'llm'
    ? `来源：模型 ${source.model} · ${source.rounds} 轮 · ${source.secs}s${source.tokens ? ` · ${source.tokens} tokens` : ''}`
    : source.kind === 'preset' ? `来源：预设示例「${source.label}」（未调用模型）` : '来源：手动编辑参数';
  $('hudSource').textContent = src + (source.image ? ' · 参考图生成' : '');
  $('refFig').hidden = !source.image;
  if (source.image) $('refImg').src = source.image.dataUrl;
  const s = result.stats;
  const box = $('stats');
  box.innerHTML = '';
  const rows = [
    ['外轮廓', `${s.width} × ${s.depth} m`],
    ['总高', `${s.height} m`],
    ['层数', `${result.floorsCount} 层`],
    ['建筑面积', `${s.area} ㎡`],
    ['门 / 窗', `${s.doors} / ${s.windows}`],
    ['预制件', `${s.prefabTotal} 个`],
  ];
  for (const [k, v] of rows) {
    const d = el('div', 'stat');
    d.appendChild(el('span', 'k', k));
    d.appendChild(el('span', 'v', v));
    box.appendChild(d);
  }
}

function renderLegend(style) {
  const pal = PALETTES[style];
  const box = $('legend');
  box.innerHTML = '';
  for (const k of ['wall', 'column', 'roof', 'door', 'frame', 'glass', 'floor', 'terrace', 'railing', 'trim']) {
    const d = el('div', 'lg');
    const sw = el('i');
    sw.style.background = pal[k];
    d.appendChild(sw);
    d.appendChild(el('span', '', MAT_LABEL[k]));
    box.appendChild(d);
  }
}

function renderPlacements(compiled) {
  const { result } = compiled;
  const byCat = {};
  for (const p of result.placements) {
    byCat[p.cat] ||= {};
    byCat[p.cat][p.prefab] = (byCat[p.cat][p.prefab] || 0) + 1;
  }
  const tbl = $('countTable');
  tbl.innerHTML = '';
  const head = el('tr');
  ['类别', '预制件 ID', '数量'].forEach((h) => head.appendChild(el('th', '', h)));
  tbl.appendChild(head);
  for (const cat of Object.keys(CAT_LABEL)) {
    if (!byCat[cat]) continue;
    for (const [id, c] of Object.entries(byCat[cat]).sort()) {
      const tr = el('tr');
      tr.appendChild(el('td', '', CAT_LABEL[cat]));
      tr.appendChild(el('td', 'mono', id));
      tr.appendChild(el('td', 'num', String(c)));
      tbl.appendChild(tr);
    }
  }
  const sample = result.placements
    .filter((p, i, a) => a.findIndex((q) => q.prefab === p.prefab) === i)
    .slice(0, 14)
    .map((p) => ({ prefab: p.prefab, floor: p.floor, pos: p.pos, rot_deg: Math.round(((p.rot || 0) * 180) / Math.PI), params: p.params }));
  $('placeSample').textContent = sample.map((s) => JSON.stringify(s)).join('\n');
}

function renderCheck(compiled, history) {
  const box = $('checkBox');
  box.innerHTML = '';
  if (history && history.length) {
    box.appendChild(el('h4', '', '修复回合'));
    history.forEach((h) => {
      const d = el('div', 'round');
      d.appendChild(el('b', '', `第 ${h.round} 轮：${h.errors.length ? h.errors.length + ' 个问题' : '通过'}`));
      h.errors.forEach((e) => d.appendChild(el('div', 'item err', e)));
      box.appendChild(d);
    });
  }
  if (compiled) {
    box.appendChild(el('h4', '', '最终版本'));
    if (!compiled.errors.length) box.appendChild(el('div', 'item ok', '全部硬性约束通过'));
    compiled.errors.forEach((e) => box.appendChild(el('div', 'item err', `[${e.code}] ${e.msg}`)));
    if (compiled.warnings.length) {
      box.appendChild(el('h4', '', '自动修正（无需模型返工）'));
      compiled.warnings.forEach((w) => box.appendChild(el('div', 'item warn', w)));
    }
  }
}

$('resolve').onclick = () => {
  const parsed = extractJSON($('specEditor').value);
  if (!parsed.ok) { log(parsed.error, 'err'); return; }
  loadSpec(parsed.value, { kind: 'edit' });
  log('已按编辑后的设计参数重新求解（未调用模型）。', 'ok');
};

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('dlSpec').onclick = () => current && download('design_spec.json', current.rawSpec);
$('dlPlace').onclick = () => current && download('placements.json', {
  grid: 0.5, units: 'meter', style: current.compiled.spec.style,
  placements: current.compiled.result.placements.map((p) => ({ prefab: p.prefab, floor: p.floor, pos: p.pos, rot_deg: Math.round(((p.rot || 0) * 180) / Math.PI), params: p.params })),
});

// ----------------------------------------------------------------------------
// 组件栏：枚举系统全部预制件规格（36 种），为每个渲染 3D 缩略图 + 当前使用数量角标
// ----------------------------------------------------------------------------
// 每个条目：prefab=精确预制件 ID；label=显示名；group=大类；params=渲染用的代表性参数
const CATALOG = [
  // 墙段（0.5m 网格，2m/1m/0.5m 三档）
  { prefab: 'wall_2m', label: '墙 2m', group: '墙段', params: { len: 2, h: 3.5 } },
  { prefab: 'wall_1m', label: '墙 1m', group: '墙段', params: { len: 1, h: 3.5 } },
  { prefab: 'wall_0.5m', label: '墙 0.5m', group: '墙段', params: { len: 0.5, h: 3.5 } },
  // 门（1m~3m，0.5m 一档）
  { prefab: 'door_1m', label: '门 1m', group: '门', params: { w: 1, h: 3.5, doorH: 2.4 } },
  { prefab: 'door_1.5m', label: '门 1.5m', group: '门', params: { w: 1.5, h: 3.5, doorH: 2.4 } },
  { prefab: 'door_2m', label: '门 2m', group: '门', params: { w: 2, h: 3.5, doorH: 2.4 } },
  { prefab: 'door_2.5m', label: '门 2.5m', group: '门', params: { w: 2.5, h: 3.5, doorH: 2.4 } },
  { prefab: 'door_3m', label: '门 3m', group: '门', params: { w: 3, h: 3.5, doorH: 2.4 } },
  // 窗（0.5m~5m，0.5m 一档）
  { prefab: 'window_0.5m', label: '窗 0.5m', group: '窗', params: { w: 0.5, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_1m', label: '窗 1m', group: '窗', params: { w: 1, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_1.5m', label: '窗 1.5m', group: '窗', params: { w: 1.5, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_2m', label: '窗 2m', group: '窗', params: { w: 2, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_2.5m', label: '窗 2.5m', group: '窗', params: { w: 2.5, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_3m', label: '窗 3m', group: '窗', params: { w: 3, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_3.5m', label: '窗 3.5m', group: '窗', params: { w: 3.5, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_4m', label: '窗 4m', group: '窗', params: { w: 4, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_4.5m', label: '窗 4.5m', group: '窗', params: { w: 4.5, h: 3.5, sill: 1, winH: 1.5 } },
  { prefab: 'window_5m', label: '窗 5m', group: '窗', params: { w: 5, h: 3.5, sill: 1, winH: 1.5 } },
  // 楼板砖（1m/0.5m）
  { prefab: 'floor_tile_1m', label: '楼板 1m', group: '楼板', params: { size: 1 } },
  { prefab: 'floor_tile_0.5m', label: '楼板 0.5m', group: '楼板', params: { size: 0.5 } },
  // 露台砖（1m/0.5m）
  { prefab: 'terrace_tile_1m', label: '露台 1m', group: '露台', params: { size: 1 } },
  { prefab: 'terrace_tile_0.5m', label: '露台 0.5m', group: '露台', params: { size: 0.5 } },
  // 栏杆（2m/1m/0.5m 三档）
  { prefab: 'railing_2m', label: '栏杆 2m', group: '栏杆', params: { len: 2 } },
  { prefab: 'railing_1m', label: '栏杆 1m', group: '栏杆', params: { len: 1 } },
  { prefab: 'railing_0.5m', label: '栏杆 0.5m', group: '栏杆', params: { len: 0.5 } },
  // 屋顶
  { prefab: 'roof_gable', label: '双坡顶', group: '屋顶', params: { Lx: 4, Lz: 3, pitch: 30, overhang: 0.5, curve: false } },
  { prefab: 'roof_hip', label: '四坡顶', group: '屋顶', params: { Lx: 4, Lz: 3, pitch: 30, overhang: 0.5, curve: false } },
  { prefab: 'roof_xieshan', label: '歇山顶', group: '屋顶', params: { Lx: 4, Lz: 3, pitch: 30, overhang: 0.5, curve: true } },
  { prefab: 'roof_pyramid', label: '攒尖顶', group: '屋顶', params: { Lx: 3, Lz: 3, pitch: 30, overhang: 0.5, curve: true } },
  { prefab: 'roof_slab', label: '平屋顶', group: '屋顶', params: { w: 3, d: 3 } },
  { prefab: 'parapet', label: '女儿墙', group: '屋顶', params: { len: 3 } },
  // 结构 / 其他
  { prefab: 'corner_post', label: '转角柱', group: '结构', params: { h: 3.5 } },
  { prefab: 'column', label: '廊柱', group: '结构', params: { h: 3.5 } },
  { prefab: 'eave_band', label: '腰檐', group: '结构', params: { len: 3, depth: 1 } },
  { prefab: 'plinth', label: '台基', group: '结构', params: { w: 3, h: 0.5, d: 3 } },
  { prefab: 'steps', label: '台阶', group: '结构', params: { w: 2, h: 0.5, n: 3, tread: 0.3 } },
];

// —— 缩略图离屏渲染器（独立 context，与主场景互不干扰）——
let thumbRenderer = null;
try {
  thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setPixelRatio(1);
  thumbRenderer.setSize(150, 150);
  thumbRenderer.setClearColor(0x000000, 0);
} catch (e) {
  console.warn('离屏缩略图渲染器创建失败，组件栏将降级为文字占位。', e);
}
const thumbScene = new THREE.Scene();
const thumbCam = new THREE.PerspectiveCamera(28, 1, 0.01, 80);
thumbScene.add(new THREE.HemisphereLight('#ffffff', '#c9c2b2', 1.25));
const thumbSun = new THREE.DirectionalLight('#fff6e8', 2.6);
thumbSun.position.set(4, 6, 4);
thumbScene.add(thumbSun);

function partsToGroup(parts, mats) {
  const g = new THREE.Group();
  const eul = new THREE.Euler();
  for (const part of parts) {
    const m = new THREE.Mesh(unitBox, mats[part.m]);
    eul.set(part.rx || 0, 0, 0);
    m.quaternion.setFromEuler(eul);
    m.position.set(part.p[0], part.p[1], part.p[2]);
    m.scale.set(part.s[0], part.s[1], part.s[2]);
    g.add(m);
  }
  return g;
}

function buildCatalogThumb(item, style) {
  const mats = getMats(style);
  const group = new THREE.Group();
  if (item.prefab.startsWith('roof_') && item.prefab !== 'roof_slab') {
    group.add(roofObject({ prefab: item.prefab, params: item.params, pos: [0, 0, 0], rot: 0 }, style, mats));
  } else {
    const parts = buildParts({ prefab: item.prefab, params: item.params }, style);
    if (parts) group.add(partsToGroup(parts, mats));
  }
  return group;
}

function fitThumbCam(group) {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const R = Math.max(size.x, size.y, size.z) || 1;
  const dist = (R / 2) / Math.tan((28 * Math.PI) / 180 / 2) * 1.85;
  const az = Math.PI / 4, el = Math.PI / 5.5;
  thumbCam.position.set(
    center.x + dist * Math.cos(el) * Math.sin(az),
    center.y + dist * Math.sin(el),
    center.z + dist * Math.cos(el) * Math.cos(az),
  );
  thumbCam.lookAt(center);
}

function renderThumb(item, style) {
  if (!thumbRenderer) return null;
  try {
    const group = buildCatalogThumb(item, style);
    thumbScene.add(group);
    fitThumbCam(group);
    thumbRenderer.render(thumbScene, thumbCam);
    const dataUrl = thumbRenderer.domElement.toDataURL('image/png');
    thumbScene.remove(group);
    group.traverse((o) => { if (o.geometry && o.geometry !== unitBox) o.geometry.dispose(); });
    return dataUrl;
  } catch (e) {
    console.warn('缩略图渲染失败：', item.prefab, e);
    return null;
  }
}

const dock = $('partsDock');
const dockGrid = $('dockGrid');
const dockMeta = $('dockMeta');
const dockBody = $('dockBody');
const dockHead = $('dockHead');

// 渲染组件栏：为每个预制件生成 3D 缩略图 + 当前使用数量角标
function refreshDock() {
  const has = !!(current && current.compiled && current.compiled.result);
  const style = has ? current.compiled.spec.style : 'chinese';
  const counts = has ? current.compiled.result.counts : {};
  dockGrid.innerHTML = '';
  dockMeta.textContent = has ? `${current.compiled.spec.name} · ${current.compiled.result.stats.prefabTotal} 件` : `${CATALOG.length} 种组件`;
  for (const item of CATALOG) {
    const cell = el('div', 'dock-cell');
    cell.title = `${item.label}（${item.group}）`;
    const thumb = el('div', 'thumb');
    const dataUrl = renderThumb(item, style);
    if (dataUrl) {
      const img = document.createElement('img');
      img.alt = item.label;
      img.src = dataUrl;
      thumb.appendChild(img);
    } else {
      thumb.classList.add('noimg');
      thumb.textContent = item.label;
    }
    cell.appendChild(thumb);
    cell.appendChild(el('div', 'nm', item.label));
    const q = counts[item.prefab];
    if (q) cell.appendChild(el('div', 'qty', String(q)));
    dockGrid.appendChild(cell);
  }
}

// —— 拖动：抓住标题栏移动组件栏 ——
let dockDrag = null;
dockHead.addEventListener('pointerdown', (e) => {
  if (e.target === $('dockToggle')) return;
  const rect = dock.getBoundingClientRect();
  dockDrag = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
  dock.style.left = rect.left + 'px';
  dock.style.top = rect.top + 'px';
  dock.style.bottom = 'auto';
  dock.style.transform = 'none';
  dock.classList.add('dragging');
  dockHead.setPointerCapture(e.pointerId);
});
dockHead.addEventListener('pointermove', (e) => {
  if (!dockDrag) return;
  dock.style.left = (dockDrag.left + e.clientX - dockDrag.sx) + 'px';
  dock.style.top = (dockDrag.top + e.clientY - dockDrag.sy) + 'px';
});
const endDockDrag = () => { dockDrag = null; dock.classList.remove('dragging'); };
dockHead.addEventListener('pointerup', endDockDrag);
dockHead.addEventListener('pointercancel', endDockDrag);

// —— 收起 / 展开 & 显示 / 隐藏 ——
$('dockToggle').onclick = () => {
  const hidden = dockBody.hidden;
  dockBody.hidden = !hidden;
  $('dockToggle').textContent = hidden ? '▾' : '▸';
};
$('showCatalog').onclick = () => { dock.hidden = !dock.hidden; };

// —— 左栏宽度拖动调整 ——
const splitter = $('splitter');
const panelEl = $('panel');
let splitDrag = false;
splitter.addEventListener('pointerdown', (e) => {
  splitDrag = true;
  splitter.classList.add('dragging');
  splitter.setPointerCapture(e.pointerId);
});
splitter.addEventListener('pointermove', (e) => {
  if (!splitDrag) return;
  const w = Math.min(800, Math.max(280, e.clientX));
  panelEl.style.width = w + 'px';
});
const endSplitDrag = () => { splitDrag = false; splitter.classList.remove('dragging'); };
splitter.addEventListener('pointerup', endSplitDrag);
splitter.addEventListener('pointercancel', endSplitDrag);

// —— 启动 ——
loadModels();
loadSpec(PRESETS[0].spec, { kind: 'preset', label: PRESETS[0].label });
log('已载入预设示例。输入一句话并点击「生成」即可调用模型。');

// —— 评测辅助：暴露给 puppeteer 做固定视角截图（45° 俯视，含立面+屋顶）——
window.__houseGen = {
  fitView() { buildHouse(true); },
  snapshot() {
    buildHouse(true);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  },
  getSpec() {
    return current && current.compiled ? current.compiled.spec : null;
  },
  getResult() {
    const c = current && current.compiled;
    if (!c) return null;
    return {
      ok: !c.errors.length,
      errors: c.errors.map((e) => ({ code: e.code, hard: !!e.hard, msg: e.msg })),
      warnings: c.warnings,
      stats: c.result && c.result.stats,
      counts: c.result && c.result.counts,
    };
  },
};
