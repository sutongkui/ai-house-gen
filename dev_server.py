"""本地预览服务：静态托管 house-gen-demo/，并提供 /api/llm 代理与 /api/config 端点。
用法：python dev_server.py  →  http://127.0.0.1:8765/index.html

- /api/llm 的作用：由本服务代转发模型请求，
  key 只存在后端，不暴露到前端。POST body: {"model": "<id>", "messages": [...]}
- /api/config：向前端返回模型列表（label/effort/supportsImages），不含任何 key。
通道配置从 config.json 读取（见 config.example.json 模板），API key 也可由通道指定的环境变量提供。
"""
import functools
import http.server
import json
import os
import urllib.request
import urllib.error

from codex_bridge import CodexError, codex_is_logged_in, complete_with_codex

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

PROVIDERS = {}   # model_id -> transport settings
MODELS = []      # 前端展示用（不含 key）
for _provider in CONFIG["providers"].values():
    _transport = _provider.get("transport", "http")
    _key_env = _provider.get("api_key_env")
    _env_key = os.environ.get(_key_env, "").strip() if _key_env else ""
    _api_key = _env_key or _provider.get("api_key", "").strip()
    for _mid, _mc in _provider["models"].items():
        PROVIDERS[_mid] = {
            "transport": _transport,
            "url": _provider.get("chat_url"),
            "key": _api_key,
            "model": _mid,
            "efforts": _mc["efforts"],
            "default_effort": _mc["effort"],
        }
        MODELS.append({
            "id": _mid,
            "label": _mc["label"],
            "supportsImages": _mc["supportsImages"],
            "transport": _transport,
            "configured": bool(_api_key),
            "effort": _mc["effort"],
            "efforts": _mc["efforts"],
        })

EFFORT_LABELS = {"no_think": "不思考", "low": "低思考", "medium": "中等思考", "high": "高思考", "max": "最强思考"}


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
            codex_ready = any(model["transport"] == "codex" for model in MODELS) and codex_is_logged_in()
            models = [dict(model, configured=codex_ready) if model["transport"] == "codex" else model for model in MODELS]
            self._json(200, {"effort_labels": EFFORT_LABELS, "models": models})
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
            if p["transport"] == "codex":
                host = self.headers.get("Host")
                origin = self.headers.get("Origin")
                port = self.server.server_port
                if (host not in (f"127.0.0.1:{port}", f"localhost:{port}")
                        or origin not in (None, f"http://{host}")
                        or self.headers.get_content_type() != "application/json"):
                    self._json(403, {"error": {"message": "Codex 请求须来自本地预览页面。", "code": "invalid_origin"}})
                    return
                self._json(200, complete_with_codex(p["model"], messages, effort))
                return
            if not p["key"]:
                self._json(503, {"error": {
                    "message": "所选模型尚未配置 API key。请配置服务端密钥后重启本地服务。",
                    "code": "missing_api_key",
                }})
                return
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
        except CodexError as e:
            self._json(e.status, {"error": {"message": str(e), "code": e.code}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": {"message": f"代理错误: {e}", "code": "proxy_error"}})


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler) as httpd:
        print("serving", ROOT, "at http://127.0.0.1:8765/index.html", flush=True)
        print("LLM 代理: POST /api/llm · 配置: GET /api/config", flush=True)
        httpd.serve_forever()
