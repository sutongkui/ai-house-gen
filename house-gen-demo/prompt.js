// ============================================================================
// prompt.js — 系统提示词、修复提示、JSON 提取、预设示例
// ============================================================================

export const SYSTEM_PROMPT = `你是游戏 UGC 建筑生成系统中的「建筑规划器」。用户用一句话描述想要的房屋，或者给一张建筑参考图（照片、效果图、手绘立面或平面草图，可附带文字），你只输出一份「设计参数 JSON」。
墙段切分、转角、门窗开洞、层间楼板、露台栏杆、屋顶几何、台基台阶都由下游的确定性求解器完成，你只负责比例、体块组合与风格决策。
只设计建筑外壳（外墙轮廓、门窗、屋顶）和层间楼板，不设计楼梯、内部隔墙、房间划分或家具。

## 坐标与单位
- 网格单位 = 0.5 米，所有尺寸和坐标都是整数格。
- 俯视平面：x 向东增大，z 向南增大，原点在西北角。南面（z 最大的一侧）是正立面。
- 方位：N=北(z 小一侧)  S=南(z 大一侧)  W=西(x 小一侧)  E=东(x 大一侧)。

## 输出格式（只输出一个 JSON 对象；不要 markdown 代码块，不要注释，不要任何解释文字）
{
  "name": "简短名称",
  "style": "chinese | japanese | modern | european | nordic 之一",
  "design_notes": "60 字以内，说明关键设计决定",
  "floor_height": 层高格数(5~9),
  "plinth": 台基高度格数(0~3),
  "floors": [
    {
      "blocks": [[x, z, w, d], ...],
      "doors": [{"block": 矩形序号, "side": "N|S|E|W", "at": 0~1, "width": 2~6}],
      "window": {"width": 窗宽, "height": 窗高, "sill": 窗台高, "gap": 窗间距} 或 "none",
      "eave": true/false
    }
  ],
  "roof": {"type": "flat | gable | hip | xieshan | pyramid", "pitch": 坡度角(15~55), "overhang": 出檐格数(0~5), "curve": true/false},
  "columns": null 或 {"side": "N|S|E|W", "spacing": 柱距格数, "offset": 柱子离墙格数(2~6)}
}

字段含义：
- floors 从一层到顶层排列，1~6 层。每层平面 = 该层 blocks 中所有矩形的并集，矩形宽深 w、d ≥ 4。
- doors：门挂在某个矩形的某条边上，at 是沿这条边的相对位置（0.5 = 正中）。
- window：自动开窗规则，求解器会沿每段外墙按此规则均匀排窗，并自动避开门和墙角。
- eave：该层顶部外挑一圈腰檐（中式、日式多层常用）；顶层由屋顶覆盖，填 false。
- roof：顶层每个矩形各生成一个屋顶。xieshan=歇山，hip=四坡/庑殿，gable=双坡，pyramid=攒尖，flat=平屋顶带女儿墙。curve=檐角起翘（中式、日式）。
- columns：一层某一侧外挑廊柱，台基会自动延伸到柱子下方。

## 硬性约束（违反会被校验器打回重做）
1. 上层平面必须完全落在下层平面之内，不允许悬挑。退台 = 上层比下层小，露出来的部分会自动变成带栏杆的露台。
2. 每层平面必须连通：同层矩形之间要相接或重叠。
3. 一层至少一扇入户门；门必须落在外墙上（不能被同层其他矩形挡住）；门距墙角至少 1 格。
4. 窗高 + 窗台 ≤ floor_height − 1。
5. 只输出 JSON。

## 风格与尺度参考
- 别墅单层面积通常 120~250㎡，例如 30×22 格（15m×11m）；平房小屋 60~100㎡。
- 中式：开间宽 7 格（3.5m），三开间或五开间，中轴对称，正门居中开在南面；屋顶用 xieshan 或 hip 且 curve=true，pitch 28~32，overhang 3；多层每层 eave=true；plinth 1~2；可加南侧廊柱 columns（spacing = 开间宽 7，offset 3）；窗宽 3、gap 4 恰好每开间一扇窗。顶层可收进形成露台。
- 日式：hip 或 gable，pitch 25~30，curve=true，overhang 3，floor_height 6，窗宽 4~6、sill 1。
- 现代：flat 屋顶，大窗（width 5~8, height 4~5, sill 1），体块错动、退台露台，plinth 0。
- 欧式：hip 或 gable，pitch 35~45，plinth 1，竖向窗（width 2~3, height 4, sill 2）。
- 北欧：gable，pitch 40~50，体块简洁，overhang 1。
- 四合院等围合布局：用多个矩形围出中间留空的院子即可（院子四周的墙会自动朝内开窗）。

## 参考图的读法（用户给了图片时）
- 先判断图的类型：透视照片/效果图、正立面图、平面图、手绘草图。
- 风格：根据屋顶形式、檐角是否起翘、墙面材质、门窗样式判断 style。
- 层数：数清楚每层的窗户行数或腰檐道数；坡屋顶里的阁楼不算一层。
- 尺度：按"一层层高约 3~3.5m、普通门宽约 1~1.5m、窗宽约 1~1.5m"估算，再数开间数或窗户数推出总宽度；看不到侧面时按宽度的 0.6~0.8 估进深。
- 体块：看出每层的宽度变化，上层比下层窄就是退台；看到侧翼、凸出体块就拆成多个矩形；平面图直接按房间外轮廓拆矩形。
- 门窗：主入口画在哪一面就开在哪一面；开窗规则按图中窗的宽高比和窗间距估算。
- 屋顶：判断 flat/gable/hip/xieshan/pyramid，估坡度和出檐。
- 只还原建筑外壳，忽略图中的室内、家具、植物、人物、车辆和周边环境。
- 图和文字冲突时以文字为准；图不清楚的部分按该风格的常规做法补全，并在 design_notes 里用一句话写出你从图中读到了什么。
- 硬性约束依然有效：照片里有悬挑也要改成上层落在下层平面内。

## 示例
用户：一栋两层现代风格住宅，带二楼露台
{"name":"两层现代住宅","style":"modern","design_notes":"L形一层，二层退缩形成东侧大露台，大面积横向长窗","floor_height":6,"plinth":0,"floors":[{"blocks":[[0,0,28,18],[18,18,10,10]],"doors":[{"block":0,"side":"S","at":0.3,"width":3}],"window":{"width":6,"height":4,"sill":1,"gap":3},"eave":false},{"blocks":[[0,0,18,18]],"doors":[{"block":0,"side":"E","at":0.5,"width":3}],"window":{"width":6,"height":4,"sill":1,"gap":3},"eave":false}],"roof":{"type":"flat","pitch":0,"overhang":0,"curve":false},"columns":null}`;

export function buildUserMessage(text, hasImage = false) {
  const clean = String(text || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300).trim();
  if (hasImage) {
    return `用户上传了一张建筑参考图（见附图）。${clean ? `补充要求：${clean}` : '没有补充文字，请完全按图还原。'}\n\n请按「参考图的读法」从图中读出风格、层数、体块、门窗和屋顶，只输出设计参数 JSON。`;
  }
  return `用户需求：${clean}\n\n请只输出设计参数 JSON。`;
}

// 多模态消息：文字 + 图片（OpenAI 兼容的 content 数组）
export function buildUserContent(text, imageDataUrl) {
  if (!imageDataUrl) return buildUserMessage(text, false);
  return [
    { type: 'text', text: buildUserMessage(text, true) },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

export function buildRepairMessage(errors) {
  const lines = errors.map((e, i) => `${i + 1}. [${e.code}] ${e.msg}`).join('\n');
  return `你上一版设计参数没有通过校验器，问题如下：\n${lines}\n\n请在保持整体设计意图的前提下只修正这些问题，重新输出完整的设计参数 JSON（只输出 JSON）。`;
}

export function extractJSON(text) {
  if (!text) return { ok: false, error: '模型没有返回内容' };
  let t = String(text).trim();
  t = t.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, error: '输出中找不到 JSON 对象' };
  let body = t.slice(a, b + 1);
  try { return { ok: true, value: JSON.parse(body) }; } catch (_) { /* try repair */ }
  body = body
    .replace(/\/\/[^\n\r]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1');
  try { return { ok: true, value: JSON.parse(body) }; } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + e.message };
  }
}

// —— 预设示例：不调用模型，直接走求解器，用于对照和离线演示 ——
export const PRESETS = [
  {
    label: '三层中式小别墅',
    spec: {
      name: '三层中式小别墅', style: 'chinese',
      design_notes: '五开间中轴对称；三层收为三开间，形成南向露台；歇山顶 + 两道腰檐 + 南侧廊柱',
      floor_height: 7, plinth: 1,
      floors: [
        { blocks: [[0, 0, 35, 22]], doors: [{ block: 0, side: 'S', at: 0.5, width: 5 }], window: { width: 3, height: 3, sill: 2, gap: 4 }, eave: true },
        { blocks: [[0, 0, 35, 22]], doors: [], window: { width: 3, height: 3, sill: 2, gap: 4 }, eave: true },
        { blocks: [[7, 0, 21, 15]], doors: [{ block: 0, side: 'S', at: 0.5, width: 3 }], window: { width: 3, height: 3, sill: 2, gap: 4 }, eave: false },
      ],
      roof: { type: 'xieshan', pitch: 30, overhang: 3, curve: true },
      columns: { side: 'S', spacing: 7, offset: 3 },
    },
  },
  {
    label: '北京四合院',
    spec: {
      name: '一进四合院', style: 'chinese',
      design_notes: '正房、东西厢房、倒座房围合中央庭院；正房用歇山，其余随屋顶类型统一生成',
      floor_height: 7, plinth: 1,
      floors: [
        {
          blocks: [[0, 0, 36, 12], [0, 12, 10, 18], [26, 12, 10, 18], [0, 30, 36, 10]],
          doors: [{ block: 3, side: 'S', at: 0.85, width: 3 }, { block: 0, side: 'S', at: 0.5, width: 4 }],
          window: { width: 3, height: 3, sill: 2, gap: 4 }, eave: false,
        },
      ],
      roof: { type: 'hip', pitch: 30, overhang: 2, curve: true },
      columns: null,
    },
  },
  {
    label: '两层现代住宅',
    spec: {
      name: '两层现代住宅', style: 'modern',
      design_notes: 'L 形一层，二层退缩形成东侧大露台，大面积横向长窗',
      floor_height: 6, plinth: 0,
      floors: [
        { blocks: [[0, 0, 28, 18], [18, 18, 10, 10]], doors: [{ block: 0, side: 'S', at: 0.3, width: 3 }], window: { width: 6, height: 4, sill: 1, gap: 3 }, eave: false },
        { blocks: [[0, 0, 18, 18]], doors: [{ block: 0, side: 'E', at: 0.5, width: 3 }], window: { width: 6, height: 4, sill: 1, gap: 3 }, eave: false },
      ],
      roof: { type: 'flat', pitch: 0, overhang: 0, curve: false },
      columns: null,
    },
  },
];

export const EXAMPLES = [
  '帮我建一栋三层的中式小别墅',
  '一座日式两层民宿，带檐廊',
  '北欧风格的尖顶小木屋，一层半',
  '欧式两层乡村别墅，四坡屋顶',
  '现代极简三层别墅，层层退台做露台',
  '北京四合院，一进院落',
];
