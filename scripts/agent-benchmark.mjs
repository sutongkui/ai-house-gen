import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { compile } from '../house-gen-demo/solver.js';
import { SYSTEM_PROMPT, buildUserContent, buildRepairMessage, extractJSON } from '../house-gen-demo/prompt.js';

const root = resolve('agent-benchmark-results', process.env.AGENT_BENCHMARK_RUN || '2026-11-21');
const url = 'http://127.0.0.1:8765';
const models = {
  hy4: '混元 HY4',
  'hy4-flash': '混元 HY4 Flash',
  'deepseek-flash': 'DeepSeek Flash',
  'gpt-6.2-astra': 'GPT‑6.2 Astra',
};
const dimensions = { literal: 0.25, subject: 0.2, usage: 0.15, style: 0.3, scene: 0.1 };
const beautyKeys = ['proportion', 'facade_rhythm', 'roof_harmony', 'style_coherence'];
const landmarkKeys = ['silhouette', 'massing', 'roof', 'facade', 'signature'];
const imageWeights = { silhouette: 25, massing: 25, facade: 20 };
const orientation = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 };
const matches = (property, value) => ({ spec }) => spec[property] === value;
const style = value => matches('style', value);
const floors = value => ({ spec }) => spec.floors.length === value;
const roof = value => ({ spec }) => spec.roof.type === value;
const entrance = side => ({ result }) => result.placements.some(p => p.cat === 'door' && p.floor === 0 && p.rot === orientation[side]);
const noWindows = floor => ({ result }) => !result.placements.some(p => p.cat === 'window' && (floor == null || p.floor === floor));

function grid(blocks) {
  const cells = new Set();
  const bounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const [x, z, width, depth] of blocks) {
    bounds.x0 = Math.min(bounds.x0, x);
    bounds.x1 = Math.max(bounds.x1, x + width);
    bounds.z0 = Math.min(bounds.z0, z);
    bounds.z1 = Math.max(bounds.z1, z + depth);
    for (let a = x; a < x + width; a++) {
      for (let b = z; b < z + depth; b++) cells.add(`${a},${b}`);
    }
  }
  return { cells, ...bounds, area: (bounds.x1 - bounds.x0) * (bounds.z1 - bounds.z0) };
}

function isCourtyard({ spec }) {
  const { cells, x0, x1, z0, z1, area } = grid(spec.floors[0].blocks);
  const outside = new Set();
  const queue = [[x0 - 1, z0 - 1]];
  for (let index = 0; index < queue.length; index++) {
    const [x, z] = queue[index];
    const key = `${x},${z}`;
    if (x < x0 - 1 || z < z0 - 1 || x > x1 || z > z1 || cells.has(key) || outside.has(key)) continue;
    outside.add(key);
    queue.push([x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]);
  }
  const padding = (x1 - x0 + 2) * (z1 - z0 + 2) - area;
  return outside.size < area - cells.size + padding;
}

function isL({ spec }) {
  const { cells, x0, x1, z0, z1, area } = grid(spec.floors[0].blocks);
  const missing = [];
  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1; z++) if (!cells.has(`${x},${z}`)) missing.push([x, z]);
  }
  if (!missing.length || missing.length === area) return false;
  const west = Math.min(...missing.map(([x]) => x));
  const east = Math.max(...missing.map(([x]) => x));
  const north = Math.min(...missing.map(([, z]) => z));
  const south = Math.max(...missing.map(([, z]) => z));
  return (west === x0) !== (east === x1 - 1)
    && (north === z0) !== (south === z1 - 1)
    && missing.length === (east - west + 1) * (south - north + 1);
}

function symmetric({ spec }) {
  const { cells, x0, x1 } = grid(spec.floors[0].blocks);
  return [...cells].every(key => {
    const [x, z] = key.split(',').map(Number);
    return cells.has(`${x0 + x1 - x - 1},${z}`);
  });
}

const wide = ({ result }) => result.stats.width >= result.stats.depth * 1.5;
const rectangular = ({ spec }) => {
  const footprint = grid(spec.floors[0].blocks);
  return footprint.cells.size === footprint.area;
};
const southTerrace = ({ spec, result }) => spec.floors.length >= 2
  && grid(spec.floors[0].blocks).z1 > grid(spec.floors[1].blocks).z1
  && result.placements.some(p => p.cat === 'railing' && p.floor === 1 && p.rot === 0 && p.pos[2] >= result.stats.depth / 2 - 0.25);
const centralDoor = ({ result }, minWidth = 0) => result.placements.some(p => p.cat === 'door' && p.floor === 0 && p.rot === 0
  && Math.abs(p.pos[0]) <= result.stats.width * 0.1 && p.params.w >= minWidth);
const verticalWindows = ({ result }) => result.placements.filter(p => p.cat === 'window' && p.rot === 0 && p.params.winH / p.params.w >= 1.2).length >= 3;
const narrows = ({ spec }) => spec.floors.length >= 2 && grid(spec.floors.at(-1).blocks).cells.size < grid(spec.floors[0].blocks).cells.size;
const hasPlinth = ({ spec }) => spec.plinth >= 1;
const nearSquare = ({ result }) => Math.min(result.stats.width, result.stats.depth) >= 0.8 * Math.max(result.stats.width, result.stats.depth);

function centeredUpperVolume(compiled) {
  if (!narrows(compiled)) return false;
  const { spec } = compiled;
  const base = grid(spec.floors[0].blocks);
  const top = grid(spec.floors.at(-1).blocks);
  return Math.abs(base.x0 + base.x1 - top.x0 - top.x1) <= (base.x1 - base.x0) * 0.2
    && Math.abs(base.z0 + base.z1 - top.z0 - top.z1) <= (base.z1 - base.z0) * 0.2;
}

const caseDefinitions = [
  { id: 'T01', title: '两层现代退台住宅', prompt: '一座两层现代住宅，平屋顶，南面入户，二层向北收进，在南边留带栏杆的露台。',
    desired: { literal: '两层平顶，二楼南侧退台带栏杆，南侧有入口', subject: '独立住宅', style: '现代建筑' },
    checks: [['现代', style('modern')], ['两层', floors(2)], ['平顶', roof('flat')], ['南侧入户', entrance('S')], ['南侧退台栏杆', southTerrace]] },
  { id: 'T02', prompt: '一座三层中式楼阁，歇山顶，正门在南边，顶层不开窗。',
    desired: { literal: '三层，歇山顶，南侧入口，顶层无窗', subject: '楼阁', style: '中式传统建筑' },
    checks: [['中式', style('chinese')], ['三层', floors(3)], ['歇山顶', roof('xieshan')], ['南侧入户', entrance('S')], ['顶层无窗', noWindows(2)]] },
  { id: 'T03', prompt: '一栋单层欧式住宅，平面是 L 形，双坡屋顶，在东侧开入户门。',
    desired: { literal: '单层，L 形体块，双坡屋顶，东侧入口', subject: '独立住宅', style: '欧式建筑' },
    checks: [['欧式', style('european')], ['单层', floors(1)], ['L 形', isL], ['双坡顶', roof('gable')], ['东侧入户', entrance('E')]] },
  { id: 'T04', prompt: '一栋单层北欧小屋，矩形平面，双坡屋顶，北边开门，整栋不要窗。',
    desired: { literal: '单层矩形体块，双坡屋顶，北侧入口，无窗', subject: '小屋', style: '北欧建筑' },
    checks: [['北欧', style('nordic')], ['单层矩形', value => floors(1)(value) && rectangular(value)], ['双坡顶', roof('gable')], ['北侧入户', entrance('N')], ['全楼无窗', noWindows()]] },
  { id: 'T05', title: '单层日式围院民宿', prompt: '一座单层日式民宿，四面房屋围出封闭的露天内院，西侧开入户门，四坡屋顶。',
    desired: { literal: '单层围合露天内院，西侧入口，四坡屋顶', subject: '院落式民宿', style: '日式建筑' },
    checks: [['日式', style('japanese')], ['单层', floors(1)], ['围合内院', isCourtyard], ['西侧入户', entrance('W')], ['四坡顶', roof('hip')]] },
  { id: 'L01', prompt: '用游戏建筑预制件还原北京故宫太和殿主体。',
    reference: '宽阔的中式宫殿，横向殿身，居中轴对称，有高台基、重檐四坡大屋顶和对称重复的门窗。评判体块和台基轮廓，不扣缺少单独汉白玉材质或屋脊走兽。',
    checks: [['中式', style('chinese')], ['宽横向殿身', wide], ['台基', hasPlinth], ['中轴对称', symmetric], ['四坡主顶', roof('hip')]] },
  { id: 'L02', prompt: '用游戏建筑预制件还原日本姬路城大天守主体。',
    reference: '高耸的多层日式天守阁，逐层收窄，白色墙体，层层深色坡屋面与外挑檐，具有城堡塔楼的轮廓。可按外观层次近似。',
    checks: [['日式', style('japanese')], ['至少三层', ({ spec }) => spec.floors.length >= 3], ['向上收分', narrows], ['坡顶', ({ spec }) => spec.roof.type !== 'flat'], ['下层腰檐', ({ result }) => result.placements.some(p => p.cat === 'eave')]] },
  { id: 'L03', prompt: '用游戏建筑预制件还原英国白金汉宫东立面主体。',
    reference: '横向展开的浅色欧式宫殿立面，严格中轴对称，多排重复排列的偏竖窗，中央入口更突出。中央阳台和山花可用现有构件近似，按能表达的中央识别性计分。',
    checks: [['欧式', style('european')], ['横向展开', wide], ['中轴对称', symmetric], ['居中入口', centralDoor], ['重复偏竖窗', verticalWindows]] },
  { id: 'L04', prompt: '用游戏建筑预制件还原印度阿格拉泰姬陵的主陵。',
    reference: '近方形的浅色主陵立于高台基上，轴线对称，中央入口突出，屋顶中心体量高起。现有屋顶只能近似中央穹顶，屋顶按居中和高起的轮廓给分。标志特征看台基、中央体量及立面中轴，免评穹顶曲面、独立宣礼塔与雕刻。',
    checks: [['近方形占地', nearSquare], ['中轴对称', symmetric], ['台基', hasPlinth], ['居中入口', centralDoor], ['居中收分的上层', centeredUpperVolume]] },
  { id: 'L05', prompt: '用游戏建筑预制件还原法国巴黎凯旋门主体。',
    reference: '深度较浅的浅色矩形门楼，正面由厚重两墩和居中的大开口构成，顶部水平，主立面有鲜明中轴。现有门组件可近似中央大开口，标志特征按开口位置和两侧体量组合给分。免评半圆拱券、侧向贯通、雕塑浮雕和原建筑绝对尺寸。',
    checks: [['矩形占地', rectangular], ['宽门楼', wide], ['中轴对称', symmetric], ['平顶', roof('flat')], ['居中宽门洞近似', compiled => centralDoor(compiled, 2.5)]] },
];

const imagePrompt = '用游戏建筑预制件还原参考图中的主体建筑。保留可见的轮廓、体块、屋顶和主要开口。';
const imageCases = [
  { id: 'M01', title: '白宫柱廊立面', image: 'baigong.jpg', elevation: 0, core: ['facade', 0],
    visual: { silhouette: ['整体宽而低', '两翼大小接近'], massing: ['门廊突出于两翼', '低平翼部与中央三角山花'], facade: ['居中立柱门廊', '两翼各有两排规则竖窗'] } },
  { id: 'M02', title: '比萨斜塔插画', image: 'bisaxieta.jpg', elevation: 8, core: ['facade', 0],
    visual: { silhouette: ['高而窄的塔形', '顶部较窄'], massing: ['多道重复的外挑层线', '独立收顶体块'], facade: ['多层成排的重复开口', '底层开口显著高于上层'] },
    excluded: '插画的五官、手臂、对话框、精确倾角和圆柱曲面' },
  { id: 'M03', title: '黄鹤楼', image: 'Huanghelou.jpg', elevation: -12, core: ['massing', 0],
    visual: { silhouette: ['主体高耸', '上部较底部收窄'], massing: ['多道清楚可辨的外挑檐', '顶层起翘坡顶'], facade: ['柱子分出重复开间', '中上部有栏杆或廊台'] } },
  { id: 'M04', title: '泰姬陵主陵', image: 'India.jpg', elevation: -6, core: ['massing', 0],
    visual: { silhouette: ['左右对称', '主陵高出两翼'], massing: ['居中高起的顶体量', '两侧各有较低顶体量'], facade: ['中央大开口高于两侧', '两翼可见上下两排开口'] },
    excluded: '穹顶曲面和独立宣礼塔，允许用高起体块近似穹顶' },
  { id: 'M05', title: '巴黎凯旋门', image: 'kaixuan.jpg', elevation: 0, core: ['facade', 0],
    visual: { silhouette: ['宽高接近', '左右两墩对称'], massing: ['厚实墩体托住连续横梁', '顶部水平连续'], facade: ['开口居中，宽度与两墩的比例接近原图', '开口明显高于宽'] },
    excluded: '拱券曲面、贯通性与浮雕，允许用宽门近似' },
];
caseDefinitions.push(...imageCases.map(task => ({ ...task, prompt: imagePrompt, checks: [] })));

const configurationPath = join(root, 'configuration.json');
const frozenConfiguration = await readJson(configurationPath);
const tasks = frozenConfiguration ? frozenConfiguration.tasks.map(({ checks, ...saved }) => {
  const definition = caseDefinitions.find(task => task.id === saved.id);
  if (!definition || JSON.stringify(definition.checks.map(([name]) => name)) !== JSON.stringify(checks)) {
    throw new Error(`Frozen benchmark case does not match its checks: ${saved.id}`);
  }
  return { ...definition, ...saved };
}) : caseDefinitions;

const recordsPath = (task, model) => join(root, task.id, model, 'generation.json');
const referencePath = task => join(root, task.id, 'reference.jpg');
const imagePart = (bytes, format) => ({ type: 'image_url', image_url: { url: `data:image/${format};base64,${bytes.toString('base64')}` } });

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

async function mapLimit(items, limit, run) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await run(queue.shift());
  }));
}

function formatScore(raw, parsed) {
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return 4;
  } catch { /* The application accepts some non-strict JSON. */ }
  return parsed.ok ? 2 : 0;
}

function usable(compiled) {
  return compiled?.partialOk && compiled.result?.placements.length > 0
    && compiled.result.placements.every(p => p.pos.every(Number.isFinite) && Number.isFinite(p.rot));
}

async function generateOne(task, model, effort, retryTransport = false) {
  const file = recordsPath(task, model);
  const previous = await readJson(file);
  const transient = [429, 500, 502, 503, 504].includes(previous?.callError?.status)
    || ['TimeoutError', 'TypeError'].includes(previous?.callError?.code);
  if (previous && (!retryTransport || !transient || previous.selectedRound || previous.transportRetry)) return;
  if (retryTransport && !previous) return;
  const directory = join(root, task.id, model);
  await mkdir(directory, { recursive: true });
  const start = Date.now();
  const record = { task: task.id, model, effort, rounds: [], status: '失败', checks: [] };
  if (previous) record.transportRetry = { callError: previous.callError, rounds: previous.rounds, durationMs: previous.durationMs };
  const reference = task.image ? imagePart(await readFile(referencePath(task)), 'jpeg').image_url.url : undefined;
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserContent(task.prompt, reference) }];
  let best = null;
  for (let round = 1; round <= 3; round++) {
    console.log(`${task.id} ${model} round ${round} started`);
    const started = Date.now();
    let payload;
    try {
      const response = await fetch(`${url}/api/llm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(310000), body: JSON.stringify({ model, messages, effort }),
      });
      payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        record.callError = { status: response.status, code: String(payload.error?.code || `HTTP_${response.status}`).slice(0, 80) };
        record.rounds.push({ round, durationMs: Date.now() - started, callError: record.callError });
        break;
      }
    } catch (error) {
      record.callError = { code: error.name };
      record.rounds.push({ round, durationMs: Date.now() - started, callError: record.callError });
      break;
    }
    const raw = payload.choices?.[0]?.message?.content ?? '';
    const parsed = extractJSON(raw);
    const compiled = parsed.ok ? compile(parsed.value) : null;
    const errors = compiled?.errors ?? [{ code: 'E_JSON', msg: parsed.error, hard: true }];
    const format = formatScore(raw, parsed);
    record.rounds.push({ round, durationMs: Date.now() - started, format, errors, warnings: compiled?.warnings ?? [], usage: payload.usage ?? null, raw });
    if (usable(compiled) && (!best || errors.length < best.compiled.errors.length)) best = { round, raw: parsed.value, compiled };
    if (usable(compiled) && compiled.ok) break;
    if (round < 3) messages.push({ role: 'assistant', content: raw }, { role: 'user', content: buildRepairMessage(errors) });
  }
  record.durationMs = Date.now() - start;
  record.scores = { rules: record.rounds[0]?.format ?? 0 };
  if (best) {
    const { compiled, raw, round } = best;
    record.selectedRound = round;
    record.errors = compiled.errors;
    record.warnings = compiled.warnings;
    record.stats = compiled.result.stats;
    record.checks = task.checks.map(([name, check]) => ({ name, hit: Boolean(check(compiled)) }));
    record.status = task.image ? '待评分' : compiled.ok && record.checks.every(check => check.hit) ? '成功' : '部分完成';
    const softCount = new Set(compiled.errors.map(error => error.code)).size;
    record.scores.rules += 12 + Math.max(0, 8 - 2 * softCount - new Set(compiled.warnings).size) + (compiled.ok ? 8 - round * 2 : 0);
    await saveJson(join(directory, 'design_spec.json'), raw);
    await saveJson(join(directory, 'placements.json'), { grid: 0.5, units: 'meter', style: compiled.spec.style, placements: compiled.result.placements });
  }
  await saveJson(file, record);
  console.log(`${task.id} ${model} ${record.status} ${record.rounds.length} rounds ${Math.round(record.durationMs / 1000)}s ${record.callError?.code ?? ''}`);
}

async function generateAll(retryTransport = false) {
  const config = await fetch(`${url}/api/config`).then(response => response.json());
  const expected = { hy4: 'no_think', 'hy4-flash': 'no_think', 'deepseek-flash': 'low', 'gpt-6.2-astra': 'high', 'gpt-6.2-sol': 'high' };
  for (const [id, effort] of Object.entries(expected)) {
    const model = config.models.find(item => item.id === id);
    if (!model?.configured || model.effort !== effort || (tasks.some(task => task.image) && !model.supportsImages)) {
      throw new Error(`Incorrect live model configuration for ${id}`);
    }
  }
  await mkdir(root, { recursive: true });
  if (!frozenConfiguration) {
    const frozenTasks = await Promise.all(tasks.map(async ({ checks, ...task }) => {
      if (task.image) {
        const bytes = await readFile(join('Image-Test', 'normalized', task.image));
        await mkdir(join(root, task.id), { recursive: true });
        await writeFile(referencePath(task), bytes);
        task.imageSha256 = digest(bytes);
      }
      return { ...task, checks: checks.map(([name]) => name) };
    }));
    await saveJson(configurationPath, { models: expected, maxRounds: 3, overallWeights: { text: 0.5, image: 0.5 }, tasks: frozenTasks });
  } else {
    for (const task of tasks.filter(item => item.image)) {
      if (digest(await readFile(referencePath(task))) !== task.imageSha256) throw new Error(`Changed reference image for ${task.id}`);
    }
  }
  await Promise.all(Object.keys(models).map(model => mapLimit(tasks, 2, task => generateOne(task, model, expected[model], retryTransport))));
}

async function openBenchmarkBrowser() {
  const require = createRequire(new URL('../.e2e/package.json', import.meta.url));
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({
    executablePath: process.env.AGENT_BENCHMARK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-proxy-server'],
    defaultViewport: { width: 1100, height: 650 },
  });
}

async function initializeScene(page) {
  await page.goto(`${url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__houseGen?.getResult(), { timeout: 20000 });
}

async function snapshotsFor(page, raw, views) {
  const normalized = JSON.stringify(compile(raw).spec);
  const data = await page.evaluate((spec, expected, views) => {
    document.getElementById('specEditor').value = JSON.stringify(spec);
    document.getElementById('resolve').click();
    if (JSON.stringify(window.__houseGen.getSpec()) !== expected) throw new Error('Renderer returned a different design');
    return views.map(view => window.__houseGen.snapshot(view));
  }, raw, normalized, views);
  return data.map(snapshot => Buffer.from(snapshot.split(',')[1], 'base64'));
}

const primaryViews = task => [task.image ? { elevation: task.elevation } : 'front', 'oblique'];

async function renderAll() {
  const browser = await openBenchmarkBrowser();
  try {
    const page = await browser.newPage();
    await initializeScene(page);
    for (const task of tasks) {
      for (const model of Object.keys(models)) {
        const generation = await readJson(recordsPath(task, model));
        if (!generation?.selectedRound) continue;
        const directory = join(root, task.id, model);
        if (await readJson(join(directory, 'render.json'))) continue;
        const raw = await readJson(join(directory, 'design_spec.json'));
        const snapshots = await snapshotsFor(page, raw, primaryViews(task));
        for (const [index, name] of ['front', 'oblique'].entries()) {
          await writeFile(join(directory, `${name}.png`), snapshots[index]);
        }
        await saveJson(join(directory, 'render.json'), { views: ['front.png', 'oblique.png'], elevation: task.elevation });
        console.log(`${task.id} ${model} rendered`);
      }
    }
  } finally {
    await browser.close();
  }
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function identicalGroups(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!row[key]) continue;
    const group = groups.get(row[key]) ?? [];
    group.push(row.model);
    groups.set(row[key], group);
  }
  return [...groups.values()].filter(group => group.length > 1);
}

async function verifyImages() {
  const browser = await openBenchmarkBrowser();
  const records = [];
  try {
    const work = tasks.flatMap(task => Object.keys(models).map(model => ({ task, model })));
    await mapLimit(work, 2, async ({ task, model }) => {
      const generation = await readJson(recordsPath(task, model));
      if (!generation?.selectedRound) return;
      const directory = join(root, task.id, model);
      const raw = await readJson(join(directory, 'design_spec.json'));
      const { placements } = await readJson(join(directory, 'placements.json'));
      const page = await browser.newPage();
      try {
        await initializeScene(page);
        const views = primaryViews(task);
        if (task.id === 'T04') views.push('rear');
        const [front, oblique, rear] = await snapshotsFor(page, raw, views);
        const originalFront = await readFile(join(directory, 'front.png'));
        const originalOblique = await readFile(join(directory, 'oblique.png'));
        if (rear) await writeFile(join(directory, 'rear.png'), rear);
        records.push({ task: task.id, model, front: digest(front), oblique: digest(oblique), rear: rear ? digest(rear) : null,
          placements: digest(JSON.stringify(placements.map(item => JSON.stringify(item)).sort())),
          frontMatchesOriginal: front.equals(originalFront), obliqueMatchesOriginal: oblique.equals(originalOblique) });
        console.log(`${task.id} ${model} independent render ${front.equals(originalFront) && oblique.equals(originalOblique) ? 'matched' : 'different'}`);
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
  records.sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model));
  const byTask = tasks.map(task => {
    const rows = records.filter(row => row.task === task.id);
    return { task: task.id, obliqueDuplicates: identicalGroups(rows, 'oblique'), rearDuplicates: identicalGroups(rows, 'rear'),
      placementDuplicates: identicalGroups(rows, 'placements') };
  });
  const identicalRenders = records.filter(row => row.frontMatchesOriginal && row.obliqueMatchesOriginal).length;
  await saveJson(join(root, 'image-verification.json'), { independentRenders: records.length, identicalRenders, byTask, records });
}

const judgeProgram = `
import json, sys
from codex_bridge import CodexError, complete_with_codex
try:
    result = complete_with_codex('gpt-6.2-sol', json.load(sys.stdin), 'high', instructions=(
        '你是建筑视觉评测员。根据 system 消息里的评分规则看图，附图顺序与文字标记相同。'
        '按指定结构返回一个 JSON 对象。不要猜测作品来源，不要运行工具。\\n'
    ))
    print(json.dumps(result, ensure_ascii=True))
except CodexError as error:
    print(json.dumps({'error': error.code}))
`;

async function callJudge(messages) {
  const [binary, ...args] = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
  return new Promise((resolveResult, reject) => {
    const child = execFile(binary, [...args, '-X', 'utf8', '-B', '-c', judgeProgram], {
      encoding: 'utf8', windowsHide: true, timeout: 310000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error(`Sol bridge exited (${error.code})`));
      try {
        const payload = JSON.parse(stdout);
        if (payload.error) throw new Error(payload.error);
        const raw = payload.choices?.[0]?.message?.content ?? '';
        const parsed = extractJSON(raw);
        if (!parsed.ok || !Array.isArray(parsed.value?.candidates)) throw new Error('Sol did not return a candidate list');
        resolveResult({ raw, items: parsed.value.candidates, usage: payload.usage });
      } catch (problem) {
        reject(problem);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(messages));
  });
}

function validateRating(item, task) {
  if (task.image) {
    return Object.keys(imageWeights).every(key => {
      const checks = item.photo?.[key];
      return Array.isArray(checks) && checks.length === 2 && checks.every(check =>
        Number.isInteger(check?.score) && check.score >= 0 && check.score <= 2 && typeof check.reason === 'string' && check.reason.trim());
    });
  }
  const values = task.reference ? item.landmark : item.beauty;
  const keys = task.reference ? landmarkKeys : beautyKeys;
  const [min, max] = task.reference ? [0, 2] : [1, 5];
  return keys.every(key => Number.isInteger(values?.[key]) && values[key] >= min && values[key] <= max)
    && (task.reference || item.seen && typeof item.seen === 'object');
}

async function judgeGroup(task, entries) {
  if (task.image) {
    const template = Object.fromEntries(Object.keys(imageWeights).map(key => [key, [0, 1].map(() => ({ score: 0, reason: '图中依据' }))]));
    const system = [
      '第一张是参考图。之后每个匿名候选依次给主视图和斜俯视图，按各自与参考图的匹配程度独立评分。',
      '主视图用于比对轮廓、比例和可见构件，斜俯视用于核对空间关系。忽略留白、背景、人物、光照、材质差异和原图遮挡或未展示的部分。',
      task.excluded ? `本题表达边界为${task.excluded}。` : '',
      `检查点按字段中的顺序评分。${JSON.stringify(task.visual)}`,
      '每个检查点给 0（缺失或不符合）、1（可辨但有偏差）或 2（匹配），每项说明具体画面依据。',
      `只输出结构为 ${JSON.stringify({ candidates: [{ id: 'A', photo: template }] })} 的 JSON，包含所有候选。`,
    ].join('\n');
    const content = [{ type: 'text', text: '本题参考图。' }, imagePart(await readFile(referencePath(task)), 'jpeg')];
    for (const { id, model } of entries) {
      content.push({ type: 'text', text: `候选 ${id}。先主视图，后斜俯视。` });
      for (const view of ['front', 'oblique']) {
        content.push(imagePart(await readFile(join(root, task.id, model, `${view}.png`)), 'png'));
      }
    }
    return callJudge([{ role: 'system', content: system }, { role: 'user', content }]);
  }
  const system = task.reference
    ? `按参照评估每个匿名建筑。参照：${task.reference}。以下 5 项各给整数 0–2 分：silhouette（轮廓）、massing（体量关系）、roof（屋顶）、facade（立面）、signature（可表达的标志特征）。0 缺失或不符、1 可辨认、2 匹配。输出 {"candidates":[{"id":"A","landmark":{"silhouette":0,"massing":0,"roof":0,"facade":0,"signature":0},"reason":"简短可核对的理由"}]}。`
    : '识别并横向比较同题的匿名建筑。只依据截图。seen 含 literal（层数、体块、屋顶、门窗、露台等可见特征）, subject（类型）, usage（可推断用途）, style（风格）, scene（场景），每项用不超过45字的中文短语，无法判断用空字符串。坐标约定正面相机看向北，近处正面为南，画面右侧为东。另按可见美感给 proportion（体块比例）, facade_rhythm（立面开口节奏）, roof_harmony（屋顶与主体协调）, style_coherence（风格一致性）各整数1–5分，1明显失衡、3关系清楚、5组织协调。输出 {"candidates":[{"id":"A","seen":{"literal":"","subject":"","usage":"","style":"","scene":""},"beauty":{"proportion":3,"facade_rhythm":3,"roof_harmony":3,"style_coherence":3},"reason":"一句可核对的理由"}]}。';
  const content = [];
  for (const { id, model } of entries) {
    content.push({ type: 'text', text: `候选 ${id}：接下来依次是正面、斜俯视。` });
    for (const view of ['front', 'oblique']) {
      const bytes = await readFile(join(root, task.id, model, `${view}.png`));
      content.push(imagePart(bytes, 'png'));
    }
  }
  return callJudge([{ role: 'system', content: system }, { role: 'user', content }]);
}

async function judgeAll() {
  await mapLimit(tasks, 2, async task => {
    const order = Object.keys(models);
    const shift = tasks.indexOf(task) % order.length;
    const rotated = [...order.slice(shift), ...order.slice(0, shift)];
    if (shift % 2) rotated.reverse();
    const entries = [];
    for (const model of rotated) {
      const directory = join(root, task.id, model);
      if (await readJson(join(directory, 'render.json')) && !await readJson(join(directory, 'judge.json'))) {
        entries.push({ id: String.fromCharCode(65 + entries.length), model });
      }
    }
    if (!entries.length) return;

    let batch;
    console.log(`${task.id} Sol judging ${entries.length} candidates`);
    try {
      batch = await judgeGroup(task, entries);
      await saveJson(join(root, task.id, 'judge-batch.json'), { order: entries, ...batch });
    } catch (error) {
      console.log(`${task.id} batch judge: ${error.message}`);
    }

    for (const entry of entries) {
      try {
        let item = batch?.items.find(candidate => candidate.id === entry.id);
        if (!item || !validateRating(item, task)) {
          const individual = await judgeGroup(task, [entry]);
          item = individual.items.find(candidate => candidate.id === entry.id);
          if (!item || !validateRating(item, task)) throw new Error('Invalid individual judging result');
          await saveJson(join(root, task.id, entry.model, 'judge-individual.json'), individual);
        }
        await saveJson(join(root, task.id, entry.model, 'judge.json'), item);
        console.log(`${task.id} ${entry.model} judged`);
      } catch (error) {
        console.log(`${task.id} ${entry.model} judge pending: ${error.message}`);
      }
    }
  });
}

function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    aa += a[index] ** 2;
    bb += b[index] ** 2;
  }
  if (a.length !== b.length || !aa || !bb) throw new Error('Incompatible embedding vectors');
  return Math.min(1, Math.max(0, dot / Math.sqrt(aa * bb)));
}

function createEmbedder(settings) {
  const cache = new Map();
  let vectorLength;
  return text => {
    if (!cache.has(text)) {
      cache.set(text, (async () => {
        const response = await fetch(settings.url, {
          method: 'POST', headers: { Authorization: `Bearer ${settings.api_key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          signal: AbortSignal.timeout(15000), body: JSON.stringify({ model: settings.model, input: text }),
        });
        if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
        const vector = (await response.json()).data?.[0]?.embedding;
        if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw new Error('Missing embedding vector');
        vectorLength ??= vector.length;
        if (vector.length !== vectorLength) throw new Error('Embedding service returned inconsistent vector dimensions');
        return vector;
      })().catch(error => { cache.delete(text); throw error; }));
    }
    return cache.get(text);
  };
}

function seenText(judge, key) {
  const value = judge.seen[key];
  const text = typeof value === 'string' ? value.trim() : '';
  return !text || /^(未知|无法判断|无法识别|未体现|unseen)$/i.test(text) ? null : text;
}

async function scoreFit(task, judge, matchedFraction, embed) {
  const fitChecks = 10 * matchedFraction;
  const similarities = {};
  let weight = 0;
  let weighted = 0;
  for (const [key, expected] of Object.entries(task.desired)) {
    const seen = seenText(judge, key);
    const similarity = seen ? cosine(await embed(expected), await embed(seen)) : 0;
    similarities[key] = similarity;
    weighted += dimensions[key] * similarity;
    weight += dimensions[key];
  }
  const fitEmbedding = 15 * weighted / weight;
  return { similarities, fitChecks, fitEmbedding, fit: fitChecks + fitEmbedding };
}

async function rescoreOriginal() {
  const { embedding } = await readJson('config.json');
  const embed = createEmbedder(embedding);
  const probe = await embed(tasks[0].desired.literal);
  const local = await readJson(join(root, 'embedding.json'));
  const cases = tasks.filter(task => task.desired).flatMap(task => Object.keys(models).map(model => ({ task, model })));
  const completed = [];
  await mapLimit(cases, 3, async ({ task, model }) => {
    const directory = join(root, task.id, model);
    const [generation, judge, previous] = await Promise.all([
      readJson(recordsPath(task, model)), readJson(join(directory, 'judge.json')), readJson(join(directory, 'score.json')),
    ]);
    if (!generation || !Number.isFinite(previous?.fit)) throw new Error(`Missing score for ${task.id} ${model}`);
    const score = { ...previous };
    if (generation.selectedRound) {
      if (!judge) throw new Error(`Missing original judge for ${task.id} ${model}`);
      const fraction = generation.checks.filter(check => check.hit).length / generation.checks.length;
      Object.assign(score, await scoreFit(task, judge, fraction, embed));
    }
    completed.push({ directory, score, task: task.id, model, previousFit: previous.fit });
    console.log(`${task.id} ${model} original embedding ${previous.fit.toFixed(2)} → ${score.fit.toFixed(2)}`);
  });
  if (completed.length !== cases.length) throw new Error('Incomplete original embedding results');
  const previousRescore = await readJson(join(root, 'embedding-rescore.json'));
  const baseline = previousRescore?.baseline ?? (await readJson(join(root, 'summary.json')))?.map(item => ({ model: item.model, total: item.total, fit: item.components[1] })) ?? [];
  for (const { directory, score } of completed) await saveJson(join(directory, 'score-original.json'), score);
  await saveJson(join(root, 'embedding-rescore.json'), {
    model: embedding.model, host: new URL(embedding.url).hostname, dimensions: probe.length,
    previousModel: local?.model ?? null, cases: completed.length,
    comparisons: completed.map(({ task, model, previousFit, score }) => ({ task, model, previousFit, originalFit: score.fit })),
    baseline,
  });
}

async function localEmbedder() {
  const descriptors = new Set();
  for (const task of tasks.filter(item => item.desired)) {
    for (const model of Object.keys(models)) {
      const judge = await readJson(join(root, task.id, model, 'judge.json'));
      if (!judge) continue;
      for (const [key, expected] of Object.entries(task.desired)) {
        const seen = seenText(judge, key);
        if (seen) { descriptors.add(expected); descriptors.add(seen); }
      }
    }
  }
  const [binary, ...args] = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
  const encoded = await new Promise((done, fail) => {
    const child = execFile(binary, [...args, '-X', 'utf8', '-B', 'scripts/benchmark-embeddings.py'], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 12 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return fail(error);
      try { done(JSON.parse(stdout)); } catch (problem) { fail(problem); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify([...descriptors]));
  });
  const metadata = await readJson('.e2e/benchmark-model/model.json');
  await saveJson(join(root, 'embedding.json'), { model: 'BAAI/bge-small-zh-v1.5', backend: 'ONNX CPU with quantized weights', pooling: 'CLS', ...metadata });
  return async text => {
    if (!encoded[text]) throw new Error('Missing local vector');
    return encoded[text];
  };
}

function scorePhoto(task, generation, judge) {
  const photoDimensions = Object.fromEntries(Object.entries(imageWeights).map(([key, max]) => [key,
    (judge?.photo[key].reduce((sum, check) => sum + check.score, 0) ?? 0) * max / 4,
  ]));
  const photo = Object.values(photoDimensions).reduce((sum, value) => sum + value, 0);
  const [coreKey, coreIndex] = task.core;
  const matches = judge?.photo[coreKey][coreIndex].score === 2
    && Object.entries(imageWeights).every(([key, max]) => photoDimensions[key] >= max / 2);
  const status = generation.selectedRound ? (generation.errors.length === 0 && matches ? '成功' : '部分完成') : '失败';
  return { rules: generation.scores.rules, photoDimensions, photo, imageTotal: generation.scores.rules + photo, status };
}

async function scoreAll() {
  const config = await readJson('config.json');
  const useLocal = process.env.AGENT_BENCHMARK_EMBEDDINGS === 'local';
  const embeddingFile = join(root, 'embedding.json');
  const previous = await readJson(embeddingFile);
  const previousUsedLocal = previous && previous.backend !== 'api';
  if (previous && previousUsedLocal !== useLocal) throw new Error('Use the same embedding backend when resuming a run');
  const embed = useLocal ? await localEmbedder() : createEmbedder(config.embedding);
  if (!useLocal) {
    const vector = await embed(tasks[0].desired.literal);
    const metadata = { backend: 'api', model: config.embedding.model, host: new URL(config.embedding.url).hostname, dimensions: vector.length };
    if (previous && (previous.model !== metadata.model || previous.dimensions !== metadata.dimensions || previous.host !== metadata.host)) {
      throw new Error('Embedding service differs from the original configuration for this run');
    }
    await saveJson(embeddingFile, metadata);
  }
  const cases = tasks.flatMap(task => Object.keys(models).map(model => ({ task, model })));
  await mapLimit(cases, 3, async ({ task, model }) => {
    const generation = await readJson(recordsPath(task, model));
    if (!generation) return;
    const directory = join(root, task.id, model);
    if (await readJson(join(directory, 'score.json'))) return;
    const judge = generation.selectedRound ? await readJson(join(directory, 'judge.json')) : null;
    if (generation.selectedRound && !judge) return;
    if (task.image) {
      await saveJson(join(directory, 'score.json'), scorePhoto(task, generation, judge));
      return;
    }
    const record = { rules: generation.scores.rules, fit: task.reference ? null : 0, beauty: task.reference ? null : 0, landmark: task.reference ? 0 : null };
    if (generation.selectedRound) {
      const fraction = generation.checks.filter(check => check.hit).length / generation.checks.length;
      if (task.reference) {
        record.landmarkChecklist = 15 * fraction;
        record.landmarkVisual = landmarkKeys.reduce((sum, key) => sum + judge.landmark[key], 0);
        record.landmark = record.landmarkChecklist + record.landmarkVisual;
      } else {
        record.beauty = beautyKeys.reduce((sum, key) => sum + judge.beauty[key], 0);
        try {
          Object.assign(record, await scoreFit(task, judge, fraction, embed));
        } catch (error) {
          console.log(`${task.id} ${model} embedding pending: ${error.cause?.code || error.message}`);
          return;
        }
      }
    }
    await saveJson(join(directory, 'score.json'), record);
  });
  const missing = [];
  for (const { task, model } of cases) {
    if (!await readJson(join(root, task.id, model, 'score.json'))) missing.push(`${task.id}/${model}`);
  }
  if (missing.length) throw new Error(`Missing scores for ${missing.join(', ')}`);
}

const markdownPath = path => relative(root, path).replaceAll('\\', '/');
const points = value => value == null ? '待评分' : value.toFixed(2);
const average = values => values.length && values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const markdownCell = value => String(value ?? '').replace(/\s+/g, ' ').replaceAll('|', '\\|');

async function report() {
  const originalEmbedding = await readJson(join(root, 'embedding-rescore.json'));
  const includesImages = tasks.some(task => task.image);
  const weights = frozenConfiguration?.overallWeights ?? { text: 0.5, image: 0.5 };
  const galleryIds = ['T01', 'M03'];
  const summaries = [];
  const details = [];
  const examples = [];
  for (const [model, label] of Object.entries(models)) {
    const entries = [];
    for (const task of tasks) {
      const directory = join(root, task.id, model);
      const scoreFile = originalEmbedding && task.desired ? 'score-original.json' : 'score.json';
      const [generation, score, render, judge] = await Promise.all([
        readJson(recordsPath(task, model)), readJson(join(directory, scoreFile)),
        readJson(join(directory, 'render.json')), readJson(join(directory, 'judge.json')),
      ]);
      if (scoreFile === 'score-original.json' && !score) throw new Error(`Missing original embedding score for ${task.id}, ${model}`);
      entries.push({ task, directory, generation, score, render, judge, scoreFile });
    }
    const counts = Object.fromEntries(['成功', '部分完成', '失败'].map(status => [status, entries.filter(entry => (entry.score?.status ?? entry.generation?.status) === status).length]));
    const ordinary = entries.filter(entry => entry.task.desired);
    const landmarks = entries.filter(entry => entry.task.reference);
    const images = entries.filter(entry => entry.task.image);
    const components = [average(ordinary.map(entry => entry.generation?.scores.rules)), average(ordinary.map(entry => entry.score?.fit)),
      average(ordinary.map(entry => entry.score?.beauty)), average(landmarks.map(entry => entry.score?.landmark))];
    const textTotal = components.every(Number.isFinite) ? components.reduce((sum, score) => sum + score, 0) : null;
    const imageTotal = average(images.map(entry => entry.score?.imageTotal));
    const imageComponents = [average(images.map(entry => entry.score?.rules)),
      ...Object.keys(imageWeights).map(key => average(images.map(entry => entry.score?.photoDimensions[key])))];
    const total = includesImages ? (textTotal != null && imageTotal != null ? weights.text * textTotal + weights.image * imageTotal : null) : textTotal;
    const timings = entries.filter(entry => entry.generation?.selectedRound).map(entry => entry.generation.durationMs).sort((a, b) => a - b);
    const middle = Math.floor(timings.length / 2);
    const medianSeconds = !timings.length ? null : (timings.length % 2 ? timings[middle] : (timings[middle - 1] + timings[middle]) / 2) / 1000;
    const firstPass = entries.filter(entry => entry.generation?.rounds[0]?.errors?.length === 0).length;
    summaries.push({ model, label, counts, components, imageComponents, textTotal, imageTotal, total, firstPass, medianSeconds, planned: entries.length });

    for (const id of galleryIds) {
      const example = entries.find(entry => entry.task.id === id && entry.render);
      if (!example) continue;
      const view = example.task.image ? 'front.png' : 'oblique.png';
      const image = markdownPath(join(example.directory, view));
      examples.push({ id, model, image, alt: `${label} 的 ${id} 建筑` });
    }

    const rows = [`#### ${label}`, '', '| 题号 | 状态 | 轮次与耗时 | 具体表现 | 产物 |', '|---|---|---|---|---|'];
    for (const { task, generation, directory, render, score, judge, scoreFile } of entries) {
      if (!generation) {
        rows.push(`| ${task.id} | 待运行 | | | |`);
        continue;
      }
      const descriptions = [];
      if (generation.stats) descriptions.push(`${generation.stats.prefabTotal} 个预制件`);
      if (generation.checks.length) {
        const missing = generation.checks.filter(check => !check.hit).map(check => check.name);
        descriptions.push(`要求命中 ${generation.checks.length - missing.length}/${generation.checks.length}${missing.length ? `，缺少${missing.join('、')}` : ''}`);
      }
      const firstErrors = generation.rounds[0]?.errors ?? [];
      if (firstErrors.length) descriptions.push(`首轮 ${[...new Set(firstErrors.map(error => error.code))].join('、')}`);
      if (generation.errors?.length) descriptions.push(`最终 ${[...new Set(generation.errors.map(error => error.code))].join('、')}`);
      if (generation.warnings?.length) descriptions.push(`${generation.warnings.length} 条自动修正警告`);
      if (generation.callError) descriptions.push(`调用错误 ${generation.callError.code}`);
      if (generation.transportRetry) descriptions.push(`服务错误 ${generation.transportRetry.callError.code} 后统一复试一次`);
      if (score && task.image) {
        const [silhouette, massing, facade] = Object.values(score.photoDimensions);
        descriptions.push(`规则 ${points(score.rules)}/30，轮廓 ${points(silhouette)}/25，体块及屋顶 ${points(massing)}/25，立面 ${points(facade)}/20，合计 ${points(score.imageTotal)}/100`);
        if (judge) {
          const [coreKey, coreIndex] = task.core;
          const core = judge.photo[coreKey][coreIndex];
          descriptions.push(`核心项「${task.visual[coreKey][coreIndex]}」为 ${core.score}/2，${core.reason}`);
        }
      } else if (score) {
        descriptions.push(task.reference ? `地标 ${points(score.landmark)}/25` : `规则 ${points(score.rules)}/30，贴合 ${points(score.fit)}/25，美感 ${points(score.beauty)}/20`);
      }
      if (judge?.reason) descriptions.push(`Sol 观察「${String(judge.reason).slice(0, 102)}」`);
      const files = [['逐轮记录', 'generation.json']];
      if (generation.selectedRound) files.push(['设计', 'design_spec.json'], ['摆放', 'placements.json']);
      if (render) files.push([task.image ? '主视图' : '正面', 'front.png'], ['斜俯', 'oblique.png']);
      if (judge) files.push(['裁判', 'judge.json']);
      if (score) files.push(['分项', scoreFile]);
      const links = files.map(([title, filename]) => `[${title}](${markdownPath(join(directory, filename))})`).join(' · ');
      rows.push(`| ${task.id} | ${score?.status ?? generation.status} | ${generation.rounds.length} 轮 · ${(generation.durationMs / 1000).toFixed(1)} s | ${markdownCell(descriptions.join('。'))} | ${links} |`);
    }
    details.push(rows.join('\n'));
  }

  summaries.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const known = summaries.filter(item => item.total != null).length;
  const scored = summaries.map(row => `| ${row.label} | ${Object.values(row.counts).join('／')} | ${points(row.textTotal)} | ${includesImages ? points(row.imageTotal) : '—'} | **${points(row.total)}** | ${row.firstPass}/${row.planned} | ${row.medianSeconds == null ? '—' : row.medianSeconds.toFixed(1)} s |`);
  const gallery = galleryIds.flatMap(id => {
    const task = tasks.find(item => item.id === id);
    const images = examples.filter(example => example.id === id);
    if (!images.length) return [];
    return [`#### ${id} ${task.title}`, '', task.image ? `[参考图](${markdownPath(referencePath(task))})` : `> ${task.prompt}`, '',
      `| ${Object.values(models).join(' | ')} |`, `| ${Object.keys(models).map(() => '---').join(' | ')} |`,
      `| ${Object.keys(models).map(model => {
        const example = images.find(item => item.model === model);
        return example ? `![${example.alt}](${example.image})` : '无可展示产物';
      }).join(' | ')} |`, ''];
  });
  const embedding = await readJson(join(root, 'embedding.json'));
  const audit = await readJson(join(root, 'T01', 'order-audit.json'));
  const notes = [];
  if (originalEmbedding) {
    notes.push(`原向量接口复测已恢复，使用 ${originalEmbedding.model} 的 ${originalEmbedding.dimensions} 维向量重算了全部 ${originalEmbedding.cases} 个普通题结果。生成产物、Sol 读图和其他评分项沿用原记录。 [复算明细及 BGE 版分数](${markdownPath(join(root, 'embedding-rescore.json'))})`);
  } else if (embedding?.backend === 'api') {
    notes.push(`本轮贴合度通过向量接口使用 ${embedding.model} 的 ${embedding.dimensions} 维向量。 [本轮向量模型记录](${markdownPath(join(root, 'embedding.json'))})`);
  } else if (embedding) {
    notes.push(`本轮贴合分统一使用本地向量模型 ${embedding.model}。 [模型版本和文件校验值](${markdownPath(join(root, 'embedding.json'))})`);
  }
  if (known === summaries.length) {
    const beauty = summaries.reduce((best, item) => item.components[2] > best.components[2] ? item : best);
    notes.push(`前三名总分相差 ${points(summaries[0].total - summaries[2].total)} 分，每题一次的结果适合比较这批产物。${beauty.label} 的美感分最高，为 ${points(beauty.components[2])}/20。`);
  }
  if (audit?.length === 2) {
    const winners = audit.map(trial => models[trial.winner] ?? (trial.winner === 'tie' ? '平局' : trial.winner));
    notes.push(`T01 的截图换序抽检结果依次为 ${winners.join('、')}，表中主分使用统一批次评分。 [抽检记录](${markdownPath(join(root, 'T01', 'order-audit.json'))})`);
  }
  const reportRows = [
    '# UGC 建筑生成 Agent 评测结果', '',
    '### 本轮得分', '',
    `运行批次 ${relative(resolve('agent-benchmark-results'), root)}。 [本轮冻结配置](${markdownPath(join(root, 'configuration.json'))})`, '',
    '分数对应本轮冻结题目和配置。首轮通过指求解器零错误，任务成功还要求达到题目验收线。生成时长包含模型调用、修复和求解，截图另行执行。',
    ...(includesImages ? [`综合分为文字组 ${weights.text * 100}% 加多模态组 ${weights.image * 100}%。`, ''] : ['']),
    '| 模型 | 成功／部分／失败 | 文字 100 | 多模态 100 | 综合 100 | 首轮通过 | 生成中位耗时 |',
    '|---|---|---:|---:|---:|---:|---:|', ...scored, '',
    '| 模型 | 文字规则 30 | 贴合 25 | 美感 20 | 地标 25 | 图片规则 30 | 轮廓 25 | 体块与屋顶 25 | 立面 20 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summaries.map(row => `| ${row.label} | ${[...row.components, ...row.imageComponents].map(points).join(' | ')} |`), '',
    ...notes.flatMap(note => [note, '']),
    ...(known < summaries.length ? ['截图或向量评分仍待补齐的模型暂列已有分项，完整总分待评。', ''] : []),
    '### 同题建筑产物', '', ...gallery,
    '### 逐题任务记录', '', ...details, '',
  ];
  await saveJson(join(root, 'summary.json'), summaries);
  await writeFile(join(root, 'report.md'), reportRows.join('\n'), 'utf8');
  console.log(JSON.stringify(summaries, null, 2));
}

const stage = process.argv[2];
if (stage === 'generate') await generateAll();
if (stage === 'retry-transport') await generateAll(true);
if (stage === 'render') await renderAll();
if (stage === 'verify-images') await verifyImages();
if (stage === 'judge') await judgeAll();
if (stage === 'score') await scoreAll();
if (stage === 'rescore-original') await rescoreOriginal();
if (stage === 'report') await report();
