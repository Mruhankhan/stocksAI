const form = document.querySelector("#search-form");
const input = document.querySelector("#symbol-input");
const symbolOptions = document.querySelector("#symbol-options");
const statusEl = document.querySelector("#status");
const canvas = document.querySelector("#price-chart");
const ctx = canvas.getContext("2d");
const intervalButtons = [...document.querySelectorAll("[data-interval]")];
const toolButtons = [...document.querySelectorAll("[data-tool]")];
const watchlistEl = document.querySelector("#watchlist");
const compareForm = document.querySelector("#compare-form");
const compareInput = document.querySelector("#compare-input");
const clearCompareButton = document.querySelector("#clear-compare");
const clearDrawingsButton = document.querySelector("#clear-drawings");
const dataWindow = document.querySelector("#data-window");
const ema9Toggle = document.querySelector("#ema9-toggle");
const ema21Toggle = document.querySelector("#ema21-toggle");
const vwapToggle = document.querySelector("#vwap-toggle");
const scaleInput = document.querySelector("#scale-input");
const replayStartButton = document.querySelector("#replay-start");
const replayStepButton = document.querySelector("#replay-step");
const replayStopButton = document.querySelector("#replay-stop");
const alertForm = document.querySelector("#alert-form");
const alertCondition = document.querySelector("#alert-condition");
const alertPrice = document.querySelector("#alert-price");
const alertList = document.querySelector("#alert-list");
const aiAnalyzeButton = document.querySelector("#ai-analyze");
const aiOutput = document.querySelector("#ai-output");

const els = {
  name: document.querySelector("#quote-name"),
  symbol: document.querySelector("#quote-symbol"),
  range: document.querySelector("#quote-range"),
  exchange: document.querySelector("#exchange"),
  open: document.querySelector("#ohlc-open"),
  high: document.querySelector("#ohlc-high"),
  low: document.querySelector("#ohlc-low"),
  close: document.querySelector("#ohlc-close"),
  change: document.querySelector("#ohlc-change"),
  volume: document.querySelector("#volume-value"),
  timerLabel: document.querySelector("#candle-label"),
  timer: document.querySelector("#candle-timer"),
  marketState: document.querySelector("#market-state")
};

const watchSymbols = ["SPY", "QQQ", "DIA", "AAPL", "NVDA", "MSFT", "TSLA"];
const REFRESH_MS = 5000;
const BACKFILL_MS = 60000;
const AXIS_WIDTH = 76;
const MIN_BAR_SPACING = 3;
const MAX_BAR_SPACING = 48;
const intervalSeconds = { "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800, "1h": 3600 };
const requestFrame = window.requestAnimationFrame?.bind(window) || (callback => setTimeout(callback, 16));

let activeSymbol = "AAPL";
let activeInterval = "1m";
let activeTool = "cursor";
let fullCandles = [];
let lastCandles = [];
let compareSymbol = "";
let compareCandles = [];
let latestSummary;
let refreshTimer;
let backfillTimer;
let countdownTimer;
let inFlightRequest;
let isDragging = false;
let isDrawing = false;
let dragStartX = 0;
let dragStartFirstIndex = 0;
let symbolSearchTimer;
let cursorPoint = null;
let drawingDraft = null;
let pricePadding = Number(scaleInput.value);
let chartFrame = null;
let drawings = loadDrawings();
let alerts = loadAlerts();
let renderScheduled = false;
let lastKnownVolume = 0;
let barSpacing = 7;
let firstVisibleIndex = 0;
let followLive = true;
let replayMode = false;
let replayIndex = 0;
let replayTimer;
let refreshFailures = 0;
let lastAnalysisSymbol = "";

function normalizeSymbol(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function fmtPrice(value) {
  const number = asNumber(value);
  if (number === undefined) return "--";
  return number.toFixed(2);
}

function fmtVolume(value) {
  const number = asNumber(value);
  if (number === undefined) return "--";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(number);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function defaultBarSpacing(interval = activeInterval) {
  if (interval === "1m") return 7;
  if (interval === "1h") return 10;
  return 8;
}

function plotWidthFromCanvas() {
  const rect = canvas.getBoundingClientRect();
  return Math.max(1, rect.width - AXIS_WIDTH);
}

function maxFirstIndex(candles = lastCandles) {
  const visibleBars = plotWidthFromCanvas() / Math.max(MIN_BAR_SPACING, barSpacing);
  return Math.max(0, candles.length - visibleBars);
}

function clampViewport(candles = lastCandles) {
  if (!candles.length) {
    firstVisibleIndex = 0;
    return;
  }

  const maxFirst = maxFirstIndex(candles);
  if (followLive) {
    firstVisibleIndex = maxFirst;
  } else {
    firstVisibleIndex = clamp(firstVisibleIndex, 0, maxFirst);
    followLive = maxFirst - firstVisibleIndex < 1.5;
  }
}

function resetViewport() {
  barSpacing = defaultBarSpacing();
  followLive = true;
  clampViewport();
}

function setReplayControls() {
  replayStartButton.classList.toggle("active", replayMode);
  replayStopButton.classList.toggle("active", !replayMode);
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestFrame(() => {
    renderScheduled = false;
    clampViewport();
    drawChart(lastCandles);
  });
}

function setCandleData(candles, options = {}) {
  fullCandles = candles;
  lastCandles = replayMode ? candles.slice(0, replayIndex || candles.length) : candles.slice();
  if (options.resetVolume !== false) {
    lastKnownVolume = 0;
  }
  if (options.resetViewport !== false) {
    resetViewport();
  }
  scheduleRender();
}

function updateLatestCandle(candle) {
  if (!candle) return;
  const lastIndex = lastCandles.length - 1;

  if (lastIndex >= 0 && lastCandles[lastIndex].time === candle.time) {
    lastCandles[lastIndex] = candle;
  } else if (lastIndex === -1 || candle.time > lastCandles[lastIndex].time) {
    lastCandles.push(candle);
  } else {
    const index = lastCandles.findIndex(item => item.time === candle.time);
    if (index !== -1) lastCandles[index] = candle;
  }
  if (!replayMode) {
    const fullIndex = fullCandles.findIndex(item => item.time === candle.time);
    if (fullIndex !== -1) {
      fullCandles[fullIndex] = candle;
    } else if (!fullCandles.length || candle.time > fullCandles.at(-1).time) {
      fullCandles.push(candle);
    }
  }
  checkAlerts(candle.close);
  scheduleRender();
}

function applyTradeToCandles(trade) {
  const tradePrice = asNumber(trade?.price);
  if (tradePrice === undefined) return null;

  const intervalMs = intervalSeconds[activeInterval] * 1000;
  const candleTime = Math.floor((trade.timestamp || Date.now()) / intervalMs) * (intervalMs / 1000);
  const size = Math.max(0, asNumber(trade.size) || 0);
  const last = lastCandles.at(-1);

  if (!last || candleTime > last.time) {
    const candle = {
      time: candleTime,
      open: tradePrice,
      high: tradePrice,
      low: tradePrice,
      close: tradePrice,
      volume: size
    };
    updateLatestCandle(candle);
    followLive = true;
    return candle;
  }

  if (candleTime < last.time) {
    return last;
  }

  const updated = {
    ...last,
    high: Math.max(last.high, tradePrice),
    low: Math.min(last.low, tradePrice),
    close: tradePrice,
    volume: (last.volume || 0) + size
  };
  updateLatestCandle(updated);
  return updated;
}

function tradeFromSummary(summary, price) {
  const currentVolume = getSummaryVolume(summary);
  const size = currentVolume === undefined ? 0 : Math.max(0, currentVolume - (lastKnownVolume || 0));
  if (currentVolume !== undefined) lastKnownVolume = currentVolume;

  return {
    price,
    size,
    timestamp: getSummaryTime(summary) * 1000
  };
}

function loadDrawings() {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("stocksai.drawings") || "[]");
  } catch {
    return [];
  }
}

function saveDrawings() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("stocksai.drawings", JSON.stringify(drawings));
}

function loadAlerts() {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("stocksai.alerts") || "[]");
  } catch {
    return [];
  }
}

function saveAlerts() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("stocksai.alerts", JSON.stringify(alerts));
}

function renderAlerts() {
  alertList.innerHTML = "";
  const symbolAlerts = alerts.filter(item => item.symbol === activeSymbol);
  if (!symbolAlerts.length) {
    alertList.textContent = "No alerts";
    return;
  }

  symbolAlerts.slice(-4).forEach(item => {
    const pill = document.createElement("span");
    pill.className = `alert-pill${item.triggered ? " triggered" : ""}`;
    pill.textContent = `${item.condition === "above" ? ">" : "<"} ${fmtPrice(item.price)}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.addEventListener("click", () => {
      alerts = alerts.filter(alert => alert.id !== item.id);
      saveAlerts();
      renderAlerts();
    });

    pill.append(remove);
    alertList.append(pill);
  });
}

function checkAlerts(price) {
  if (!Number.isFinite(price)) return;
  let triggered = false;
  alerts = alerts.map(item => {
    if (item.symbol !== activeSymbol || item.triggered) return item;
    const hit = item.condition === "above" ? price >= item.price : price <= item.price;
    if (!hit) return item;
    triggered = true;
    return { ...item, triggered: true, triggeredAt: Date.now() };
  });

  if (triggered) {
    saveAlerts();
    renderAlerts();
    setStatus(`${activeSymbol} price alert triggered at ${fmtPrice(price)}.`);
  }
}

function drawingKey() {
  return `${activeSymbol}:${activeInterval}`;
}

function visibleDrawings() {
  const key = drawingKey();
  return drawings.filter(item => item.key === key);
}

function candleAtX(x) {
  if (!chartFrame) return null;
  if (x < 0 || x > chartFrame.plotWidth) return null;
  const index = Math.round(chartFrame.firstVisibleIndex + (x / chartFrame.barSpacing) - 0.5);
  if (index < 0 || index >= chartFrame.candles.length) return null;
  return chartFrame.candles[index];
}

function priceAtY(y) {
  if (!chartFrame) return null;
  const ratio = (y - chartFrame.topPad) / chartFrame.chartHeight;
  return chartFrame.maxPrice - ratio * chartFrame.priceSpan;
}

function xForTime(time) {
  if (!chartFrame) return null;
  const index = chartFrame.candles.findIndex(candle => candle.time === time);
  if (index === -1) return null;
  return chartFrame.xForIndex(index);
}

function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json();
}

async function loadSummary(symbol, signal) {
  const data = await fetchJson(`/api/summary?symbol=${encodeURIComponent(symbol)}`, signal);
  return data.result || data;
}

async function loadChart(symbol, interval, signal) {
  const data = await fetchJson(`/api/chart?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`, signal);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data found for ${symbol}`);
  return result;
}

async function loadCompare(symbol) {
  if (!symbol) {
    compareSymbol = "";
    compareCandles = [];
    scheduleRender();
    return;
  }

  const chart = await loadChart(symbol, activeInterval);
  compareSymbol = symbol;
  compareCandles = extractYahooCandles(chart, activeInterval);
  setStatus(`Comparing ${activeSymbol} with ${compareSymbol}.`);
  scheduleRender();
}

async function loadSymbolSuggestions(query) {
  const normalized = normalizeSymbol(query);
  if (!normalized) {
    symbolOptions.innerHTML = "";
    return;
  }

  const symbols = await fetchJson(`/api/symbols?q=${encodeURIComponent(normalized)}`);
  symbolOptions.innerHTML = "";
  symbols.forEach(item => {
    const option = document.createElement("option");
    option.value = item.symbol;
    option.label = `${item.symbol} - ${item.description} (${item.exchange})`;
    symbolOptions.append(option);
  });
}

function bucketStart(seconds, interval = activeInterval) {
  const size = intervalSeconds[interval];
  return Math.floor(seconds / size) * size;
}

function aggregateCandles(candles, interval = activeInterval) {
  if (interval === "1m") return candles;
  const grouped = new Map();

  candles.forEach(candle => {
    const key = bucketStart(candle.time, interval);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...candle, time: key });
      return;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume = (existing.volume || 0) + (candle.volume || 0);
  });

  return [...grouped.values()].sort((a, b) => a.time - b.time);
}

function extractYahooCandles(result, interval = activeInterval) {
  const quote = result.indicators?.quote?.[0] ?? {};
  const timestamps = result.timestamp ?? [];
  const candles = timestamps.map((time, index) => ({
    time,
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0
  })).filter(candle =>
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close)
  );
  return aggregateCandles(candles, interval);
}

function mergeCandles(existing, incoming) {
  const byTime = new Map(existing.map(candle => [candle.time, candle]));
  incoming.forEach(candle => byTime.set(candle.time, candle));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function backfillRecentCandles() {
  if (replayMode) return;
  try {
    const chart = await loadChart(activeSymbol, activeInterval);
    const incoming = extractYahooCandles(chart, activeInterval);
    const merged = mergeCandles(fullCandles, incoming);
    setCandleData(merged, { resetViewport: false, resetVolume: false });
    refreshFailures = 0;
  } catch (error) {
    refreshFailures += 1;
    if (refreshFailures > 1) {
      setStatus(error.message || `Waiting to reconnect ${activeSymbol} data.`);
    }
  }
}

function getSummaryPrice(summary) {
  const session = getMarketSession(summary);
  if (!session.allowsCandles) {
    return firstNumber(
      summary.regular_market_price,
      summary.regularMarketPrice,
      summary.previous_close,
      summary.current_price,
      summary.close
    );
  }

  return firstNumber(
    summary.current_price,
    summary.regular_market_price,
    summary.regularMarketPrice,
    summary.close,
    summary.previous_close
  );
}

function getSummaryVolume(summary) {
  return firstNumber(summary.regular_market_volume, summary.regularMarketVolume, summary.volume);
}

function timestampSeconds(value) {
  const number = Number(value);
  if (Number.isFinite(number)) {
    return Math.floor(number > 1_000_000_000_000 ? number / 1000 : number);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function getSummaryTime(summary) {
  return timestampSeconds(
    summary.regular_market_time ||
    summary.regularMarketTime ||
    summary.post_market_time ||
    summary.postMarketTime ||
    summary.pre_market_time ||
    summary.preMarketTime ||
    summary.insert_time
  ) || Math.floor(Date.now() / 1000);
}

function inferUSMarketSession() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type)?.value;
  const weekday = value("weekday");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const total = hour * 60 + minute;
  const isWeekday = !["Sat", "Sun"].includes(weekday);

  if (!isWeekday) return { key: "closed", label: "Market closed", allowsCandles: false };
  if (total >= 4 * 60 && total < 9 * 60 + 30) return { key: "pre", label: "Pre-market", allowsCandles: false };
  if (total >= 9 * 60 + 30 && total < 16 * 60) return { key: "regular", label: "Regular session", allowsCandles: true };
  if (total >= 16 * 60 && total < 20 * 60) return { key: "post", label: "After hours", allowsCandles: false };
  return { key: "closed", label: "Market closed", allowsCandles: false };
}

function getMarketSession(summary = latestSummary) {
  const raw = String(summary?.market_state || summary?.marketState || summary?.market_session || "").toUpperCase();
  if (raw === "REGULAR") return { key: "regular", label: "Regular session", allowsCandles: true };
  if (raw === "PRE") return { key: "pre", label: "Pre-market", allowsCandles: false };
  if (raw === "POST") return { key: "post", label: "After hours", allowsCandles: false };
  if (raw === "PREPRE" || raw === "POSTPOST" || raw.includes("CLOSED") || raw === "CLOSED") {
    return { key: "closed", label: "Market closed", allowsCandles: false };
  }
  return inferUSMarketSession();
}

function getSessionPriceLabel(summary) {
  const session = getMarketSession(summary);
  const prePrice = firstNumber(summary.pre_market_price, summary.preMarketPrice);
  const postPrice = firstNumber(summary.post_market_price, summary.postMarketPrice);

  if (session.key === "pre" && prePrice !== undefined) return `Pre ${fmtPrice(prePrice)}`;
  if (session.key === "post" && postPrice !== undefined) return `After hours ${fmtPrice(postPrice)}`;
  if (session.key === "closed" && postPrice !== undefined) return `Closed - AH ${fmtPrice(postPrice)}`;
  if (session.key === "closed" && prePrice !== undefined) return `Closed - Pre ${fmtPrice(prePrice)}`;
  return session.label;
}

function applySummary(summary, isLive = false) {
  latestSummary = summary;
  const price = getSummaryPrice(summary);
  if (!Number.isFinite(price)) return;

  const session = getMarketSession(summary);
  let last = lastCandles.at(-1);

  if (!last) {
    last = applyTradeToCandles({
      price,
      size: getSummaryVolume(summary) || 0,
      timestamp: getSummaryTime(summary) * 1000
    });
  } else if (session.allowsCandles) {
    if (isLive) {
      last = applyTradeToCandles(tradeFromSummary(summary, price));
    } else {
      const currentVolume = getSummaryVolume(summary);
      if (currentVolume !== undefined) lastKnownVolume = currentVolume;
      last = applyTradeToCandles({
        price,
        size: 0,
        timestamp: getSummaryTime(summary) * 1000
      });
    }
  }

  last = last || lastCandles.at(-1) || { open: price, high: price, low: price, close: price, volume: getSummaryVolume(summary) || 0 };

  const previous = firstNumber(summary.regular_market_previous_close, summary.previous_close, lastCandles.at(-2)?.close, price);
  const change = price - previous;
  const changePercent = previous ? (change / previous) * 100 : 0;
  const signClass = change < 0 ? "negative" : "positive";

  activeSymbol = summary.symbol || activeSymbol;
  input.value = activeSymbol;
  els.name.textContent = summary.display_name || summary.short_name || summary.long_name || activeSymbol;
  els.symbol.textContent = activeSymbol;
  els.range.textContent = activeInterval;
  els.exchange.textContent = summary.full_exchange_name || summary.exchange || "US";
  els.open.textContent = fmtPrice(firstNumber(summary.regular_market_open, summary.open, last.open));
  els.high.textContent = fmtPrice(firstNumber(summary.regular_market_day_high, summary.day_high, last.high));
  els.low.textContent = fmtPrice(firstNumber(summary.regular_market_day_low, summary.day_low, last.low));
  els.close.textContent = fmtPrice(price);
  els.volume.textContent = fmtVolume(firstNumber(getSummaryVolume(summary), last.volume));
  els.change.textContent = `${change >= 0 ? "+" : ""}${fmtPrice(change)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`;
  els.change.className = `quote-change ${signClass}`;
  els.marketState.textContent = isLive ? `${getSessionPriceLabel(summary)} update` : getSessionPriceLabel(summary);
  checkAlerts(price);
  if (lastAnalysisSymbol === activeSymbol) {
    updateAnalysis();
  }
  scheduleRender();
}

function summaryFromLastCandle(symbol) {
  const last = lastCandles.at(-1);
  const previous = lastCandles.at(-2)?.close ?? last?.open ?? last?.close;
  return {
    symbol,
    display_name: symbol,
    current_price: last?.close,
    regular_market_price: last?.close,
    previous_close: previous,
    regular_market_previous_close: previous,
    open: last?.open,
    regular_market_open: last?.open,
    day_high: last?.high,
    regular_market_day_high: last?.high,
    day_low: last?.low,
    regular_market_day_low: last?.low,
    volume: last?.volume,
    regular_market_volume: last?.volume,
    full_exchange_name: "Chart fallback"
  };
}

function updateCountdown() {
  const session = getMarketSession();
  if (!session.allowsCandles) {
    if (session.key === "pre") {
      els.timerLabel.textContent = "Session";
      els.timer.textContent = "Pre-market";
    } else if (session.key === "post") {
      els.timerLabel.textContent = "Session";
      els.timer.textContent = "After hours";
    } else {
      els.timerLabel.textContent = "Market";
      els.timer.textContent = "Closed";
    }
    return;
  }

  const size = intervalSeconds[activeInterval];
  const now = Math.floor(Date.now() / 1000);
  const remaining = size - (now % size);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  els.timerLabel.textContent = "Next candle";
  els.timer.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(600, Math.floor(rect.width * scale));
  canvas.height = Math.max(360, Math.floor(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { width: rect.width, height: rect.height };
}

function calculateEma(candles, length) {
  const k = 2 / (length + 1);
  let ema = candles[0]?.close;
  return candles.map(candle => {
    ema = ema == null ? candle.close : candle.close * k + ema * (1 - k);
    return { time: candle.time, value: ema };
  });
}

function calculateVwap(candles) {
  let pv = 0;
  let volume = 0;
  return candles.map(candle => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const candleVolume = candle.volume || 1;
    pv += typical * candleVolume;
    volume += candleVolume;
    return { time: candle.time, value: pv / volume };
  });
}

function drawSeries(series, color, width = 2) {
  if (!chartFrame || series.length < 2) return;
  ctx.beginPath();
  let started = false;
  chartFrame.visibleCandles.forEach((candle, index) => {
    const point = series.find(item => item.time === candle.time);
    if (!point || !Number.isFinite(point.value)) return;
    const x = chartFrame.xFor(index);
    const y = chartFrame.yFor(point.value);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawIndicators(candles) {
  if (ema9Toggle.checked) drawSeries(calculateEma(candles, 9), "#f59e0b", 2);
  if (ema21Toggle.checked) drawSeries(calculateEma(candles, 21), "#7c3aed", 2);
  if (vwapToggle.checked) drawSeries(calculateVwap(candles), "#2563eb", 2);
}

function drawCompareOverlay() {
  if (!chartFrame || !compareSymbol || compareCandles.length < 2) return;
  const compareByTime = new Map(compareCandles.map(candle => [candle.time, candle]));
  const paired = chartFrame.visibleCandles
    .map(candle => ({ main: candle, compare: compareByTime.get(candle.time) }))
    .filter(item => item.compare);
  if (paired.length < 2) return;

  const mainBase = paired[0].main.close;
  const compareBase = paired[0].compare.close;
  const normalized = paired.map(item => ({
    time: item.main.time,
    value: mainBase * (item.compare.close / compareBase)
  })).filter(point => Number.isFinite(point.value) && Number.isFinite(point.time));

  drawSeries(normalized, "#0ea5e9", 2.5);
  ctx.fillStyle = "#0ea5e9";
  ctx.font = "800 12px system-ui";
  ctx.fillText(`Compare: ${compareSymbol}`, 16, 22);
}

function drawDrawing(item) {
  if (!chartFrame) return;
  const p1 = item.points?.[0];
  const p2 = item.points?.[1];
  if (!p1) return;

  const x1 = xForTime(p1.time);
  const y1 = chartFrame.yFor(p1.price);
  const x2 = p2 ? xForTime(p2.time) : null;
  const y2 = p2 ? chartFrame.yFor(p2.price) : null;

  ctx.lineWidth = 2;
  ctx.strokeStyle = item.color || "#2563eb";
  ctx.fillStyle = item.color || "#2563eb";

  if (item.type === "level") {
    ctx.beginPath();
    ctx.moveTo(Math.max(0, x1 ?? 0), y1);
    ctx.lineTo(chartFrame.plotWidth, y1);
    ctx.stroke();
    return;
  }

  if (x1 == null) return;

  if (item.type === "box" && x2 != null) {
    ctx.globalAlpha = 0.14;
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.globalAlpha = 1;
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  }

  if (item.type === "trend" && x2 != null) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  if (item.type === "text") {
    ctx.font = "800 13px system-ui";
    ctx.fillText(item.text || "Note", x1 + 6, y1 - 6);
  }
}

function drawDrawingLayer() {
  visibleDrawings().forEach(drawDrawing);
  if (drawingDraft) drawDrawing(drawingDraft);
}

function drawCrosshair() {
  if (!chartFrame || !cursorPoint) {
    dataWindow.textContent = "Move over chart";
    return;
  }

  const candle = candleAtX(cursorPoint.x);
  const price = priceAtY(cursorPoint.y);
  if (!candle || !Number.isFinite(price)) return;

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const candleIndex = chartFrame.candles.indexOf(candle);
  const candleX = chartFrame.xForIndex(candleIndex);
  ctx.moveTo(candleX, 0);
  ctx.lineTo(candleX, chartFrame.height);
  ctx.moveTo(0, cursorPoint.y);
  ctx.lineTo(chartFrame.plotWidth, cursorPoint.y);
  ctx.stroke();
  ctx.setLineDash([]);

  dataWindow.innerHTML = `
    <strong>${activeSymbol}</strong> ${formatTime(candle.time)}<br>
    O ${fmtPrice(candle.open)} H ${fmtPrice(candle.high)} L ${fmtPrice(candle.low)} C ${fmtPrice(candle.close)}<br>
    Cursor ${fmtPrice(price)} Vol ${fmtVolume(candle.volume)}
  `;
}

function drawChart(candles) {
  const { width, height } = sizeCanvas();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (candles.length < 2) {
    ctx.fillStyle = "#667085";
    ctx.font = "700 18px system-ui";
    ctx.fillText("Waiting for candle data...", 24, 60);
    return;
  }

  const axisWidth = AXIS_WIDTH;
  const topPad = 18;
  const volumeHeight = Math.max(110, height * 0.2);
  const bottomPad = 24;
  const chartHeight = height - topPad - volumeHeight - bottomPad;
  const plotWidth = Math.max(1, width - axisWidth);

  barSpacing = clamp(barSpacing, MIN_BAR_SPACING, MAX_BAR_SPACING);
  clampViewport(candles);

  const firstIndex = Math.max(0, Math.floor(firstVisibleIndex) - 2);
  const lastIndex = Math.min(candles.length, Math.ceil(firstVisibleIndex + plotWidth / barSpacing) + 2);
  const visibleCandles = candles.slice(firstIndex, lastIndex);
  if (!visibleCandles.length) return;

  let maxPrice = Math.max(...visibleCandles.map(candle => candle.high));
  let minPrice = Math.min(...visibleCandles.map(candle => candle.low));
  const rawSpan = maxPrice - minPrice || 1;
  maxPrice += rawSpan * pricePadding;
  minPrice -= rawSpan * pricePadding;
  const priceSpan = maxPrice - minPrice || 1;
  const maxVolume = Math.max(...visibleCandles.map(candle => candle.volume || 0), 1);
  const bodyWidth = Math.max(2, Math.min(28, barSpacing * 0.68));
  const yFor = price => topPad + ((maxPrice - price) / priceSpan) * chartHeight;
  const xForIndex = index => (index - firstVisibleIndex) * barSpacing + barSpacing / 2;
  const xFor = index => xForIndex(firstIndex + index);
  chartFrame = {
    candles,
    visibleCandles,
    firstIndex,
    firstVisibleIndex,
    plotWidth,
    topPad,
    chartHeight,
    priceSpan,
    maxPrice,
    minPrice,
    barSpacing,
    firstX: xFor(0),
    xForIndex,
    xFor,
    yFor,
    width,
    height
  };

  ctx.strokeStyle = "#edf0f2";
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui";
  ctx.fillStyle = "#8d96a0";

  for (let i = 0; i <= 8; i += 1) {
    const y = topPad + (chartHeight / 8) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotWidth, y);
    ctx.stroke();
    const price = maxPrice - (priceSpan / 8) * i;
    ctx.fillText(price.toFixed(2), plotWidth + 10, y + 4);
  }

  for (let i = 0; i <= 10; i += 1) {
    const x = (plotWidth / 10) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, plotWidth, height - bottomPad + 4);
  ctx.clip();

  visibleCandles.forEach((candle, index) => {
    const x = xFor(index);
    if (x < -barSpacing || x > plotWidth + barSpacing) return;
    const up = candle.close >= candle.open;
    const color = up ? "#089981" : "#f23645";
    const yOpen = yFor(candle.open);
    const yClose = yFor(candle.close);
    const yHigh = yFor(candle.high);
    const yLow = yFor(candle.low);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);

    const volTop = height - bottomPad - ((candle.volume || 0) / maxVolume) * volumeHeight;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x - bodyWidth / 2, volTop, bodyWidth, height - bottomPad - volTop);
    ctx.globalAlpha = 1;
  });

  drawIndicators(candles);
  drawCompareOverlay();
  drawDrawingLayer();
  ctx.restore();

  const last = visibleCandles.at(-1);
  const lastY = yFor(last.close);
  ctx.setLineDash([1, 3]);
  ctx.strokeStyle = "#089981";
  ctx.beginPath();
  ctx.moveTo(0, lastY);
  ctx.lineTo(plotWidth, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#089981";
  ctx.fillRect(plotWidth + 8, lastY - 11, 58, 22);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 12px system-ui";
  ctx.fillText(last.close.toFixed(2), plotWidth + 13, lastY + 4);

  ctx.fillStyle = "#8d96a0";
  ctx.font = "12px system-ui";
  const labelEvery = Math.max(1, Math.ceil(90 / barSpacing));
  visibleCandles.forEach((candle, index) => {
    const absoluteIndex = firstIndex + index;
    if (absoluteIndex % labelEvery !== 0) return;
    const x = xFor(index);
    if (x < 12 || x > plotWidth - 30) return;
    ctx.fillText(formatTime(candle.time).replace(",", ""), x - 26, height - 7);
  });

  drawCrosshair();
}

function pointFromEvent(event) {
  const candle = candleAtX(event.offsetX);
  const price = priceAtY(event.offsetY);
  if (!candle || !Number.isFinite(price)) return null;
  return { time: candle.time, price };
}

function replayStep() {
  if (!replayMode || replayIndex >= fullCandles.length) {
    stopReplay();
    return;
  }

  updateLatestCandle(fullCandles[replayIndex]);
  replayIndex += 1;
  followLive = true;
  if (replayIndex >= fullCandles.length) {
    stopReplay();
  }
}

function startReplay() {
  if (fullCandles.length < 30) {
    setStatus("Load more candles before replay.");
    return;
  }

  clearInterval(refreshTimer);
  clearInterval(backfillTimer);
  replayMode = true;
  replayIndex = Math.max(20, Math.floor(fullCandles.length * 0.65));
  lastCandles = fullCandles.slice(0, replayIndex);
  followLive = true;
  setReplayControls();
  setStatus(`${activeSymbol} replay running from ${formatTime(lastCandles.at(-1).time)}.`);
  scheduleRender();

  clearInterval(replayTimer);
  replayTimer = setInterval(replayStep, 700);
}

function stopReplay(options = {}) {
  clearInterval(replayTimer);
  const wasReplay = replayMode;
  replayMode = false;
  if (fullCandles.length) {
    lastCandles = fullCandles.slice();
  }
  followLive = true;
  setReplayControls();
  scheduleRender();
  if (wasReplay && options.resumeLive !== false) {
    startAutoRefresh();
    setStatus(`${activeSymbol} live view restored.`);
  }
}

function average(values) {
  const clean = values.filter(value => Number.isFinite(value));
  if (!clean.length) return undefined;
  return clean.reduce((total, value) => total + value, 0) / clean.length;
}

function generateAnalysis() {
  if (lastCandles.length < 5) {
    return "Need more candles before analysis.";
  }

  const last = lastCandles.at(-1);
  const previous = lastCandles.at(-2);
  const recent = lastCandles.slice(-30);
  const ema9 = calculateEma(lastCandles, 9).at(-1)?.value;
  const ema21 = calculateEma(lastCandles, 21).at(-1)?.value;
  const vwap = calculateVwap(lastCandles).at(-1)?.value;
  const recentHigh = Math.max(...recent.map(candle => candle.high));
  const recentLow = Math.min(...recent.map(candle => candle.low));
  const avgVolume = average(recent.slice(0, -1).map(candle => candle.volume || 0)) || 0;
  const volumeRatio = avgVolume ? (last.volume || 0) / avgVolume : 0;
  const candleMove = last.close - previous.close;
  const trend = ema9 && ema21
    ? ema9 > ema21 ? "short-term trend is above EMA 21" : "short-term trend is below EMA 21"
    : "EMA trend is forming";
  const vwapPosition = vwap
    ? last.close >= vwap ? "price is above VWAP" : "price is below VWAP"
    : "VWAP is forming";
  const rangePosition = last.close >= recentHigh * 0.997
    ? "testing the recent high"
    : last.close <= recentLow * 1.003
      ? "near the recent low"
      : "inside the recent range";
  const volumeText = volumeRatio >= 1.5
    ? `volume is elevated at ${volumeRatio.toFixed(1)}x recent pace`
    : "volume is near normal pace";
  const zoneCount = visibleDrawings().filter(item => item.type === "box" || item.type === "level").length;
  const zoneText = zoneCount ? `${zoneCount} saved zone${zoneCount === 1 ? "" : "s"} on this interval` : "no saved zones on this interval";
  const direction = candleMove >= 0 ? "green" : "red";

  lastAnalysisSymbol = activeSymbol;
  return `${activeSymbol} ${activeInterval}: latest candle is ${direction} by ${fmtPrice(Math.abs(candleMove))}; ${trend}; ${vwapPosition}; ${rangePosition}; ${volumeText}; ${zoneText}.`;
}

function updateAnalysis() {
  aiOutput.textContent = generateAnalysis();
}

async function search(symbol, options = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    setStatus("Enter a valid NYSE or Nasdaq ticker.");
    return;
  }

  activeSymbol = normalized;
  input.value = normalized;
  if (!options.silent) setStatus(`Loading ${normalized}...`);
  if (replayMode) {
    stopReplay({ resumeLive: false });
  }

  try {
    inFlightRequest?.abort();
    inFlightRequest = new AbortController();
    const chart = await loadChart(normalized, activeInterval, inFlightRequest.signal);
    setCandleData(extractYahooCandles(chart, activeInterval));
    try {
      const summary = await loadSummary(normalized, inFlightRequest.signal);
      applySummary(summary);
    } catch {
      applySummary(summaryFromLastCandle(normalized));
      setStatus(`${normalized} chart loaded. Summary feed unavailable, using chart fallback.`);
    }
    if (compareSymbol) {
      await loadCompare(compareSymbol);
    }
    startAutoRefresh();
    startCountdown();
    renderAlerts();
    updateAnalysis();
    const session = getMarketSession();
    setStatus(session.allowsCandles
      ? `${normalized} updating every 5 seconds. ${activeInterval} candle timer is live.`
      : `${normalized} loaded. Market is closed, candle countdown is paused.`);
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(error.message || `Could not load ${normalized}.`);
  }
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  clearInterval(backfillTimer);
  refreshTimer = setInterval(async () => {
    if (replayMode) return;
    try {
      const summary = await loadSummary(activeSymbol);
      applySummary(summary, true);
      refreshFailures = 0;
    } catch (error) {
      refreshFailures += 1;
      setStatus(error.message || `Could not refresh ${activeSymbol}.`);
      if (refreshFailures > 1) {
        backfillRecentCandles();
      }
    }
  }, REFRESH_MS);
  backfillTimer = setInterval(backfillRecentCandles, BACKFILL_MS);
}

function startCountdown() {
  clearInterval(countdownTimer);
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);
}

function loadWatchlist() {
  watchlistEl.innerHTML = "";
  watchSymbols.forEach(symbol => {
    const button = document.createElement("button");
    button.className = "watch-item";
    button.type = "button";
    button.textContent = symbol;
    button.addEventListener("click", () => search(symbol));
    watchlistEl.append(button);
  });
}

form.addEventListener("submit", event => {
  event.preventDefault();
  search(input.value);
});

input.addEventListener("input", () => {
  clearTimeout(symbolSearchTimer);
  symbolSearchTimer = setTimeout(() => loadSymbolSuggestions(input.value), 150);
});

compareInput.addEventListener("input", () => {
  clearTimeout(symbolSearchTimer);
  symbolSearchTimer = setTimeout(() => loadSymbolSuggestions(compareInput.value), 150);
});

compareForm.addEventListener("submit", event => {
  event.preventDefault();
  const symbol = normalizeSymbol(compareInput.value);
  if (symbol && symbol !== activeSymbol) {
    loadCompare(symbol).catch(error => setStatus(error.message || `Could not compare ${symbol}.`));
  }
});

clearCompareButton.addEventListener("click", () => {
  compareInput.value = "";
  loadCompare("");
});

toolButtons.forEach(button => {
  button.addEventListener("click", () => {
    toolButtons.forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    activeTool = button.dataset.tool;
    drawingDraft = null;
    scheduleRender();
  });
});

clearDrawingsButton.addEventListener("click", () => {
  drawings = drawings.filter(item => item.key !== drawingKey());
  saveDrawings();
  updateAnalysis();
  scheduleRender();
});

[ema9Toggle, ema21Toggle, vwapToggle].forEach(toggle => {
  toggle.addEventListener("change", scheduleRender);
});

scaleInput.addEventListener("input", () => {
  pricePadding = Number(scaleInput.value);
  scheduleRender();
});

replayStartButton.addEventListener("click", startReplay);

replayStepButton.addEventListener("click", () => {
  if (!replayMode) {
    startReplay();
    clearInterval(replayTimer);
  }
  replayStep();
});

replayStopButton.addEventListener("click", () => stopReplay());

alertForm.addEventListener("submit", event => {
  event.preventDefault();
  const price = asNumber(alertPrice.value);
  if (!Number.isFinite(price)) {
    setStatus("Enter a valid alert price.");
    return;
  }

  alerts.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    symbol: activeSymbol,
    condition: alertCondition.value,
    price,
    triggered: false,
    createdAt: Date.now()
  });
  alertPrice.value = "";
  saveAlerts();
  renderAlerts();
  setStatus(`${activeSymbol} alert saved at ${fmtPrice(price)}.`);
});

aiAnalyzeButton.addEventListener("click", updateAnalysis);

intervalButtons.forEach(button => {
  button.addEventListener("click", () => {
    intervalButtons.forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    activeInterval = button.dataset.interval;
    barSpacing = defaultBarSpacing(activeInterval);
    followLive = true;
    search(activeSymbol);
  });
});

window.addEventListener("resize", scheduleRender);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    backfillRecentCandles();
  }
});

canvas.addEventListener("wheel", event => {
  event.preventDefault();
  if (lastCandles.length < 2) return;
  const oldSpacing = barSpacing;
  const x = clamp(event.offsetX, 0, plotWidthFromCanvas());
  const candleUnderCursor = firstVisibleIndex + x / oldSpacing;
  const zoomFactor = Math.exp(-event.deltaY * 0.001);
  barSpacing = clamp(oldSpacing * zoomFactor, MIN_BAR_SPACING, MAX_BAR_SPACING);
  firstVisibleIndex = candleUnderCursor - x / barSpacing;
  followLive = false;
  clampViewport();
  scheduleRender();
}, { passive: false });

canvas.addEventListener("pointerdown", event => {
  cursorPoint = { x: event.offsetX, y: event.offsetY };
  const point = pointFromEvent(event);
  if (!point) return;

  if (activeTool === "level") {
    drawings.push({ key: drawingKey(), type: "level", points: [point], color: "#2563eb" });
    saveDrawings();
    updateAnalysis();
    scheduleRender();
    return;
  }

  if (activeTool === "text") {
    const text = window.prompt("Chart note", "Note");
    if (text) {
      drawings.push({ key: drawingKey(), type: "text", points: [point], text, color: "#111827" });
      saveDrawings();
      updateAnalysis();
      scheduleRender();
    }
    return;
  }

  if (activeTool === "box" || activeTool === "trend") {
    isDrawing = true;
    drawingDraft = { key: drawingKey(), type: activeTool, points: [point, point], color: activeTool === "box" ? "#2563eb" : "#f59e0b" };
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  isDragging = true;
  dragStartX = event.clientX;
  dragStartFirstIndex = firstVisibleIndex;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", event => {
  cursorPoint = { x: event.offsetX, y: event.offsetY };

  if (isDrawing && drawingDraft) {
    const point = pointFromEvent(event);
    if (point) {
      drawingDraft.points[1] = point;
      scheduleRender();
    }
    return;
  }

  if (!isDragging || lastCandles.length < 2) {
    scheduleRender();
    return;
  }
  const deltaCandles = (event.clientX - dragStartX) / barSpacing;
  firstVisibleIndex = dragStartFirstIndex - deltaCandles;
  followLive = false;
  clampViewport();
  scheduleRender();
});

canvas.addEventListener("pointerup", event => {
  if (isDrawing && drawingDraft) {
    drawings.push(drawingDraft);
    drawingDraft = null;
    isDrawing = false;
    saveDrawings();
    updateAnalysis();
    canvas.releasePointerCapture(event.pointerId);
    scheduleRender();
    return;
  }

  isDragging = false;
  canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener("pointerleave", () => {
  isDragging = false;
  if (!isDrawing) {
    cursorPoint = null;
    scheduleRender();
  }
});

setReplayControls();
renderAlerts();
loadWatchlist();
search(activeSymbol);
