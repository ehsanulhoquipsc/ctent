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
_blocked_until = [0.0]   # set when the daily free quota is used up, so later calls fail fast instead of waiting


class QuotaExhausted(RuntimeError):
    pass


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
    if time.monotonic() < _blocked_until[0]:
        raise QuotaExhausted("Gemini daily free quota is used up. Try again later (it resets daily), or use Ollama.")
    for attempt in range(4):
        _throttle()
        try:
            resp = _client[0].models.generate_content(model=config.GEMINI_MODEL, contents=prompt, config=cfg)
            return resp.text or ""
        except Exception as e:
            msg = str(e)
            if "PerDay" in msg or "per day" in msg.lower():
                # Daily quota: waiting a minute will not help, so stop all AI calls for the next 30 minutes.
                _blocked_until[0] = time.monotonic() + 1800
                raise QuotaExhausted("Gemini daily free quota is used up. Try again later (it resets daily), or use Ollama.")
            if any(code in msg for code in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE", "overloaded")):
                time.sleep(15 * (attempt + 1))
                continue
            if "API_KEY_INVALID" in msg or "API key not valid" in msg:
                raise RuntimeError("Gemini rejected the API key. Check GEMINI_API_KEY in .env.")
            if "NOT_FOUND" in msg or "is not found" in msg:
                raise RuntimeError(f"Gemini model '{config.GEMINI_MODEL}' was not found. Set GEMINI_MODEL=gemini-2.5-flash in .env.")
            raise RuntimeError(f"Gemini error: {msg[:200]}")
    raise RuntimeError("Gemini is busy or the per-minute limit was reached. Wait a few minutes, or use Quick depth.")


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


def _shape(data):
    """Models sometimes answer with a bare list, or a list holding one object, instead of the object we asked for.
    Always return a dict so callers can use .get() safely."""
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        first = data[0] if len(data) == 1 and isinstance(data[0], dict) else {}
        return {**first, "items": data, "claims": data, "gaps": data, "questions": data}
    return {}


def json_call(prompt):
    text = _call(prompt, True).strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text).strip()
    try:
        return _shape(json.loads(text))
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}|\[.*\]", text, re.S)
        if m:
            return _shape(json.loads(m.group(0)))
        raise ValueError("the AI did not return valid JSON")
