# StocksAI Market Desk

A professional single-page stock lookup web app for US ticker symbols. Search any listed US stock symbol, view the latest quote, intraday chart, snapshot stats, quick watchlist, and auto-refreshing market data.

## Run

From PowerShell:

```powershell
.\start-server.ps1 -FinImpulseToken "YOUR_FINIMPULSE_TOKEN"
```

Then open `http://localhost:4173`.

Or double-click `run-app.bat`, paste your FinImpulse token, and keep that window open.

The app uses Yahoo Finance chart data and falls back through AllOrigins when the browser blocks direct cross-origin requests. For production use, replace the data function in `app.js` with a paid market-data provider or a small server-side proxy so you control reliability and rate limits.
