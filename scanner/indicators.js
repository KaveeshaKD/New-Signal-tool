// Indicator math — ported 1:1 from the web tool (index.html) so cloud alerts
// match exactly what you see on the chart.

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const c = closes[i] - closes[i - 1]; if (c >= 0) gain += c; else loss -= c; }
  let ag = gain / period, al = loss / period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1], g = c > 0 ? c : 0, l = c < 0 ? -c : 0;
    ag = (ag * (period - 1) + g) / period; al = (al * (period - 1) + l) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

function sma(arr, period) {
  const out = new Array(arr.length).fill(null); let sum = 0; const buf = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) { out[i] = null; continue; }
    buf.push(arr[i]); sum += arr[i]; if (buf.length > period) sum -= buf.shift();
    if (buf.length === period) out[i] = sum / period;
  }
  return out;
}

function ema(arr, period) {
  const out = new Array(arr.length).fill(null); const k = 2 / (period + 1); let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) { out[i] = null; continue; }
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const sig = ema(line, signal);
  const hist = line.map((_, i) => (line[i] != null && sig[i] != null) ? line[i] - sig[i] : null);
  return { line, signal: sig, hist };
}

// Detect an RSI / RSI-MA cross on the most recently CLOSED candle.
// Binance returns the still-forming candle last, so we look at index (len-2).
// Returns { side, candleTime, rsi, ma } or null.
function detectCross(closes, openTimes, cfg) {
  const rsi = calcRSI(closes, cfg.rsiLen);
  const rsiMa = cfg.maType === 'ema' ? ema(rsi, cfg.maLen) : sma(rsi, cfg.maLen);
  const c = closes.length - 2;      // last closed candle
  const p = c - 1;
  if (c < 1 || rsi[p] == null || rsi[c] == null || rsiMa[p] == null || rsiMa[c] == null) return null;
  const up = rsi[p] <= rsiMa[p] && rsi[c] > rsiMa[c];
  const down = rsi[p] >= rsiMa[p] && rsi[c] < rsiMa[c];
  if (!up && !down) return null;
  return {
    side: up ? 'LONG' : 'SHORT',
    candleTime: openTimes[c],
    rsi: rsi[c],
    ma: rsiMa[c],
  };
}

module.exports = { calcRSI, sma, ema, macd, detectCross };
