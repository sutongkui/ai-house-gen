# AI 一句话生成房屋（ai-house-gen）

一个「一句话 → 3D 建筑」的 UGC 生成 demo。输入一句自然语言（或一张参考图），输出一座可旋转查看的 3D 建筑，以及一份可被游戏引擎直接消费的预制件摆放清单。

**核心设计思想**：把生成式 AI 的「不确定输出」通过**两层解耦 + 确定性求解器 + 校验闭环**收敛成「精确的几何摆放指令」——大模型只做模糊决策（风格、体块、门窗、屋顶参数），墙段切分、转角柱、门窗开洞、楼板、屋顶几何这些精确计算全部交给确定性代码。

## 特性

- **5 种风格**：中式 / 日式 / 现代 / 欧式 / 北欧，各自独立配色与屋顶门窗规则
- **6 种屋顶**：平顶 / 双坡(gable) / 四坡(hip) / 歇山(xieshan) / 攒尖(pyramid)，中式日式支持檐角起翘
- **参考图识别**：照片 / 效果图 / 手绘立面 / 平面图都能读，自动判断风格、层数、体块、门窗
- **约束校验 + 修复闭环**：上层不悬挑、同层连通、入户门落外墙等硬约束，失败自动回传模型重做（最多 N 轮）
- **组件图鉴**：36 种预制件背包式展示，3D 缩略图 + 当前建筑用量角标
- **免后端部署**：纯前端 + 一个本地代理脚本（key 只存在后端，不进前端源码）

## 快速开始

```bash
# 1. 配置模型 key（模板 config.example.json 已提供）
cp config.example.json config.json
# 编辑 config.json，填入你的混元 / DeepSeek / embedding 的 key

# 2. 启动本地服务（静态托管 + LLM 代理）
python dev_server.py

# 3. 打开浏览器
#    http://127.0.0.1:8765/index.html
```

> 模型列表由后端 `/api/config` 下发，网页下拉框显示 `config.json` 中启用 `supportsImages` 的模型。API key 由服务端管理。

Web 下拉框的 **GPT-6.2 Astra** 和 **GPT-6.2 Sol** 通过本机 Codex CLI 生成建筑，使用 ChatGPT 账号的 Codex 额度，两者均可使用参考图。已有配置请从 `config.example.json` 更新 `providers.openai`，然后重启本地服务。页面显示「待登录 Codex」时，确认启动服务的终端可以运行 `codex`，并通过 `codex login` 登录 ChatGPT。每次生成或修复请求会发起一次 Codex 调用。

## 目录结构

```
ai-house-gen/
├── house-gen-demo/        # 前端核心
│   ├── index.html         #   界面骨架
│   ├── app.js             #   UI + 模型调用 + three.js 渲染
│   ├── solver.js          #   核心求解器（参数 → 预制件摆放清单，纯函数）
│   ├── prompt.js          #   系统提示词 + JSON 提取 + 预设示例
│   ├── prefabs.js         #   预制件库 + 配色
│   └── style.css
├── dev_server.py          # 本地服务（静态托管 + /api/llm 代理 + /api/config）
├── config.example.json    # 配置模板（复制为 config.json 并填 key）
├── agent-benchmark.md     # 文字和参考图评测方案
└── README.md
```

## 架构：两层解耦

```
一句话 / 参考图
      ↓
  ┌─────────────────────────┐
  │ 第一层：LLM 设计参数 JSON │  只做比例、体块、风格决策
  │ (style/floors/doors/    │  不含任何坐标级几何
  │  window/roof/columns)   │
  └─────────────────────────┘
      ↓ 校验失败回传重做（闭环）
  ┌─────────────────────────┐
  │ 第二层：确定性求解器      │  墙段切分、转角柱、门窗开洞、
  │ solver.js → placements[]│  楼板、露台栏杆、屋顶几何、台基台阶
  └─────────────────────────┘
      ↓
  three.js 渲染 + 预制件摆放清单（游戏引擎可直接消费）
```

- **LLM 输出**：一份约 15 字段的设计参数 JSON（风格、每层矩形体块、门、开窗规则、屋顶、廊柱）
- **求解器输出**：`placements[]`，每项 `{prefab, floor, pos, rot, params}`，例如 `{"prefab":"door_1.5m","floor":0,"pos":[-2.75,0,2],"rot_deg":0,"params":{"w":1.5,"h":3,"doorH":2.2}}`
- **为什么不让模型直接出坐标**：LLM 是概率采样而非计算器，几百个预制件坐标任何一位出错都会穿模/悬空/重叠；约束（墙对齐、门窗离墙角 ≥1 格、上层不悬挑）是全局耦合的硬约束，语言约束不住。把精确几何交给确定性代码，天然不犯错、可复现、可测试。

## 配置说明

`config.json`（由 `config.example.json` 复制而来）结构：

```jsonc
{
  "providers": {
    "hunyuan": {
      "chat_url": "https://tokenlink.woa.com/openapi/v1/chat/completions",
      "api_key": "你的混元 key",
      "models": { "hy4": { "label": "混元 hy4", "effort": "no_think", ... } }
    },
    "deepseek": { "chat_url": "...", "api_key": "...", "models": { ... } }
  },
  "embedding": { "url": "...", "api_key": "...", "model": "hunyuan-embedding-20250716" }
}
```

- `effort` 为思考档位（混元 `no_think`/`high`，DeepSeek `low`/`high`/`max`），已统一取最快档。
- **安全**：`config.json` 已被 `.gitignore` 忽略，切勿提交到仓库或外发。

## 评测

文字与参考图评测的目标、评分规则和逐题验收标准见 [UGC 建筑生成 Agent 评测](agent-benchmark.md)。

## License

仅供学习交流。
