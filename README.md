# StocksAI Market Desk

A professional single-page stock lookup web app for US ticker symbols. Search any listed US stock symbol, view the latest quote, intraday chart, snapshot stats, quick watchlist, auto-refreshing market data, replay, local price alerts, drawings, and AI-style structure notes.

## Run

Local Python server:

```powershell
python server.py
```

Then open `http://localhost:4173`.

The older Windows PowerShell server still works locally:

From PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\start-server.ps1" -FinImpulseToken "YOUR_FINIMPULSE_TOKEN"
```

Then open `http://localhost:4173`.

Or double-click `run-app.bat`, paste your FinImpulse token, and keep that window open.

## What is included

- Smooth canvas candlesticks with cursor-centered zoom and fractional panning.
- 1m, 5m, 10m, 15m, 30m, and 1h candle aggregation.
- Incremental latest-candle updates from the summary feed plus periodic chart backfill.
- EMA 9, EMA 21, VWAP, compare overlay, saved boxes, levels, trend lines, and notes.
- Replay controls that reveal historical candles step by step.
- Browser-local price alerts stored in `localStorage`.
- Deterministic AI-style analysis for trend, VWAP, volume, range position, and saved zones.

The app uses Yahoo Finance chart data through the local Python server, and can merge FinImpulse summary data when you provide a token. The Windows PowerShell server is kept for local compatibility. For production-grade TradingView-style realtime behavior, replace polling with a licensed market-data WebSocket feed behind your backend, then keep using the same incremental candle-update path in `app.js`.

## Multi-LLM predictor

`multi_llm_stock_predictor.py` captures a chart screenshot every 15 minutes during regular US market hours, sends the same image concurrently to OpenAI, Gemini, and Anthropic vision models, then prints a strict 8-point consensus decision.

Install:

```powershell
python -m pip install -r requirements-predictor.txt
python -m playwright install chromium
```

Set API keys:

```powershell
$env:OPENAI_API_KEY = "YOUR_OPENAI_API_KEY"
$env:GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"
$env:ANTHROPIC_API_KEY = "YOUR_ANTHROPIC_API_KEY"
```

Test the consensus pipeline without API calls:

```powershell
python .\multi_llm_stock_predictor.py --once --mock --input-image .\captures\sample-chart.png
```

Capture the active screen every 15 minutes during market hours:

```powershell
python .\multi_llm_stock_predictor.py --symbol AAPL
```

Capture a cropped chart window:

```powershell
python .\multi_llm_stock_predictor.py --symbol AAPL --region 100,80,1400,850
```

Capture a local chart URL with Playwright:

```powershell
python .\multi_llm_stock_predictor.py --symbol AAPL --chart-url http://localhost:4173 --playwright-selector .chart-panel --playwright-timeframes 1m,5m,30m
```

Use `--once` for a single cycle. Use `--include-after-hours` if you want the loop to ignore the regular 9:30 AM-4:00 PM Eastern market window. The script only prints analysis and consensus labels; it does not place broker orders.
