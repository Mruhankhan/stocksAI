const form = document.querySelector("#search-form");
const input = document.querySelector("#symbol-input");
const statusEl = document.querySelector("#status");
const canvas = document.querySelector("#price-chart");
const ctx = canvas.getContext("2d");
const rangeButtons = [...document.querySelectorAll("[data-range]")];
const watchlistEl = document.querySelector("#watchlist");

const els = {
  name: document.querySelector("#quote-name"),
  symbol: document.querySelector("#quote-symbol"),
  marketState: document.querySelector("#market-state"),
  lastPrice: document.querySelector("#last-price"),
  changeCard: document.querySelector("#change-card"),
  changeValue: document.querySelector("#change-value"),
  changePercent: document.querySelector("#change-percent"),
  updated: document.querySelector("#last-updated"),
  open: document.querySelector("#stat-open"),
  high: document.querySelector("#stat-high"),
  low: document.querySelector("#stat-low"),
  volume: document.querySelector("#stat-volume"),
  prevClose: document.querySelector("#stat-prev-close"),
  currency: document.querySelector("#stat-currency")
};

const watchSymbols = ["SPY", "QQQ", "DIA", "NVDA", "MSFT", "TSLA"];
let activeSymbol = "AAPL";
let activeRange = "1d";
let refreshTimer;

const ranges = {
  "1d": { interval: "1m", range: "1d" },
  "5d": { interval: "5m", range: "5d" },
  "1mo": { interval: "30m", range: "1mo" },
  "6mo": { interval: "1d", range: "6mo" },
  "1y": { interval: "1d", range: "1y" }
};

function normalizeSymbol(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
}

function money(value, currency = "USD") {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 1000 ? 2 : 4
  }).format(value);
}

function number(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", { notation: value >= 1_000_000 ? "compact" : "standard" }).format(value);
}

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.dataset.type = type;
}

async function fetchJson(url) {
  const direct = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (direct?.ok) return direct.json();

  const proxiedUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const proxied = await fetch(proxiedUrl, { cache: "no-store" });
  if (!proxied.ok) throw new Error(`Market data request failed (${proxied.status})`);
  return proxied.json();
}

async function loadQuote(symbol, range = activeRange) {
  const config = ranges[range] ?? ranges["1d"];
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({
    region: "US",
    lang: "en-US",
    includePrePost: "true",
    interval: config.interval,
    range: config.range,
    corsDomain: "finance.yahoo.com"
  });

  const data = await fetchJson(url.toString());
  const result = data?.chart?.result?.[0];
  const error = data?.chart?.error;
  if (!result) throw new Error(error?.description || `No market data found for ${symbol}`);

  return result;
}

function extractQuote(result) {
  const meta = result.meta ?? {};
  const quote = result.indicators?.quote?.[0] ?? {};
  const timestamps = result.timestamp ?? [];
  const prices = (result.indicators?.quote?.[0]?.close ?? [])
    .map((price, index) => ({ price, time: timestamps[index] }))
    .filter(point => Number.isFinite(point.price) && Number.isFinite(point.time));

  const last = meta.regularMarketPrice ?? prices.at(-1)?.price;
  const previous = meta.previousClose ?? meta.chartPreviousClose;
  const change = Number.isFinite(last) && Number.isFinite(previous) ? last - previous : 0;
  const changePercent = previous ? (change / previous) * 100 : 0;

  return {
    meta,
    prices,
    last,
    previous,
    change,
    changePercent,
    open: quote.open?.find(Number.isFinite) ?? meta.regularMarketDayOpen,
    high: meta.regularMarketDayHigh,
    low: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    currency: meta.currency || "USD"
  };
}

function updateQuote(result) {
  const quote = extractQuote(result);
  const signClass = quote.change > 0 ? "positive" : quote.change < 0 ? "negative" : "neutral";
  const exchangeName = quote.meta.fullExchangeName || quote.meta.exchangeName || "US market";

  els.name.textContent = quote.meta.longName || quote.meta.shortName || exchangeName;
  els.symbol.textContent = quote.meta.symbol || activeSymbol;
  els.marketState.textContent = `${exchangeName} · ${quote.meta.marketState || "Live"}`;
  els.lastPrice.textContent = money(quote.last, quote.currency);
  els.changeValue.textContent = `${quote.change >= 0 ? "+" : ""}${money(quote.change, quote.currency)}`;
  els.changePercent.textContent = `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%`;
  els.changeCard.className = `change ${signClass}`;
  els.updated.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  els.open.textContent = money(quote.open, quote.currency);
  els.high.textContent = money(quote.high, quote.currency);
  els.low.textContent = money(quote.low, quote.currency);
  els.volume.textContent = number(quote.volume);
  els.prevClose.textContent = money(quote.previous, quote.currency);
  els.currency.textContent = quote.currency;

  drawChart(quote.prices, signClass);
  setStatus(`${activeSymbol} updated from Yahoo Finance chart data. Auto-refresh is on.`);
}

function drawChart(points, direction = "neutral") {
  const width = canvas.width;
  const height = canvas.height;
  const pad = 42;
  ctx.clearRect(0, 0, width, height);

  if (points.length < 2) {
    ctx.fillStyle = "#667085";
    ctx.font = "700 22px system-ui";
    ctx.fillText("Not enough chart data for this symbol.", pad, height / 2);
    return;
  }

  const prices = points.map(point => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const color = direction === "negative" ? "#c33131" : direction === "positive" ? "#087443" : "#1f6feb";

  ctx.strokeStyle = "#d9e2ef";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = pad + ((height - pad * 2) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  const xFor = index => pad + (index / (points.length - 1)) * (width - pad * 2);
  const yFor = price => height - pad - ((price - min) / span) * (height - pad * 2);

  const gradient = ctx.createLinearGradient(0, pad, 0, height - pad);
  gradient.addColorStop(0, `${color}33`);
  gradient.addColorStop(1, `${color}00`);

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(width - pad, height - pad);
  ctx.lineTo(pad, height - pad);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.fillStyle = "#667085";
  ctx.font = "700 18px system-ui";
  ctx.fillText(max.toFixed(2), width - pad - 70, pad + 6);
  ctx.fillText(min.toFixed(2), width - pad - 70, height - pad);
}

async function search(symbol, options = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    setStatus("Enter a valid US ticker symbol.");
    return;
  }

  activeSymbol = normalized;
  input.value = normalized;
  setStatus(`Loading ${normalized}...`);

  try {
    const result = await loadQuote(normalized, activeRange);
    updateQuote(result);
    if (!options.skipTimer) startAutoRefresh();
  } catch (error) {
    setStatus(error.message || `Could not load ${normalized}. Try another ticker.`, "error");
  }
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => search(activeSymbol, { skipTimer: true }), 15000);
}

async function loadWatchlist() {
  watchlistEl.innerHTML = "";
  for (const symbol of watchSymbols) {
    const button = document.createElement("button");
    button.className = "watch-item";
    button.type = "button";
    button.innerHTML = `<span class="watch-symbol">${symbol}</span><span class="watch-price">Loading</span>`;
    button.addEventListener("click", () => search(symbol));
    watchlistEl.append(button);

    loadQuote(symbol, "1d")
      .then(result => {
        const quote = extractQuote(result);
        button.querySelector(".watch-price").textContent = money(quote.last, quote.currency);
      })
      .catch(() => {
        button.querySelector(".watch-price").textContent = "--";
      });
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  search(input.value);
});

rangeButtons.forEach(button => {
  button.addEventListener("click", () => {
    rangeButtons.forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    activeRange = button.dataset.range;
    search(activeSymbol);
  });
});

window.addEventListener("resize", () => search(activeSymbol, { skipTimer: true }));

search(activeSymbol);
loadWatchlist();
