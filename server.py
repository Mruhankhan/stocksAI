import asyncio
import json
import mimetypes
import os
import re
from datetime import datetime, time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from aiohttp import ClientSession, ClientTimeout
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse


ROOT = Path(__file__).resolve().parent
USER_AGENT = "StocksAI/1.0"
SYMBOL_RE = re.compile(r"[^A-Z0-9.-]")
SYMBOL_CACHE = None


def clean_symbol(value):
    return SYMBOL_RE.sub("", (value or "AAPL").upper())


def yahoo_interval(interval):
    if interval == "1m":
        return {"range": "1d", "interval": "1m"}
    if interval in {"5m", "10m", "15m", "30m"}:
        return {"range": "5d", "interval": "1m"}
    if interval == "1h":
        return {"range": "1mo", "interval": "5m"}
    return {"range": "1d", "interval": "1m"}


async def get_http(app):
    if "http" not in app or app["http"].closed:
        app["http"] = ClientSession(timeout=ClientTimeout(total=30))
    return app["http"]


async def fetch_text(app, url, **kwargs):
    http = await get_http(app)
    async with http.get(url, headers={"User-Agent": USER_AGENT}, **kwargs) as response:
        response.raise_for_status()
        return await response.text()


async def fetch_json(app, url, **kwargs):
    http = await get_http(app)
    async with http.get(url, headers={"User-Agent": USER_AGENT}, **kwargs) as response:
        response.raise_for_status()
        return await response.json()


async def yahoo_chart(app, symbol, interval):
    config = yahoo_interval(interval)
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?region=US&lang=en-US&includePrePost=true"
        f"&interval={config['interval']}&range={config['range']}"
        "&corsDomain=finance.yahoo.com"
    )
    return await fetch_json(app, url)


def iso_from_unix(value):
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def us_session_key():
    now = datetime.now(ZoneInfo("America/New_York"))
    if now.weekday() >= 5:
        return "CLOSED"
    current = time(now.hour, now.minute)
    if time(4, 0) <= current < time(9, 30):
        return "PRE"
    if time(9, 30) <= current < time(16, 0):
        return "REGULAR"
    if time(16, 0) <= current < time(20, 0):
        return "POST"
    return "CLOSED"


def compact_numbers(values):
    return [value for value in values or [] if value is not None]


def chart_to_summary(symbol, chart):
    result = chart["chart"]["result"][0]
    meta = result.get("meta", {})
    quote = result.get("indicators", {}).get("quote", [{}])[0]
    opens = compact_numbers(quote.get("open"))
    highs = compact_numbers(quote.get("high"))
    lows = compact_numbers(quote.get("low"))
    closes = compact_numbers(quote.get("close"))
    volumes = compact_numbers(quote.get("volume"))

    last_close = float(closes[-1] if closes else meta.get("regularMarketPrice", 0) or 0)
    regular_market = float(meta.get("regularMarketPrice") or last_close)
    pre_market = meta.get("preMarketPrice")
    post_market = meta.get("postMarketPrice")
    market_state = meta.get("marketState") or "UNKNOWN"
    session_key = us_session_key()

    if pre_market is None and session_key == "PRE" and abs(last_close - regular_market) > 0.0001:
        pre_market = last_close
    if post_market is None and session_key in {"POST", "CLOSED"} and abs(last_close - regular_market) > 0.0001:
        post_market = last_close
    if market_state == "UNKNOWN":
        market_state = session_key

    previous = float(meta.get("previousClose") or meta.get("chartPreviousClose") or last_close)
    open_price = float(opens[0] if opens else last_close)
    high = float(max(highs) if highs else last_close)
    low = float(min(lows) if lows else last_close)
    volume = float(meta.get("regularMarketVolume") or (sum(volumes) if volumes else 0))

    return {
        "result": {
            "symbol": symbol,
            "display_name": meta.get("longName") or meta.get("shortName") or symbol,
            "current_price": regular_market,
            "regular_market_price": regular_market,
            "pre_market_price": pre_market,
            "post_market_price": post_market,
            "regular_market_time": iso_from_unix(meta.get("regularMarketTime")),
            "pre_market_time": iso_from_unix(meta.get("preMarketTime")),
            "post_market_time": iso_from_unix(meta.get("postMarketTime")),
            "previous_close": previous,
            "regular_market_previous_close": previous,
            "open": open_price,
            "regular_market_open": open_price,
            "day_high": high,
            "regular_market_day_high": high,
            "day_low": low,
            "regular_market_day_low": low,
            "volume": volume,
            "regular_market_volume": volume,
            "market_state": market_state,
            "full_exchange_name": meta.get("fullExchangeName") or meta.get("exchangeName") or "US",
        }
    }


def merge_finimpulse_summary(base, fin):
    result = base["result"]
    fin_result = fin.get("result", fin)
    for field in ("long_name", "short_name", "currency", "financial_currency", "quote_type", "sector", "industry"):
        if fin_result.get(field):
            result[field] = fin_result[field]
    for field in ("display_name", "full_exchange_name", "exchange"):
        if not result.get(field) and fin_result.get(field):
            result[field] = fin_result[field]
    return base


async def finimpulse_summary(app, symbol):
    token = os.getenv("FINIMPULSE_TOKEN", "")
    if not token:
        return None
    payload = json.dumps({"symbol": symbol})
    http = await get_http(app)
    async with http.post(
        "https://api.finimpulse.com/v1/summary",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    ) as response:
        response.raise_for_status()
        return await response.json()


def parse_nasdaq_listed(text):
    items = []
    for line in text.splitlines():
        clean = line.strip()
        if not clean or clean.startswith("File Creation") or clean.startswith("Symbol|"):
            continue
        parts = clean.split("|")
        if len(parts) < 2:
            continue
        symbol, name = parts[0].strip(), parts[1].strip()
        if symbol and name and "$" not in symbol and "Test Issue" not in name:
            items.append({"symbol": symbol, "displaySymbol": symbol, "description": name, "exchange": "NASDAQ"})
    return items


def parse_other_listed(text):
    items = []
    for line in text.splitlines():
        clean = line.strip()
        if not clean or clean.startswith("File Creation") or clean.startswith("ACT Symbol|"):
            continue
        parts = clean.split("|")
        if len(parts) >= 4 and parts[2].strip() == "N":
            symbol = parts[0].strip()
            items.append({"symbol": symbol, "displaySymbol": symbol, "description": parts[1].strip(), "exchange": "NYSE"})
    return items


async def exchange_symbols(app):
    global SYMBOL_CACHE
    if SYMBOL_CACHE is not None:
        return SYMBOL_CACHE

    nasdaq_url = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
    other_url = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
    nasdaq_text, other_text = await asyncio.gather(fetch_text(app, nasdaq_url), fetch_text(app, other_url))

    unique = {}
    for item in parse_nasdaq_listed(nasdaq_text) + parse_other_listed(other_text):
        unique[item["symbol"]] = item
    SYMBOL_CACHE = sorted(unique.values(), key=lambda item: item["symbol"])
    return SYMBOL_CACHE


async def handle_chart(request):
    symbol = clean_symbol(request.query.get("symbol"))
    interval = request.query.get("interval", "1m")
    try:
        return JSONResponse(await yahoo_chart(request.app, symbol, interval))
    except Exception:
        raise HTTPException(status_code=502, detail=f"Could not fetch chart data for {symbol}.")


async def handle_summary(request):
    symbol = clean_symbol(request.query.get("symbol"))
    try:
        summary = chart_to_summary(symbol, await yahoo_chart(request.app, symbol, "1m"))
        try:
            fin = await finimpulse_summary(request.app, symbol)
            if fin:
                summary = merge_finimpulse_summary(summary, fin)
        except Exception:
            pass
        return JSONResponse(summary)
    except Exception:
        try:
            fin = await finimpulse_summary(request.app, symbol)
            if fin:
                return JSONResponse(fin)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Could not fetch summary for {symbol}.")


async def handle_symbols(request):
    query = (request.query.get("q") or "").upper()
    try:
        symbols = await exchange_symbols(request.app)
        if query:
            starts = [
                item for item in symbols
                if item["symbol"].upper().startswith(query) or item["description"].upper().startswith(query)
            ]
            contains = [
                item for item in symbols
                if item not in starts
                and (query in item["symbol"].upper() or query in item["description"].upper())
            ]
            symbols = starts + contains
        return JSONResponse(symbols[:80])
    except Exception:
        raise HTTPException(status_code=502, detail="Could not load NYSE/Nasdaq symbol list.")


async def handle_static(request):
    path = request.match_info.get("path") or "index.html"
    file_path = (ROOT / path).resolve()
    if ROOT not in file_path.parents and file_path != ROOT:
        raise HTTPException(status_code=403, detail="Forbidden")
    if file_path.is_dir():
        file_path = file_path / "index.html"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Not found")

    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=content_type)


async def startup_app(app):
    await get_http(app)


async def cleanup_app(app):
    if "http" in app and not app["http"].closed:
        await app["http"].close()


def create_app():
    app = FastAPI()
    app.state.store = {}

    @app.on_event("startup")
    async def on_startup():
        await startup_app(app.state.store)

    @app.on_event("shutdown")
    async def on_shutdown():
        await cleanup_app(app.state.store)

    def adapt_request(request, path=None):
        return type(
            "CompatRequest",
            (),
            {
                "app": app.state.store,
                "query": request.query_params,
                "match_info": {"path": path or ""},
            },
        )()

    @app.get("/api/chart")
    async def chart(request: Request):
        return await handle_chart(adapt_request(request))

    @app.get("/api/summary")
    async def summary(request: Request):
        return await handle_summary(adapt_request(request))

    @app.get("/api/symbols")
    async def symbols(request: Request):
        return await handle_symbols(adapt_request(request))

    @app.get("/")
    async def root(request: Request):
        return await handle_static(adapt_request(request))

    @app.get("/{path:path}")
    async def static_file(request: Request, path: str):
        return await handle_static(adapt_request(request, path))

    return app


app = create_app()


def main():
    import uvicorn

    port = int(os.getenv("PORT", "4173"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
