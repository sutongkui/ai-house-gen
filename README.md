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

在仓库根目录打开 Windows PowerShell。安装 Python 3 后，复制配置模板并启动本地服务。

```powershell
if (-not (Test-Path -LiteralPath 'config.json')) {
    Copy-Item -LiteralPath 'config.example.json' -Destination 'config.json'
}
py -3 dev_server.py
```

保持终端运行，打开 [本地网页](http://127.0.0.1:8765/index.html)。点击「预设示例」即可查看 3D 建筑，也可以在「设计参数」中修改 JSON 后重新求解。演示这两项无需填模型 key。浏览器需能访问 `cdn.jsdelivr.net` 来加载 Three.js。

使用一句话或参考图调用模型时，按下方的配置表启用对应通道。修改 `config.json` 后重启本地服务。

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

接收方用 [配置模板](config.example.json) 创建自己的 `config.json`，从准备使用的通道开始配置。完整四模型评测需要下表四项。

| 用途 | 配置 |
|---|---|
| 混元 HY4、HY4 Flash | 填 `providers.hunyuan.api_key`，并确认可以访问 `providers.hunyuan.chat_url`。 |
| DeepSeek Flash | 填 `providers.deepseek.api_key`，并确认账号可调用模板中的模型。 |
| GPT‑6.2 Astra 生成、GPT‑6.2 Sol 裁判 | 安装 Codex CLI，确保启动服务和跑测的终端都可执行 `codex`。用 `codex login` 登录自己的 ChatGPT 账号，再用 `codex login status` 检查登录。账号需有权调用 Astra 和 Sol。这一通道使用 Codex 额度。 [Codex CLI 安装](https://learn.chatgpt.com/docs/cli) · [登录说明](https://learn.chatgpt.com/docs/auth?surface=cli) |
| 评测的文字贴合度 | 填 `embedding.api_key`，确认可以访问 `embedding.url`。复测使用模板里的 `hunyuan-embedding-20250716`。 |

混元生成和 embedding 默认使用 `woa.com` 内部地址，接收方需要具备相应网络访问和服务权限。暂不启用的 API key 可以填空字符串。分享时发仓库代码和 `config.example.json`，接收方自行填写密钥并登录。`config.json`、`API_KEYS.md` 和 Codex 登录凭据留在本机。

### 单独调用混元 HY4

通过项目网页调用时，把获授权的 TokenLink Key 填入本机 `config.json` 的 `providers.hunyuan.api_key`，启动 `py -3 dev_server.py` 后选择「混元 hy4」。网页把 `model` 和 `messages` 发送给本地 `POST /api/llm`，由服务端加 Bearer 认证转发。

在其他程序里可直接调用 TokenLink 的 Chat Completions 接口。下面的 PowerShell 示例会交互读取 Key，并用一条短消息测试连接。

```powershell
$hy4Credential = Read-Host 'TokenLink HY4 API key' -AsSecureString
$hy4Key = ([System.Net.NetworkCredential]::new('', $hy4Credential)).Password
$hy4Body = @{
    model = 'hy4'
    messages = @(@{ role = 'user'; content = 'Reply with OK only.' })
    stream = $false
    reasoning_effort = 'no_think'
} | ConvertTo-Json -Depth 5

$hy4Result = Invoke-RestMethod -Method Post `
    -Uri 'https://tokenlink.woa.com/openapi/v1/chat/completions' `
    -Headers @{ Authorization = "Bearer $hy4Key" } `
    -ContentType 'application/json; charset=utf-8' -Body $hy4Body
$hy4Result.choices[0].message.content
```

要让 HY4 输出项目可用的建筑设计 JSON，在 `messages` 中加入项目的 `SYSTEM_PROMPT`。参考图随用户消息的 `image_url` 传入。 [生成提示词和消息构造](house-gen-demo/prompt.js)

## 评测

文字与参考图评测的目标、评分规则和逐题验收标准见 [UGC 建筑生成 Agent 评测](agent-benchmark.md)。

### 准备环境

保持本地网页服务运行。在另一个 PowerShell 中进入仓库根目录，准备 **Node.js 24（含 npm）、可运行 `py -3` 的 Python 3、Google Chrome**，并完成上面的四项模型配置。模型 ID、`supportsImages` 和默认思考档沿用模板，评测脚本会在生成前检查。安装截图依赖。

```powershell
New-Item -ItemType Directory -Path '.e2e' -Force | Out-Null
npm.cmd install --prefix .e2e --no-save puppeteer-core@23.11.1
```

Chrome 安装在 `C:\Program Files\Google\Chrome\Application\chrome.exe` 时可直接运行。安装在其他位置时，先将 `$env:AGENT_BENCHMARK_CHROME` 设为本机的 `chrome.exe` 完整路径。五张标准化参考图随仓库放在 `Image-Test/normalized/`。

### 跑一轮并查看分数

```powershell
$env:AGENT_BENCHMARK_RUN = Get-Date -Format 'yyyy-MM-dd-HHmmss'
foreach ($stage in @('generate', 'retry-transport', 'render', 'judge', 'score', 'report')) {
    node scripts/agent-benchmark.mjs $stage
    if ($LASTEXITCODE -ne 0) { throw "评测阶段 $stage 执行失败" }
}
```

脚本让四款模型各跑 10 道文字题和 5 道参考图题，共 60 个任务。六个阶段分别负责生成、复试瞬时服务错误、截图、Sol 盲评、计算分数和写报告。中断或个别评分待补时，设置原来的 `AGENT_BENCHMARK_RUN`，从失败阶段继续，同一批次复用已有产物和评分。

新跑的结果保存在 `agent-benchmark-results/<批次号>/`。`report.md` 包含排名、逐题状态和产物链接，`summary.json` 包含每款模型的分项和总分。这个运行目录由 Git 忽略。评测文档引用的已归档报告和产物在 `docs/benchmark-assets/`，随仓库一起分发。 [四模型逐题报告](docs/benchmark-assets/2026-11-21-four-models/report.md)

## License

仅供学习交流。
