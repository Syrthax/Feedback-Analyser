"""Shared Featherless AI call helper: one function for all AI calls, with
retries and a safe fallback when the model fails. Used by the Scorer, the
Analyst and the market comparison.

Featherless serves open-weights models behind an OpenAI-compatible API, so
this talks to it with the openai SDK pointed at FEATHERLESS_BASE_URL. The model
defaults to Qwen/Qwen2.5-72B-Instruct (needs Featherless' Premium plan, which
allows models up to 72B); set FEATHERLESS_MODEL to use another one, e.g.
Qwen/Qwen2.5-14B-Instruct on the Basic plan.

Featherless doesn't meter tokens; it caps how many requests run at once, and
a 72B model costs 4 of a plan's concurrency units. Every call here is made one
after another, so a run never exceeds that on its own, but another client on
the same key (or a second run) can: that comes back as a 429. A short wait
usually clears it, so a RateLimitError gets its own wait, honouring the
server's Retry-After header -- capped at MAX_RATE_LIMIT_WAIT, past which
retrying inside one call won't help and we fail fast to the fallback."""

import os
import re
import time

from openai import OpenAI, RateLimitError

from config import get_key
from errors import ConfigError, UpstreamError

FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1"
DEFAULT_MODEL = "Qwen/Qwen2.5-72B-Instruct"
MAX_TOKENS = 1500
REQUEST_TIMEOUT = 120  # seconds; a 72B model under load can take a while to start
RATE_LIMIT_FALLBACK_WAIT = 10  # seconds, used when Featherless doesn't send Retry-After
MAX_RATE_LIMIT_WAIT = 30  # never sleep longer than this even if Retry-After asks for more


def model_name() -> str:
    return os.environ.get("FEATHERLESS_MODEL") or DEFAULT_MODEL


def call_llm(system_prompt: str, user_prompt: str, max_retries: int = 3, fallback: str | None = None) -> str:
    """A 429 (too many concurrent requests on this key) is an expected,
    recoverable condition here, so it gets its own longer wait instead of the
    generic exponential backoff (max ~3s across 3 attempts)."""
    # Only the Featherless key: load_keys() demands every key, so a missing
    # HINDSIGHT_API_KEY used to break every LLM call too. A missing key is a
    # config problem, not a flaky call -- raise it even when there's a
    # fallback, rather than returning six placeholder scores.
    api_key = get_key("FEATHERLESS_API_KEY")
    if not api_key:
        raise ConfigError("FEATHERLESS_API_KEY is not set -- see .env.example, or add it to keys.csv.")
    client = OpenAI(api_key=api_key, base_url=FEATHERLESS_BASE_URL, timeout=REQUEST_TIMEOUT, max_retries=0)
    model = model_name()
    last_error = None

    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
                max_tokens=MAX_TOKENS,
            )
            choice = response.choices[0]
            # an empty reply with a normal 200 is a failed call, not an answer
            if not (choice.message.content or "").strip():
                raise ValueError(f"empty completion (finish_reason={choice.finish_reason!r})")
            return choice.message.content
        except RateLimitError as e:
            last_error = e
            try:  # seconds normally, but HTTP also allows a date here
                wait = float(e.response.headers.get("retry-after") or RATE_LIMIT_FALLBACK_WAIT)
            except ValueError:
                wait = RATE_LIMIT_FALLBACK_WAIT
            if wait > MAX_RATE_LIMIT_WAIT:
                break  # retrying within this call is futile, fail fast
            if attempt < max_retries - 1:
                time.sleep(wait)
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                time.sleep(2**attempt)

    if fallback is not None:
        return fallback
    raise UpstreamError(f"Featherless AI call failed after {max_retries} attempts: {last_error}")


def strip_code_fences(text: str) -> str:
    """The model sometimes wraps JSON in ```json ... ``` despite being told not
    to; json.loads() rejects that, so unwrap it before parsing."""
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    return match.group(1).strip() if match else text.strip()
