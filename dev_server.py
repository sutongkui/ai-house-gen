"""本地预览服务：静态托管 house-gen-demo/，并提供 /api/llm 代理与 /api/config 端点。
用法：python dev_server.py  →  http://127.0.0.1:8765/index.html

- /api/llm 的作用：浏览器直连混元/DeepSeek 会被 CORS 拦截，所以由本服务代转发，
  key 只存在后端，不暴露到前端。POST body: {"model": "<id>", "messages": [...]}
- /api/config：向前端返回模型列表（label/effort/supportsImages），不含任何 key。
所有 key 与域名统一从 config.json 读取（该文件已 .gitignore，见 config.example.json 模板）。
"""
import functools
import http.server
import json
import os
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "house-gen-demo")

# —— 从 config.json 读取全部通道配置（key / 域名 / 模型）——
_config_path = os.path.join(BASE, "config.json")
if not os.path.exists(_config_path):
    raise SystemExit(
        "未找到 config.json。\n"
        "请先复制 config.example.json 为 config.json，并填入你的 API key：\n"
        "  cp config.example.json config.json"
    )
with open(_config_path, encoding="utf-8") as f:
    CONFIG = json.load(f)

PROVIDERS = {}   # model_id -> {url, key, model, efforts, default_effort}
MODELS = []      # 前端展示用（不含 key）
for _provider in CONFIG["providers"].values():
    _chat_url = _provider["chat_url"]
    _api_key = _provider["api_key"]
    for _mid, _mc in _provider["models"].items():
        PROVIDERS[_mid] = {
            "url": _chat_url,
            "key": _api_key,
            "model": _mid,
            "efforts": _mc["efforts"],
            "default_effort": _mc["effort"],
        }
        MODELS.append({
            "id": _mid,
            "label": _mc["label"],
            "supportsImages": _mc["supportsImages"],
            "effort": _mc["effort"],
            "efforts": _mc["efforts"],
        })

EFFORT_LABELS = {"no_think": "不思考", "low": "低思考", "high": "高思考", "max": "最强思考"}


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript; charset=utf-8"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/config":
            self._json(200, {"effort_labels": EFFORT_LABELS, "models": MODELS})
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/llm":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            model_id = data.get("model", "")
            messages = data.get("messages", [])
            effort = data.get("effort")
            p = PROVIDERS.get(model_id)
            if not p:
                self._json(400, {"error": {"message": f"未知模型: {model_id}", "code": "unknown_model"}})
                return
            if effort not in p["efforts"]:
                effort = p["default_effort"]
            req_body = json.dumps({
                "model": p["model"],
                "messages": messages,
                "stream": False,
                "reasoning_effort": effort,
            }).encode("utf-8")
            req = urllib.request.Request(
                p["url"],
                data=req_body,
                headers={"Authorization": f"Bearer {p['key']}", "Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    raw = resp.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
            except urllib.error.HTTPError as e:
                raw = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": {"message": f"代理错误: {e}", "code": "proxy_error"}})


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler) as httpd:
        print("serving", ROOT, "at http://127.0.0.1:8765/index.html", flush=True)
        print("LLM 代理: POST /api/llm · 配置: GET /api/config", flush=True)
        httpd.serve_forever()
