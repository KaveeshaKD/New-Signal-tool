// Confluence scoring — turns a raw RSI/RSI-MA cross into a graded, high-accuracy
// signal by stacking independent confirmations. Only strong setups should alert.
//
// Techniques combined (each weighted):
//   1. MACD agreement        momentum behind the move
//   2. ADX + DI direction    a real trend exists (filters chop / whipsaw)
//   3. HTF trend alignment    biggest edge — trade with the higher timeframe
//   4. EMA50/200 stack        structural trend
//   5. Price vs EMA200        macro side
//   6. Volume surge           participation behind the cross
//   7. RSI zone               not chasing an exhausted/overbought-oversold move
//   8. RSI divergence         momentum/price disagreement (bonus reversal quality)
//   9. Candle confirmation    the cross candle closes in the trade direction
//  10. ATR volatility band    enough movement to capture, not erratic

const { calcRSI, sma, ema, macd, adx, atr, htfBias, rsiDivergence } = require('./indicators');

function analyzeCross(klBase, klHtf, side, cfg) {
  const closes = klBase.map(k => +k[4]), opens = klBase.map(k => +k[1]),
        highs = klBase.map(k => +k[2]), lows = klBase.map(k => +k[3]), vols = klBase.map(k => +k[5]);
  const c = closes.length - 2;            // last closed candle (the cross candle)
  const L = side === 'LONG';

  const rsi = calcRSI(closes, cfg.rsiLen);
  const m = macd(closes);
  const ax = adx(highs, lows, closes, 14);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  const avgVol = sma(vols, 20);
  const atr14 = atr(highs, lows, closes, 14);
  const a14 = atr14[c];
  const atrPct = a14 != null ? 100 * a14 / closes[c] : null;
  const div = rsiDivergence(highs, lows, closes, rsi, c);
  const bias = klHtf ? htfBias(klHtf.map(k => +k[4]), cfg) : null;

  const checks = [];
  const add = (name, pass, w) => checks.push({ name, pass: !!pass, w });

  // 1) MACD
  add('MACD', m.line[c] != null && m.signal[c] != null && (L ? m.line[c] > m.signal[c] : m.line[c] < m.signal[c]), 1.5);
  // 2) ADX trend strength + direction
  const av = ax.adx[c], pdi = ax.plusDI[c], mdi = ax.minusDI[c];
  add('ADX', av != null && av >= 20 && pdi != null && mdi != null && (L ? pdi > mdi : mdi > pdi), 1.5);
  // 3) Higher-timeframe alignment
  if (klHtf) add(`HTF(${cfg.htf})`, L ? bias === 'bull' : bias === 'bear', 2);
  // 4) EMA50/200 trend stack
  add('EMAtrend', e50[c] != null && e200[c] != null && (L ? e50[c] > e200[c] : e50[c] < e200[c]), 1);
  // 5) Price vs EMA200
  add('PxEMA200', e200[c] != null && (L ? closes[c] > e200[c] : closes[c] < e200[c]), 1);
  // 6) Volume surge
  add('Volume', avgVol[c] != null && vols[c] > avgVol[c], 1);
  // 7) RSI zone — room to run
  add('RSIzone', L ? rsi[c] < 68 : rsi[c] > 32, 1);
  // 8) RSI divergence in the trade direction (bonus)
  add('Divergence', div === (L ? 'bull' : 'bear'), 1.5);
  // 9) Candle closes in direction
  add('Candle', L ? closes[c] >= opens[c] : closes[c] <= opens[c], 0.5);
  // 10) Healthy volatility band (skip dead or erratic markets)
  add('ATRband', atrPct != null && atrPct >= 0.15 && atrPct <= 6, 0.5);

  const totW = checks.reduce((s, x) => s + x.w, 0);
  const gotW = checks.reduce((s, x) => s + (x.pass ? x.w : 0), 0);
  const score = totW ? Math.round(100 * gotW / totW) : 0;
  const grade = score >= 75 ? 'A' : score >= 58 ? 'B' : score >= 40 ? 'C' : 'D';

  // ATR-based trade plan (1.5x ATR risk, 1:1 and 1:2 targets)
  const entry = closes[closes.length - 1];
  let plan = null;
  if (a14 != null) {
    plan = {
      entry,
      sl: L ? entry - 1.5 * a14 : entry + 1.5 * a14,
      tp1: L ? entry + 1.5 * a14 : entry - 1.5 * a14,
      tp2: L ? entry + 3 * a14 : entry - 3 * a14,
    };
  }

  return {
    score, grade, atrPct, divergence: div, htfBias: bias,
    passed: checks.filter(x => x.pass).map(x => x.name),
    failed: checks.filter(x => !x.pass).map(x => x.name),
    macdAgree: checks[0].pass,
    plan,
  };
}

module.exports = { analyzeCross };
