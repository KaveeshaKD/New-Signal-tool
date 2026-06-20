// Cloud scanner: polls Binance for the top coins, detects RSI / RSI-MA crosses
// on the configured timeframes (default 5m + 15m), and pushes a phone alert.
//
//   node scan.js --once     run a single pass (used by GitHub Actions cron)
//   node scan.js --loop     run forever, every SCAN_INTERVAL seconds (VPS/PC)
//   node scan.js --test     send one test notification and exit
//
// Config via environment variables — see .env.example / README.md.

const fs = require('fs');
const path = require('path');
const { detectCross } = require('./indicators');
const { analyzeCross } = require('./strategy');
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
  topN: +process.env.TOP_N || 50,
  requireMacd: /^(1|true|yes)$/i.test(process.env.REQUIRE_MACD || ''),
  minScore: process.env.MIN_SCORE != null && process.env.MIN_SCORE !== '' ? +process.env.MIN_SCORE : 58,
  useHtf: !/^(0|false|no)$/i.test(process.env.USE_HTF || ''),
  interval: +process.env.SCAN_INTERVAL || 60,
};

const STATE_FILE = path.join(__dirname, 'state.json');
const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDP|EUR|GBP|AEUR|USDD)$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

// Same curated top-50 as the web tool, so alerts match the chart exactly.
const CURATED = ['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','TRX','AVAX','LINK',
  'TON','SHIB','DOT','BCH','NEAR','LTC','MATIC','UNI','ICP','APT',
  'ETC','XLM','FIL','HBAR','ATOM','RNDR','ARB','VET','OP','INJ',
  'IMX','MKR','GRT','AAVE','SUI','RUNE','FTM','THETA','ALGO','SEI',
  'TIA','LDO','FLOW','EGLD','SAND','AXS','GALA','MANA','SNX','PEPE']
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

async function scanOne(symbol, tf) {
  const kl = await getJSON(`${BASE}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=300`);
  if (!Array.isArray(kl) || kl.length < 60) return null;
  const closes = kl.map(k => +k[4]);
  const openTimes = kl.map(k => k[0]);
  const cross = detectCross(closes, openTimes, cfg);
  if (!cross) return null;

  // Only now (a cross exists) do we fetch the higher timeframe — keeps API use low.
  const htf = HTF_MAP[tf] || '1h';
  let klHtf = null;
  if (cfg.useHtf) klHtf = await getJSON(`${BASE}/api/v3/klines?symbol=${symbol}&interval=${htf}&limit=300`).catch(() => null);

  const a = analyzeCross(kl, klHtf, cross.side, { ...cfg, htf });
  if (cfg.requireMacd && !a.macdAgree) return null;
  if (a.score < cfg.minScore) return null;            // accuracy gate

  return { symbol, tf, ...cross, price: closes[closes.length - 1], ...a };
}

function buildMessage(s) {
  const base = s.symbol.replace(/USDT$/, '');
  const emoji = s.side === 'LONG' ? '🟢' : '🔴';
  const arrow = s.side === 'LONG' ? 'crossed ABOVE' : 'crossed BELOW';
  const tv = `https://www.tradingview.com/chart/?symbol=BINANCE:${s.symbol}`;
  const when = new Date(s.candleTime).toISOString().slice(11, 16);
  const gradeEmoji = { A: '🅰️', B: '🅱️', C: '🇨', D: '🇩' }[s.grade] || '';
  let msg = `${emoji} <b>${s.side}</b> · <b>${base}/USDT</b> · ${s.tf}\n` +
    `Quality <b>${s.grade}</b> ${gradeEmoji} (score ${s.score}/100)\n` +
    `RSI ${arrow} RSI-MA · RSI ${s.rsi.toFixed(1)}/MA ${s.ma.toFixed(1)}\n` +
    `Confirms: ${s.passed.join(', ') || 'none'}\n`;
  if (s.divergence === (s.side === 'LONG' ? 'bull' : 'bear')) msg += `⭐ RSI ${s.divergence} divergence\n`;
  if (s.plan) {
    msg += `Entry $${fmtPrice(s.plan.entry)} · SL $${fmtPrice(s.plan.sl)} · ` +
      `TP1 $${fmtPrice(s.plan.tp1)} · TP2 $${fmtPrice(s.plan.tp2)}\n`;
  }
  msg += `candle ${when} UTC · <a href="${tv}">Open chart ↗</a>`;
  return msg;
}

async function runOnce() {
  const channels = channelsConfigured();
  if (!channels.length) { console.error('No notification channel configured. See README.md'); process.exit(1); }
  console.log(`[${new Date().toISOString()}] scanning · TFs ${cfg.timeframes.join('+')} · push → ${channels.join(', ')}`);

  const symbols = await getSymbols();
  const st = loadState();
  let found = 0, alerted = 0;

  for (const tf of cfg.timeframes) {
    // small batches to stay polite to the API
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = symbols.slice(i, i + 10);
      const results = await Promise.all(batch.map(sym => scanOne(sym, tf).catch(() => null)));
      for (const s of results) {
        if (!s) continue;
        found++;
        const key = `${s.symbol}|${s.tf}|${s.candleTime}|${s.side}`;
        if (st.sent[key]) continue;          // already alerted for this exact cross
        st.sent[key] = Date.now();
        const ok = await notify(`${s.side} ${s.symbol} ${s.tf}`, buildMessage(s));
        if (ok) { alerted++; console.log(`  alert ${s.side} ${s.symbol} ${s.tf} · grade ${s.grade} (${s.score}) [${s.passed.join(',')}]`); }
        await new Promise(r => setTimeout(r, 250)); // gentle pacing between pushes
      }
    }
  }
  saveState(st);
  console.log(`done · ${found} fresh cross(es), ${alerted} new alert(s) sent`);
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
