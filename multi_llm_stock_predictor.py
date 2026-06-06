#!/usr/bin/env python3
"""
Multi-LLM real-time stock chart predictor.

Captures a stock chart screenshot, sends it concurrently to OpenAI, Gemini,
and Anthropic vision models, then aggregates their strict 8-point JSON scores
into one trading decision.

This script emits analysis only. It does not place broker orders.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


SCORING_KEYS = (
    "market_bullish",
    "sector_bullish",
    "above_vwap",
    "hh_hl_structure",
    "strong_volume",
    "bullish_order_flow",
    "breakout_retest",
    "no_resistance_above",
)

SYSTEM_PROMPT = """Role: Expert Intraday Price-Action Trading System (15-Minute Window).
Task: Analyze the provided screenshot containing 1-minute, 5-minute, and 30-minute candlestick charts. Evaluate the setup for a Long (Buy) position over the next 15 minutes.
Scoring Criteria: Assign exactly 1 point for each bullish condition met, and 0 points if absent/bearish:
Market Bullish: SPY/QQQ trending up or holding above VWAP.
Sector Bullish: Sector ETF shows relative strength.
Stock Above VWAP: Current price sits comfortably above VWAP.
Trend Structure: Visible pattern of higher highs and higher lows.
Relative Volume: Breakout volume is significantly above recent average.
Order Flow/Tape: Strong, aggressive buying pressure on green candles.
Level Retest: Breakout level successfully retested and held as support.
Clear Skies: No major overhead resistance levels immediately above.
Output Format: Respond strictly in this JSON format with zero conversational text:
{
  "scores": {
    "market_bullish": 0, "sector_bullish": 0, "above_vwap": 0, "hh_hl_structure": 0,
    "strong_volume": 0, "bullish_order_flow": 0, "breakout_retest": 0, "no_resistance_above": 0
  },
  "total_score": 0,
  "rationale": "1-sentence summary"
}"""

USER_TEXT = (
    "Analyze this multi-timeframe intraday stock chart screenshot now. "
    "Return only the requested JSON object."
)


@dataclass(frozen=True)
class ModelConfig:
    provider: str
    model: str
    api_key_env: str
    api_key_placeholder: str


@dataclass
class ModelResult:
    provider: str
    model: str
    scores: dict[str, int]
    total_score: int
    rationale: str
    raw_text: str


@dataclass
class ProviderFailure:
    provider: str
    model: str
    error: str


DEFAULT_MODELS = {
    "openai": ModelConfig(
        provider="openai",
        model="gpt-4o",
        api_key_env="OPENAI_API_KEY",
        api_key_placeholder="YOUR_OPENAI_API_KEY",
    ),
    "gemini": ModelConfig(
        provider="gemini",
        model="gemini-1.5-pro",
        api_key_env="GEMINI_API_KEY",
        api_key_placeholder="YOUR_GEMINI_API_KEY",
    ),
    "anthropic": ModelConfig(
        provider="anthropic",
        model="claude-3-5-sonnet",
        api_key_env="ANTHROPIC_API_KEY",
        api_key_placeholder="YOUR_ANTHROPIC_API_KEY",
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture chart screenshots and get multi-LLM 8-point stock setup consensus."
    )
    parser.add_argument("--symbol", default="AAPL", help="Ticker label used in output and filenames.")
    parser.add_argument(
        "--input-image",
        type=Path,
        help="Use an existing PNG/JPEG instead of capturing the active screen.",
    )
    parser.add_argument(
        "--capture-dir",
        type=Path,
        default=Path("captures"),
        help="Directory where screenshots are saved.",
    )
    parser.add_argument(
        "--region",
        help="Optional pyautogui crop as x,y,width,height. Omit to capture the whole screen.",
    )
    parser.add_argument(
        "--chart-url",
        help="Optional URL to capture with Playwright instead of pyautogui.",
    )
    parser.add_argument(
        "--playwright-selector",
        help="Optional CSS selector to screenshot inside --chart-url, such as #chart.",
    )
    parser.add_argument(
        "--playwright-timeframes",
        help=(
            "Optional comma-separated intervals to click and stitch into one image when using "
            "--chart-url. For this app, use 1m,5m,30m."
        ),
    )
    parser.add_argument("--once", action="store_true", help="Run one capture/analyze cycle and exit.")
    parser.add_argument("--mock", action="store_true", help="Use deterministic fake model responses.")
    parser.add_argument(
        "--interval-minutes",
        type=float,
        default=15,
        help="Loop cadence in minutes during market hours.",
    )
    parser.add_argument("--timeout", type=float, default=60, help="Per-provider timeout in seconds.")
    parser.add_argument("--timezone", default="America/New_York", help="Market timezone.")
    parser.add_argument("--market-start", default="09:30", help="Market open time, HH:MM.")
    parser.add_argument("--market-end", default="16:00", help="Market close time, HH:MM.")
    parser.add_argument(
        "--include-after-hours",
        action="store_true",
        help="Ignore regular-market schedule and run every interval until stopped.",
    )
    parser.add_argument("--openai-model", default=DEFAULT_MODELS["openai"].model)
    parser.add_argument("--gemini-model", default=DEFAULT_MODELS["gemini"].model)
    parser.add_argument("--anthropic-model", default=DEFAULT_MODELS["anthropic"].model)
    return parser.parse_args()


def parse_hhmm(value: str) -> dtime:
    try:
        hour, minute = value.split(":", 1)
        return dtime(hour=int(hour), minute=int(minute))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid HH:MM time: {value}") from exc


def parse_region(value: str | None) -> tuple[int, int, int, int] | None:
    if not value:
        return None
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise ValueError("--region must be x,y,width,height")
    numbers = tuple(int(part) for part in parts)
    if numbers[2] <= 0 or numbers[3] <= 0:
        raise ValueError("--region width and height must be positive")
    return numbers


def is_market_open(
    now: datetime,
    market_start: dtime,
    market_end: dtime,
    include_after_hours: bool,
) -> bool:
    if include_after_hours:
        return True
    if now.weekday() >= 5:
        return False
    return market_start <= now.time() < market_end


def next_market_open(now: datetime, market_start: dtime) -> datetime:
    candidate = now.replace(
        hour=market_start.hour,
        minute=market_start.minute,
        second=0,
        microsecond=0,
    )
    if candidate <= now:
        candidate += timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def sleep_seconds_until_market(
    timezone: ZoneInfo,
    market_start: dtime,
    market_end: dtime,
    include_after_hours: bool,
) -> float:
    now = datetime.now(timezone)
    if is_market_open(now, market_start, market_end, include_after_hours):
        return 0
    return max(1.0, (next_market_open(now, market_start) - now).total_seconds())


async def capture_with_playwright(
    url: str,
    output_path: Path,
    selector: str | None,
    timeframes: list[str],
) -> Path:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - exercised by user env
        raise RuntimeError(
            "Playwright capture requested but playwright is not installed. "
            "Run `pip install -r requirements.txt` and `python -m playwright install chromium`."
        ) from exc

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            page = await browser.new_page(viewport={"width": 1600, "height": 1000})
            await page.goto(url, wait_until="networkidle")

            if timeframes:
                frame_paths: list[Path] = []
                for timeframe in timeframes:
                    await page.locator(f'[data-interval="{timeframe}"]').click(timeout=10_000)
                    await page.wait_for_timeout(2_000)
                    frame_path = output_path.with_name(f"{output_path.stem}-{timeframe}{output_path.suffix}")
                    if selector:
                        await page.locator(selector).screenshot(path=str(frame_path))
                    else:
                        await page.screenshot(path=str(frame_path), full_page=False)
                    frame_paths.append(frame_path)
                stitch_images(frame_paths, timeframes, output_path)
                for frame_path in frame_paths:
                    frame_path.unlink(missing_ok=True)
            elif selector:
                await page.locator(selector).screenshot(path=str(output_path))
            else:
                await page.screenshot(path=str(output_path), full_page=False)
        finally:
            await browser.close()
    return output_path


def stitch_images(image_paths: list[Path], labels: list[str], output_path: Path) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:  # pragma: no cover - exercised by user env
        raise RuntimeError("Pillow is required to stitch timeframe screenshots.") from exc

    images = []
    for path in image_paths:
        with Image.open(path) as image:
            images.append(image.convert("RGB"))
    label_height = 34
    width = max(image.width for image in images)
    height = sum(image.height + label_height for image in images)
    combined = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(combined)

    y = 0
    for label, image in zip(labels, images):
        draw.rectangle((0, y, width, y + label_height), fill=(17, 24, 39))
        draw.text((12, y + 9), f"{label} candle chart", fill=(255, 255, 255))
        y += label_height
        combined.paste(image, (0, y))
        y += image.height

    combined.save(output_path)


def capture_with_pyautogui(output_path: Path, region: tuple[int, int, int, int] | None) -> Path:
    try:
        import pyautogui
    except ImportError as exc:  # pragma: no cover - exercised by user env
        raise RuntimeError(
            "pyautogui capture requested but pyautogui is not installed. "
            "Run `pip install -r requirements.txt`, or pass --input-image."
        ) from exc

    screenshot = pyautogui.screenshot(region=region)
    screenshot.save(output_path)
    return output_path


async def capture_chart_image(args: argparse.Namespace) -> Path:
    if args.input_image:
        if not args.input_image.exists():
            raise FileNotFoundError(f"Input image not found: {args.input_image}")
        return args.input_image

    args.capture_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_path = args.capture_dir / f"{args.symbol.upper()}-{timestamp}.png"

    if args.chart_url:
        timeframes = [
            item.strip()
            for item in (args.playwright_timeframes or "").split(",")
            if item.strip()
        ]
        return await capture_with_playwright(
            args.chart_url,
            output_path,
            args.playwright_selector,
            timeframes,
        )

    region = parse_region(args.region)
    return await asyncio.to_thread(capture_with_pyautogui, output_path, region)


def encode_image_base64(image_path: Path) -> tuple[str, str]:
    suffix = image_path.suffix.lower()
    media_type = "image/jpeg" if suffix in {".jpg", ".jpeg"} else "image/png"
    data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return data, media_type


async def post_json(
    session: Any,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    async with session.post(url, headers=headers, json=payload, timeout=timeout) as response:
        text = await response.text()
        if response.status >= 400:
            raise RuntimeError(f"HTTP {response.status}: {text[:500]}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Non-JSON API response: {text[:500]}") from exc


async def call_openai(
    session: aiohttp.ClientSession,
    config: ModelConfig,
    image_b64: str,
    media_type: str,
    timeout: float,
) -> str:
    api_key = get_api_key(config)
    payload = {
        "model": config.model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_TEXT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{media_type};base64,{image_b64}"},
                    },
                ],
            },
        ],
    }
    data = await post_json(
        session,
        "https://api.openai.com/v1/chat/completions",
        {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        payload,
        timeout,
    )
    return data["choices"][0]["message"]["content"]


async def call_gemini(
    session: aiohttp.ClientSession,
    config: ModelConfig,
    image_b64: str,
    media_type: str,
    timeout: float,
) -> str:
    api_key = get_api_key(config)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.model}:generateContent?key={api_key}"
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": USER_TEXT},
                    {"inlineData": {"mimeType": media_type, "data": image_b64}},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
        },
    }
    data = await post_json(session, url, {"Content-Type": "application/json"}, payload, timeout)
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(part.get("text", "") for part in parts)


async def call_anthropic(
    session: aiohttp.ClientSession,
    config: ModelConfig,
    image_b64: str,
    media_type: str,
    timeout: float,
) -> str:
    api_key = get_api_key(config)
    payload = {
        "model": config.model,
        "max_tokens": 700,
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": USER_TEXT},
                ],
            }
        ],
    }
    data = await post_json(
        session,
        "https://api.anthropic.com/v1/messages",
        {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        payload,
        timeout,
    )
    return "".join(block.get("text", "") for block in data.get("content", []))


def get_api_key(config: ModelConfig) -> str:
    value = os.getenv(config.api_key_env, "").strip()
    if not value or value == config.api_key_placeholder:
        raise RuntimeError(
            f"Missing {config.api_key_env}. Set it to your key, not {config.api_key_placeholder}."
        )
    return value


def extract_json_object(text: str) -> dict[str, Any]:
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.strip("`")
        clean = clean.removeprefix("json").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        start = clean.find("{")
        end = clean.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(clean[start : end + 1])


def normalize_model_result(provider: str, model: str, text: str) -> ModelResult:
    data = extract_json_object(text)
    scores = data.get("scores")
    if not isinstance(scores, dict):
        raise ValueError(f"{provider} response is missing scores object")

    normalized_scores: dict[str, int] = {}
    for key in SCORING_KEYS:
        if key not in scores:
            raise ValueError(f"{provider} response is missing scores.{key}")
        value = scores[key]
        if value not in (0, 1):
            raise ValueError(f"{provider} scores.{key} must be 0 or 1, got {value!r}")
        normalized_scores[key] = int(value)

    total = data.get("total_score")
    expected_total = sum(normalized_scores.values())
    if total != expected_total:
        total = expected_total

    rationale = data.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        raise ValueError(f"{provider} response is missing rationale")

    return ModelResult(
        provider=provider,
        model=model,
        scores=normalized_scores,
        total_score=expected_total,
        rationale=rationale.strip(),
        raw_text=text,
    )


async def safe_provider_call(
    provider: str,
    call_coro: Any,
    model: str,
) -> ModelResult | ProviderFailure:
    try:
        text = await call_coro
        return normalize_model_result(provider, model, text)
    except asyncio.TimeoutError:
        return ProviderFailure(provider=provider, model=model, error="Timed out")
    except Exception as exc:  # noqa: BLE001 - provider errors should not kill consensus
        return ProviderFailure(provider=provider, model=model, error=str(exc))


def mock_response(provider: str) -> str:
    presets = {
        "openai": [1, 1, 1, 1, 1, 0, 1, 1],
        "gemini": [1, 1, 1, 1, 0, 1, 1, 1],
        "anthropic": [1, 0, 1, 1, 1, 1, 0, 1],
    }
    values = presets[provider]
    scores = dict(zip(SCORING_KEYS, values))
    return json.dumps(
        {
            "scores": scores,
            "total_score": sum(values),
            "rationale": f"Mock {provider} sees a mostly bullish intraday setup.",
        }
    )


async def analyze_image(
    image_path: Path,
    configs: dict[str, ModelConfig],
    timeout: float,
    mock: bool,
) -> tuple[list[ModelResult], list[ProviderFailure]]:
    image_b64, media_type = encode_image_base64(image_path)

    if mock:
        results = [
            normalize_model_result(provider, config.model, mock_response(provider))
            for provider, config in configs.items()
        ]
        return results, []

    try:
        import aiohttp
    except ImportError as exc:  # pragma: no cover - exercised by user env
        raise RuntimeError(
            "Missing dependency: aiohttp. Install with `pip install -r requirements.txt`."
        ) from exc

    async with aiohttp.ClientSession() as session:
        tasks = [
            safe_provider_call(
                "openai",
                call_openai(session, configs["openai"], image_b64, media_type, timeout),
                configs["openai"].model,
            ),
            safe_provider_call(
                "gemini",
                call_gemini(session, configs["gemini"], image_b64, media_type, timeout),
                configs["gemini"].model,
            ),
            safe_provider_call(
                "anthropic",
                call_anthropic(session, configs["anthropic"], image_b64, media_type, timeout),
                configs["anthropic"].model,
            ),
        ]
        responses = await asyncio.gather(*tasks)

    results: list[ModelResult] = []
    failures: list[ProviderFailure] = []
    for response in responses:
        if isinstance(response, ProviderFailure):
            failures.append(response)
        else:
            results.append(response)
    return results, failures


def decision_from_score(consensus_score: float) -> str:
    if consensus_score >= 7.0:
        return "[STRONGEST SETUP - BUY TRADING SIGNAL EXECUTED]"
    if consensus_score >= 5.0:
        return "[UNCERTAIN SETUP - REDUCE SIZE OR SKIP]"
    return "[AVOID TRADE - SIGNALS CONFLICT / BEARISH]"


def aggregate_results(results: list[ModelResult]) -> dict[str, Any]:
    expected_providers = set(DEFAULT_MODELS)
    received_providers = {result.provider for result in results}
    if received_providers != expected_providers:
        missing = ", ".join(sorted(expected_providers - received_providers)) or "unknown"
        raise RuntimeError(f"Missing valid provider responses: {missing}")

    consensus_score = sum(result.total_score for result in results) / len(results)
    aggregate_scores = {
        key: sum(result.scores[key] for result in results) / len(results)
        for key in SCORING_KEYS
    }
    return {
        "consensus_score": round(consensus_score, 2),
        "decision": decision_from_score(consensus_score),
        "aggregate_scores": aggregate_scores,
        "model_scores": {
            result.provider: {
                "model": result.model,
                "total_score": result.total_score,
                "scores": result.scores,
                "rationale": result.rationale,
            }
            for result in results
        },
    }


def print_report(
    symbol: str,
    image_path: Path,
    results: list[ModelResult],
    failures: list[ProviderFailure],
) -> None:
    base_report = {
        "symbol": symbol.upper(),
        "captured_image": str(image_path),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "provider_failures": [
            {"provider": failure.provider, "model": failure.model, "error": failure.error}
            for failure in failures
        ],
    }

    if failures:
        report = {
            **base_report,
            "decision": "[NO CONSENSUS - PROVIDER FAILURE]",
            "model_scores": {
                result.provider: {
                    "model": result.model,
                    "total_score": result.total_score,
                    "scores": result.scores,
                    "rationale": result.rationale,
                }
                for result in results
            },
        }
        print(json.dumps(report, indent=2))
        print(report["decision"])
        print(
            "WARNING: Strict consensus requires OpenAI, Gemini, and Anthropic. Failures: "
            + ", ".join(f"{failure.provider}={failure.error}" for failure in failures),
            file=sys.stderr,
        )
        return

    report = {**base_report, **aggregate_results(results)}
    print(json.dumps(report, indent=2))
    print(report["decision"])


def build_model_configs(args: argparse.Namespace) -> dict[str, ModelConfig]:
    return {
        "openai": ModelConfig(
            **{**DEFAULT_MODELS["openai"].__dict__, "model": args.openai_model}
        ),
        "gemini": ModelConfig(
            **{**DEFAULT_MODELS["gemini"].__dict__, "model": args.gemini_model}
        ),
        "anthropic": ModelConfig(
            **{**DEFAULT_MODELS["anthropic"].__dict__, "model": args.anthropic_model}
        ),
    }


async def run_once(args: argparse.Namespace, configs: dict[str, ModelConfig]) -> None:
    image_path = await capture_chart_image(args)
    results, failures = await analyze_image(
        image_path=image_path,
        configs=configs,
        timeout=args.timeout,
        mock=args.mock,
    )
    print_report(args.symbol, image_path, results, failures)


async def run_loop(args: argparse.Namespace, configs: dict[str, ModelConfig]) -> None:
    timezone = ZoneInfo(args.timezone)
    market_start = parse_hhmm(args.market_start)
    market_end = parse_hhmm(args.market_end)
    cadence_seconds = max(60.0, args.interval_minutes * 60.0)

    while True:
        sleep_market = sleep_seconds_until_market(
            timezone,
            market_start,
            market_end,
            args.include_after_hours,
        )
        if sleep_market > 0:
            opens_at = next_market_open(datetime.now(timezone), market_start)
            print(f"Market closed. Sleeping until {opens_at.isoformat(timespec='minutes')}.")
            await asyncio.sleep(sleep_market)
            continue

        started = time.monotonic()
        try:
            await run_once(args, configs)
        except Exception as exc:  # noqa: BLE001 - loop should survive one bad cycle
            print(f"Cycle failed: {exc}", file=sys.stderr)

        elapsed = time.monotonic() - started
        await asyncio.sleep(max(1.0, cadence_seconds - elapsed))


async def main() -> None:
    args = parse_args()
    configs = build_model_configs(args)
    if args.once:
        await run_once(args, configs)
    else:
        await run_loop(args, configs)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Stopped.")
