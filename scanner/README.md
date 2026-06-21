# Crypto Signal Scanner — 24/7 phone alerts

Runs in the cloud and pushes a notification to your phone whenever an **RSI / RSI-MA
cross** appears on the **5m and 15m** timeframes for the top-50 coins — using the same
strategy math as the web tool. It keeps running **even when your laptop is off**.

The alert tells you the coin, side (LONG/SHORT), timeframe, RSI/RSI-MA values, whether
**MACD** agrees, the price, and a TradingView link.

---

## 1. Pick a notification channel

You only need **one**. Telegram is recommended.

### Telegram (recommended)
1. In Telegram, open **@BotFather** → send `/newbot` → follow prompts → copy the **bot token**.
2. Send any message to your new bot (so it can message you back).
3. Get your **chat id**: open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a
   browser and read `result[].message.chat.id` (a number).
4. You now have `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

### ntfy.sh (easiest, no account)
1. Install the **ntfy** app (iOS/Android).
2. Subscribe to a hard-to-guess topic, e.g. `my-crypto-signals-9f3k2`.
3. Use that as `NTFY_TOPIC`. (Anyone who knows the topic can read it, so make it random.)

### Discord
Server → Channel → Edit → Integrations → Webhooks → New Webhook → copy URL → `DISCORD_WEBHOOK`.

---

## 2A. Run it FREE on GitHub Actions (laptop can be off) — recommended

1. Put this whole project in a **GitHub repository** (the repo root must contain the
   `.github/workflows/scan.yml` file and the `scanner/` folder).
2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
   Add the secrets for your channel, e.g.:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - (or `NTFY_TOPIC`, or `DISCORD_WEBHOOK`)
3. Go to the **Actions** tab → enable workflows → open **crypto-signal-scan** →
   **Run workflow** once to test. You should get a notification within a minute if a
   cross exists; otherwise it logs `0 fresh crosses`.
4. From now on it runs **automatically every ~5 minutes**, on GitHub's servers, with your
   laptop off. Free for public repos (and within the generous free minutes for private).

> Note: GitHub cron runs every 5 min and can occasionally be delayed a few minutes during
> peak load. Good enough for 5m/15m. If you want second-by-second checking, use 2B.

## 2B. Run it on an always-on machine (VPS / Raspberry Pi / Railway / Fly.io)

```bash
cd scanner
cp .env.example .env        # then fill in your channel secrets
node scan.js --test         # send a test push
node scan.js --loop         # scan continuously (every SCAN_INTERVAL seconds)
```

To keep it alive on a server, use `pm2`:
```bash
npm i -g pm2
pm2 start scan.js --name signals -- --loop
pm2 save && pm2 startup
```

On a $4–5/mo VPS this checks every 60s — the most responsive option.

---

## 3. Test locally first

```bash
cd scanner
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy node scan.js --test   # should ping your phone
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy node scan.js --once   # one real scan pass
```
(On Windows PowerShell: `$env:TELEGRAM_BOT_TOKEN="xxx"; node scan.js --test`)

---

## Settings (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `SIGNALS` | `rsi,macd` | Signal sources: `rsi` (RSI/RSI-MA cross) and/or `macd` (histogram reversal — first opposite-colour bar, detected on the forming bar) |
| `TIMEFRAMES` | `5m,15m` | Comma list of timeframes to scan |
| `MA_TYPE` | `sma` | `sma` or `ema` — must match the web tool's RSI-MA |
| `MA_LEN` / `RSI_LEN` | `14` / `14` | RSI-MA and RSI lengths |
| `TOP_N` | `50` | How many top coins to scan |
| `MIN_SCORE` | `58` | **Accuracy gate** — only alert at/above this 0-100 confluence score (58≈B, 75≈A) |
| `USE_HTF` | `true` | Confirm against the higher timeframe (5m→1h, 15m→4h) — the strongest filter |
| `REQUIRE_MACD` | `false` | `true` = also hard-require MACD agreement |
| `BINANCE_BASE` | `https://data-api.binance.vision` | Public market-data host (works from cloud) |

### How the confluence score works (accuracy)

Every raw RSI/RSI-MA cross is scored 0-100 by stacking independent confirmations.
Only setups scoring ≥ `MIN_SCORE` push an alert, so weak/choppy crosses are filtered out.

| Technique | Weight | What it confirms |
|-----------|--------|------------------|
| MACD line vs signal | 1.5 | momentum behind the move |
| ADX ≥ 20 + DI direction | 1.5 | a real trend exists (filters chop) |
| **Higher-timeframe trend** | **2** | trade with the bigger trend — biggest edge |
| EMA50/200 stack | 1 | structural trend |
| Price vs EMA200 | 1 | macro side |
| Volume > 20-bar avg | 1 | participation behind the cross |
| RSI zone (not extreme) | 1 | not chasing an exhausted move |
| **RSI divergence** | **1.5** | price/momentum disagreement (reversal quality) |
| Candle direction | 0.5 | cross candle closes in trade direction |
| ATR volatility band | 0.5 | enough movement, not erratic |

Grades: **A** ≥75, **B** ≥58, **C** ≥40, **D** below. Each alert includes the grade,
score, which confirmations passed, any divergence ⭐, and an ATR-based trade plan
(entry / stop-loss / TP1 / TP2).

**Tuning:** for fewer, higher-conviction alerts set `MIN_SCORE=75` (A-only). To catch
more (and filter yourself) set `MIN_SCORE=45`.

**Dedup:** each cross is alerted once. The `state.json` file remembers what was already
sent (persisted via GitHub Actions cache, or on disk in loop mode).
