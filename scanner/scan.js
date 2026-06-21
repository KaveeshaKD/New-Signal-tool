// Cloud scanner: polls Binance for the top coins, detects RSI / RSI-MA crosses AND
// MACD histogram reversals (first opposite-colour bar) on the configured timeframes
// (default 5m + 15m), confirms each with the confluence engine, and pushes a phone alert.
//
//   node scan.js --once     run a single pass (used by GitHub Actions cron)
//   node scan.js --loop     run forever, every SCAN_INTERVAL seconds (VPS/PC)
//   node scan.js --test     send one test notification and exit
//
// Config via environment variables — see .env.example / README.md.

const fs = require('fs');
const path = require('path');
const { detectCross, detectMacdFlip } = require('./indicators');
const { analyzeCross, tradeEval } = require('./strategy');
const { notify, channelsConfigured } = require('./notify');

// Higher timeframe used to confirm each signal's trend (the strongest filter).
const HTF_MAP = { '1m': '15m', '3m': '30m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1d', '4h': '1d' };

// Public market-data host. data-api.binance.vision is NOT geo-blocked, so it
// works from cloud runners (the main api.binance.com often returns 451 there).
const BASE = process.env.BINANCE_BASE || 'https://data-api.binance.vision';

const cfg = {
  timeframes: (process.env.TIMEFRAMES || '5m,15m').split(',').map(s => s.trim()).filter(Boolean),
  rsiLen: +process.env.RSI_LEN || 14,
  maLen: +process.env.MA_LEN || 14,
  maType: (process.env.MA_TYPE || 'sma').toLowerCase(),
  topN: +process.env.TOP_N || 80,
  requireMacd: /^(1|true|yes)$/i.test(process.env.REQUIRE_MACD || ''),
  minScore: process.env.MIN_SCORE != null && process.env.MIN_SCORE !== '' ? +process.env.MIN_SCORE : 58,
  useHtf: !/^(0|false|no)$/i.test(process.env.USE_HTF || ''),
  // which signal sources to alert on: 'rsi' (RSI/RSI-MA cross), 'macd' (histogram reversal)
  signals: (process.env.SIGNALS || 'rsi,macd').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // leverage trade-suitability (matches the web tool's Trade-Ready Setups)
  leverage: +process.env.LEVERAGE || 15,
  tpPct: +process.env.TP_PCT || 15,
  suitableOnly: /^(1|true|yes)$/i.test(process.env.SUITABLE_ONLY || ''),
  interval: +process.env.SCAN_INTERVAL || 60,
};

const STATE_FILE = path.join(__dirname, 'state.json');
const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDP|EUR|GBP|AEUR|USDD)$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

// Same curated top-80 as the web tool, so alerts match the chart exactly.
// Delisted/renamed tickers are skipped automatically if Binance has no pair.
const CURATED = ['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','TRX','AVAX','LINK',
  'TON','SHIB','DOT','BCH','NEAR','LTC','MATIC','UNI','ICP','APT',
  'ETC','XLM','FIL','HBAR','ATOM','RNDR','ARB','VET','OP','INJ',
  'IMX','MKR','GRT','AAVE','SUI','RUNE','FTM','THETA','ALGO','SEI',
  'TIA','LDO','FLOW','EGLD','SAND','AXS','GALA','MANA','SNX','PEPE',
  'WIF','JUP','ENA','ONDO','PENDLE','STX','FET','WLD','BONK','FLOKI',
  'ORDI','DYDX','GMX','CRV','COMP','1INCH','ENJ','CHZ','APE','KAVA',
  'BLUR','JASMY','CFX','XTZ','EOS','NEO','MINA','GMT','IOTA','SUSHI']
  .map(s => s + 'USDT');

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'signal-scanner' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Default = the curated list. Set SYMBOLS=BTC,ETH,... to override, or
// SYMBOL_SOURCE=volume to pull the live top-N by 24h volume instead.
async function getSymbols() {
  if (process.env.SYMBOLS) {
    return process.env.SYMBOLS.split(',').map(s => s.trim().toUpperCase())
      .map(s => s.endsWith('USDT') ? s : s + 'USDT');
  }
  if ((process.env.SYMBOL_SOURCE || '').toLowerCase() === 'volume') {
    const data = await getJSON(`${BASE}/api/v3/ticker/24hr`);
    return data
      .filter(t => t.symbol.endsWith('USDT') && !LEVERAGED.test(t.symbol))
      .filter(t => !STABLE.test(t.symbol.replace(/USDT$/, '')))
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
      .slice(0, cfg.topN)
      .map(t => t.symbol);
  }
  return CURATED.slice(0, cfg.topN);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { sent: {} }; }
}
function saveState(st) {
  // keep the file from growing forever — drop keys older than 2 days
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  for (const k in st.sent) if (st.sent[k] < cutoff) delete st.sent[k];
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

function fmtPrice(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(8);
}

// Scan one symbol/timeframe for ALL enabled signal sources off a single fetch.
// Each candidate is confirmed by the confluence engine and gated by MIN_SCORE.
async function scanSymbol(symbol, tf) {
  const kl = await getJSON(`${BASE}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=300`);
  if (!Array.isArray(kl) || kl.length < 60) return [];
  const closes = kl.map(k => +k[4]);
  const openTimes = kl.map(k => k[0]);

  const cross    = cfg.signals.includes('rsi')  ? detectCross(closes, openTimes, cfg)   : null;
  const macdFlip = cfg.signals.includes('macd') ? detectMacdFlip(closes, openTimes)     : null;
  if (!cross && !macdFlip) return [];

  // a candidate exists — fetch the higher timeframe once for confirmation
  const htf = HTF_MAP[tf] || '1h';
  let klHtf = null;
  if (cfg.useHtf) klHtf = await getJSON(`${BASE}/api/v3/klines?symbol=${symbol}&interval=${htf}&limit=300`).catch(() => null);

  const price = closes[closes.length - 1];
  const out = [];

  if (cross) {
    const a = analyzeCross(kl, klHtf, cross.side, { ...cfg, htf });
    if (!(cfg.requireMacd && !a.macdAgree) && a.score >= cfg.minScore) {
      const trade = tradeEval(cross.side, price, a.atrPct, a.score, cfg);
      if (!cfg.suitableOnly || (trade && trade.rating === 'SUITABLE'))
        out.push({ type: 'rsi', symbol, tf, price, ...cross, ...a, trade });
    }
  }
  if (macdFlip) {
    // confirm the histogram reversal with the OTHER techniques (trend, ADX, HTF, volume…)
    const a = analyzeCross(kl, klHtf, macdFlip.side, { ...cfg, htf });
    if (a.score >= cfg.minScore) {
      const trade = tradeEval(macdFlip.side, price, a.atrPct, a.score, cfg);
      if (!cfg.suitableOnly || (trade && trade.rating === 'SUITABLE'))
        out.push({ type: 'macd', symbol, tf, price, side: macdFlip.side, bar: macdFlip.bar, flipTime: macdFlip.flipTime, ageBars: macdFlip.ageBars, ...a, trade });
    }
  }
  return out;
}

function buildMessage(s) {
  const base = s.symbol.replace(/USDT$/, '');
  const emoji = s.side === 'LONG' ? '🟢' : '🔴';
  const tv = `https://www.tradingview.com/chart/?symbol=BINANCE:${s.symbol}`;
  const gradeEmoji = { A: '🅰️', B: '🅱️', C: '🇨', D: '🇩' }[s.grade] || '';
  let head, detail, when;
  if (s.type === 'macd') {
    const flip = s.side === 'LONG' ? 'red → green' : 'green → red';
    head = `${emoji} <b>MACD FLIP → ${s.side}</b> · <b>${base}/USDT</b> · ${s.tf}`;
    detail = `Histogram ${flip} — first reverse bar${s.bar === 'forming' ? ' (forming NOW ⚡)' : ' (just closed)'}`;
    when = new Date(s.flipTime).toISOString().slice(11, 16);
  } else {
    const arrow = s.side === 'LONG' ? 'crossed ABOVE' : 'crossed BELOW';
    head = `${emoji} <b>${s.side}</b> · <b>${base}/USDT</b> · ${s.tf}`;
    detail = `RSI ${arrow} RSI-MA · RSI ${s.rsi.toFixed(1)}/MA ${s.ma.toFixed(1)}`;
    when = new Date(s.candleTime).toISOString().slice(11, 16);
  }
  let msg = `${head}\n` +
    `Confirmed: Quality <b>${s.grade}</b> ${gradeEmoji} (score ${s.score}/100)\n` +
    `${detail}\n` +
    `Confirms: ${s.passed.join(', ') || 'none'}\n`;
  if (s.divergence === (s.side === 'LONG' ? 'bull' : 'bear')) msg += `⭐ RSI ${s.divergence} divergence\n`;
  // leverage trade-suitability — the "is this tradeable for my leverage?" verdict
  if (s.trade) {
    const t = s.trade, badge = { SUITABLE: '✅ SUITABLE', CAUTION: '⚠️ CAUTION', SKIP: '❌ SKIP' }[t.rating];
    msg += `🎯 Trade ${cfg.leverage}x/${cfg.tpPct}%: <b>${badge}</b> — ${t.why}\n` +
      `Entry $${fmtPrice(s.price)} · SL $${fmtPrice(t.slPrice)} · TP $${fmtPrice(t.tpPrice)} · Liq $${fmtPrice(t.liqPrice)} · ${t.rr.toFixed(2)}R\n`;
  } else if (s.plan) {
    msg += `Entry $${fmtPrice(s.plan.entry)} · SL $${fmtPrice(s.plan.sl)} · ` +
      `TP1 $${fmtPrice(s.plan.tp1)} · TP2 $${fmtPrice(s.plan.tp2)}\n`;
  }
  msg += `${when} UTC · <a href="${tv}">Open chart ↗</a>`;
  return msg;
}

async function runOnce() {
  const channels = channelsConfigured();
  if (!channels.length) { console.error('No notification channel configured. See README.md'); process.exit(1); }
  console.log(`[${new Date().toISOString()}] scanning · TFs ${cfg.timeframes.join('+')} · signals ${cfg.signals.join('+')} · push → ${channels.join(', ')}`);

  const symbols = await getSymbols();
  const st = loadState();
  let found = 0, alerted = 0;

  for (const tf of cfg.timeframes) {
    // small batches to stay polite to the API
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = symbols.slice(i, i + 10);
      const results = await Promise.all(batch.map(sym => scanSymbol(sym, tf).catch(() => [])));
      for (const s of results.flat()) {
        found++;
        const evTime = s.type === 'macd' ? s.flipTime : s.candleTime;
        const key = `${s.symbol}|${s.tf}|${s.type}|${evTime}|${s.side}`;
        if (st.sent[key]) continue;          // already alerted for this exact event
        st.sent[key] = Date.now();
        const label = s.type === 'macd' ? `MACD-FLIP ${s.side}` : `${s.side}`;
        const ok = await notify(`${label} ${s.symbol} ${s.tf}`, buildMessage(s));
        if (ok) { alerted++; console.log(`  alert ${label} ${s.symbol} ${s.tf} · grade ${s.grade} (${s.score}) · trade ${s.trade ? s.trade.rating : '—'} [${s.passed.join(',')}]`); }
        await new Promise(r => setTimeout(r, 250)); // gentle pacing between pushes
      }
    }
  }
  saveState(st);
  console.log(`done · ${found} confirmed signal(s), ${alerted} new alert(s) sent`);
}

async function main() {
  const arg = process.argv[2] || '--once';
  if (arg === '--test') {
    const ok = await notify('Signal scanner test', '✅ <b>Test alert</b>\nYour crypto signal scanner is connected and can reach your phone.');
    console.log(ok ? 'Test notification sent.' : 'Failed — check your channel config.');
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--loop') {
    console.log(`Loop mode · every ${cfg.interval}s`);
    for (;;) {
      try { await runOnce(); } catch (e) { console.error('scan error:', e.message); }
      await new Promise(r => setTimeout(r, cfg.interval * 1000));
    }
  }
  await runOnce(); // --once (default)
}

main().catch(e => { console.error(e); process.exit(1); });
