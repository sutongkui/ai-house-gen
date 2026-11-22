"""Use the local, ChatGPT-authenticated Codex CLI for building plans."""

import base64
import binascii
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory


class CodexError(Exception):
    def __init__(self, message, status=502, code="codex_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def cli_options():
    # Keep the inherited Codex auth store and use the official ChatGPT login.
    excluded = {"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_THREAD_ID"}
    return {
        "env": {key: value for key, value in os.environ.items() if key.upper() not in excluded},
        "capture_output": True,
        "encoding": "utf-8",
        "errors": "replace",
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
    }


def codex_is_logged_in():
    cli = shutil.which("codex")
    if not cli:
        return False
    try:
        result = subprocess.run([cli, "login", "status"], timeout=5, **cli_options())
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and "logged in using chatgpt" in (result.stdout + result.stderr).lower()


def prepare_prompt(messages, directory, instructions=None):
    if not isinstance(messages, list) or not messages:
        raise CodexError("缺少建筑设计消息。", 400, "invalid_messages")

    image_extensions = {"data:image/jpeg;base64": ".jpg", "data:image/png;base64": ".png"}
    images = []
    dialogue = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("system", "user", "assistant"):
            raise CodexError("建筑设计消息格式无效。", 400, "invalid_messages")
        content = message.get("content")
        if isinstance(content, str):
            dialogue.append({"role": message["role"], "content": content})
            continue
        if not isinstance(content, list):
            raise CodexError("建筑设计消息格式无效。", 400, "invalid_messages")

        text = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                text.append(part["text"])
                continue
            if not isinstance(part, dict) or part.get("type") != "image_url" or not isinstance(part.get("image_url"), dict):
                raise CodexError("参考图消息格式无效。", 400, "invalid_image")
            url = part["image_url"].get("url")
            header, _, encoded = url.partition(",") if isinstance(url, str) else ("", "", "")
            if header not in image_extensions or not encoded or len(encoded) > 28 * 1024 * 1024:
                raise CodexError("参考图需要是本地上传的 JPEG 或 PNG。", 400, "invalid_image")
            try:
                image = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise CodexError("参考图无法解码。", 400, "invalid_image") from exc
            path = Path(directory) / f"reference-{len(images) + 1}{image_extensions[header]}"
            path.write_bytes(image)
            images.append(path)
            text.append(f"[参考图 {len(images)}]")
        dialogue.append({"role": message["role"], "content": "\n".join(text)})

    instructions = instructions or (
        "你正在为建筑生成器输出设计参数。下面是完整对话，按 system 消息的规则处理最后一条 user 消息。"
        "编号的参考图按顺序附在本次请求中。只输出一个建筑设计 JSON 对象。\n"
    )
    return instructions + json.dumps(dialogue, ensure_ascii=False), images


def complete_with_codex(model, messages, effort, *, instructions=None):
    cli = shutil.which("codex")
    if not cli:
        raise CodexError("找不到 Codex CLI。安装 Codex CLI 并运行 codex login 后重试。", 503, "codex_unavailable")

    with TemporaryDirectory(prefix="house-gen-codex-") as directory:
        prompt, images = prepare_prompt(messages, directory, instructions)
        command = [
            cli, "-a", "never", "exec", "--ignore-user-config", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "--model", model,
            "-c", 'forced_login_method="chatgpt"', "-c", 'web_search="disabled"',
            "-c", f"model_reasoning_effort={json.dumps(effort)}",
        ]
        for feature in ("shell_tool", "view_image", "apps", "plugins", "computer_use", "image_generation", "multi_agent", "multi_agent_v2"):
            command.extend(["--disable", feature])
        for image in images:
            command.extend(["--image", str(image)])
        command.append("--json")
        try:
            result = subprocess.run(command, cwd=directory, input=prompt, timeout=300, **cli_options())
        except subprocess.TimeoutExpired as exc:
            raise CodexError("Codex 生成超时，请重试。", 504, "codex_timeout") from exc
        except OSError as exc:
            raise CodexError("无法启动 Codex CLI。", 503, "codex_unavailable") from exc

    content = ""
    usage = None
    errors = [result.stderr]
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event["type"] == "item.completed" and event["item"]["type"] == "agent_message":
            content = event["item"]["text"]
        elif event["type"] == "turn.completed":
            usage = event.get("usage")
        elif event["type"] == "error":
            errors.append(event.get("message", ""))
        elif event["type"] == "turn.failed":
            errors.append(event.get("error", {}).get("message", ""))

    if result.returncode or not content:
        details = "\n".join(errors).lower()
        if any(term in details for term in ("not logged in", "unauthorized", "login required", "401")):
            raise CodexError("Codex 登录已失效，请运行 codex login 登录 ChatGPT 后重试。", 503, "codex_login_required")
        if any(term in details for term in ("usage limit", "rate limit", "insufficient_quota", "429")):
            raise CodexError("Codex 额度或速率已达限制，请查看 Codex 的用量页面。", 429, "codex_usage_limit")
        raise CodexError("Codex 未返回设计参数，请确认当前账号可用该模型后重试。")

    response = {"choices": [{"message": {"content": content}}]}
    if usage:
        response["usage"] = {"total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0)}
    return response
