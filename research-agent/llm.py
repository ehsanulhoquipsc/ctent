"""Optional AI layer. Works with Gemini (free key) or Ollama (local, free). Everything else runs without it."""
import json
import re
import threading
import time

import requests

import config

_lock = threading.Lock()
_last = [0.0]
_client = [None]


def enabled():
    if config.LLM_PROVIDER == "gemini":
        return bool(config.GEMINI_API_KEY)
    return config.LLM_PROVIDER == "ollama"


def label():
    if not enabled():
        return "AI off (keyword mode)"
    if config.LLM_PROVIDER == "gemini":
        return f"Gemini · {config.GEMINI_MODEL}"
    return f"Ollama · {config.OLLAMA_MODEL}"


def _throttle():
    with _lock:
        wait = config.LLM_MIN_INTERVAL - (time.monotonic() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()


def _gemini(prompt, json_mode):
    from google import genai
    from google.genai import types
    if _client[0] is None:
        _client[0] = genai.Client(api_key=config.GEMINI_API_KEY)
    cfg = types.GenerateContentConfig(
        temperature=0.2, response_mime_type="application/json" if json_mode else "text/plain")
    for attempt in range(4):
        _throttle()
        try:
            resp = _client[0].models.generate_content(model=config.GEMINI_MODEL, contents=prompt, config=cfg)
            return resp.text or ""
        except Exception as e:
            msg = str(e)
            if any(code in msg for code in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE")):
                time.sleep(20 * (attempt + 1))
                continue
            raise
    raise RuntimeError("Gemini free-tier limit reached. Wait a few minutes, or use Quick depth.")


def _ollama(prompt, json_mode):
    body = {"model": config.OLLAMA_MODEL, "prompt": prompt, "stream": False, "options": {"temperature": 0.2}}
    if json_mode:
        body["format"] = "json"
    r = requests.post(f"{config.OLLAMA_URL}/api/generate", json=body, timeout=900)
    r.raise_for_status()
    return r.json().get("response", "")


def _call(prompt, json_mode):
    if not enabled():
        raise RuntimeError("No AI model configured")
    return _gemini(prompt, json_mode) if config.LLM_PROVIDER == "gemini" else _ollama(prompt, json_mode)


def text_call(prompt):
    return _call(prompt, False)


def json_call(prompt):
    text = _call(prompt, True).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise
