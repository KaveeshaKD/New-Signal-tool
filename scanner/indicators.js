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

// MACD histogram reversal: the first opposite-colour bar (red→green = LONG,
// green→red = SHORT). Checks the live/forming bar first (earliest possible alert),
// then the last closed bar. `bar` says which one flipped.
function detectMacdFlip(closes, openTimes) {
  const m = macd(closes);
  const n = closes.length - 1;        // forming bar
  for (const i of [n, n - 1]) {
    const h0 = m.hist[i - 1], h1 = m.hist[i];
    if (h0 == null || h1 == null) continue;
    if (h0 <= 0 && h1 > 0) return { side: 'LONG',  bar: i === n ? 'forming' : 'closed', flipTime: openTimes[i], ageBars: n - i, hist: h1 };
    if (h0 >= 0 && h1 < 0) return { side: 'SHORT', bar: i === n ? 'forming' : 'closed', flipTime: openTimes[i], ageBars: n - i, hist: h1 };
  }
  return null;
}

// ADX with +DI/-DI (Wilder) — trend-strength filter to avoid chop.
function adx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const tr = new Array(len).fill(0), pDM = new Array(len).fill(0), mDM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const plusDI = new Array(len).fill(null), minusDI = new Array(len).fill(null), dx = new Array(len).fill(null), adxA = new Array(len).fill(null);
  if (len <= period * 2) return { plusDI, minusDI, adx: adxA };
  let atr = 0, sp = 0, sm = 0;
  for (let i = 1; i <= period; i++) { atr += tr[i]; sp += pDM[i]; sm += mDM[i]; }
  for (let i = period + 1; i < len; i++) {
    atr = atr - atr / period + tr[i];
    sp = sp - sp / period + pDM[i];
    sm = sm - sm / period + mDM[i];
    const pdi = 100 * sp / atr, mdi = 100 * sm / atr;
    plusDI[i] = pdi; minusDI[i] = mdi;
    dx[i] = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
  }
  const start = period * 2;
  let sum = 0, c = 0;
  for (let i = period + 1; i <= start; i++) { if (dx[i] != null) { sum += dx[i]; c++; } }
  let a = c ? sum / c : null; adxA[start] = a;
  for (let i = start + 1; i < len; i++) { if (dx[i] != null && a != null) { a = (a * (period - 1) + dx[i]) / period; adxA[i] = a; } }
  return { plusDI, minusDI, adx: adxA };
}

function atr(highs, lows, closes, period = 14) {
  const len = closes.length, out = new Array(len).fill(null); if (len <= period) return out;
  let a = 0; for (let i = 1; i <= period; i++) a += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  a /= period; out[period] = a;
  for (let i = period + 1; i < len; i++) { const t = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])); a = (a * (period - 1) + t) / period; out[i] = a; }
  return out;
}

// Higher-timeframe bias: RSI-vs-RSIMA and EMA50-vs-EMA200 combined → bull/bear/neutral
function htfBias(closes, cfg) {
  if (closes.length < 60) return null;
  const r = calcRSI(closes, cfg.rsiLen);
  const m = cfg.maType === 'ema' ? ema(r, cfg.maLen) : sma(r, cfg.maLen);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  const n = closes.length - 1; let s = 0;
  if (r[n] != null && m[n] != null) s += r[n] > m[n] ? 1 : -1;
  if (e50[n] != null && e200[n] != null) s += e50[n] > e200[n] ? 1 : -1;
  return s > 0 ? 'bull' : s < 0 ? 'bear' : 'neutral';
}

// Regular RSI divergence near index `end`, using pivots with window `w`.
// Bullish: price lower-low while RSI higher-low. Bearish: the mirror.
function rsiDivergence(highs, lows, closes, rsi, end, w = 3, look = 40) {
  const lo = [], hi = [];
  const from = Math.max(w, end - look);
  for (let i = from; i <= end - w; i++) {
    let isLow = true, isHigh = true;
    for (let j = 1; j <= w; j++) {
      if (!(lows[i] < lows[i - j] && lows[i] < lows[i + j])) isLow = false;
      if (!(highs[i] > highs[i - j] && highs[i] > highs[i + j])) isHigh = false;
    }
    if (isLow) lo.push(i);
    if (isHigh) hi.push(i);
  }
  let bull = false, bear = false;
  if (lo.length >= 2) {
    const a = lo[lo.length - 2], b = lo[lo.length - 1];
    if (lows[b] < lows[a] && rsi[b] > rsi[a]) bull = true;     // price LL, RSI HL
  }
  if (hi.length >= 2) {
    const a = hi[hi.length - 2], b = hi[hi.length - 1];
    if (highs[b] > highs[a] && rsi[b] < rsi[a]) bear = true;   // price HH, RSI LH
  }
  return bull ? 'bull' : bear ? 'bear' : null;
}

module.exports = { calcRSI, sma, ema, macd, adx, atr, htfBias, rsiDivergence, detectCross, detectMacdFlip };
