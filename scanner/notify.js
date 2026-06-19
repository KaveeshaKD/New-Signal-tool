// Multi-channel push. Whichever channel(s) you configure via env vars get used.
// You only need ONE. Telegram is recommended (free, instant, reliable on phones).

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) console.error('Telegram error', r.status, await r.text().catch(() => ''));
  return r.ok;
}

async function sendDiscord(text) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) return false;
  // Discord uses markdown, not HTML — strip simple tags.
  const content = text.replace(/<\/?b>/g, '**').replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2: $1');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) console.error('Discord error', r.status);
  return r.ok;
}

async function sendNtfy(title, text) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const base = process.env.NTFY_URL || 'https://ntfy.sh';
  const plain = text.replace(/<\/?b>/g, '').replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2 $1');
  const r = await fetch(`${base}/${topic}`, {
    method: 'POST',
    headers: { 'Title': title, 'Tags': 'chart_with_upwards_trend' },
    body: plain,
  });
  if (!r.ok) console.error('ntfy error', r.status);
  return r.ok;
}

// Sends to every configured channel. `title` is used by ntfy only.
async function notify(title, htmlText) {
  const results = await Promise.allSettled([
    sendTelegram(htmlText),
    sendDiscord(htmlText),
    sendNtfy(title, htmlText),
  ]);
  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

function channelsConfigured() {
  const list = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) list.push('Telegram');
  if (process.env.DISCORD_WEBHOOK) list.push('Discord');
  if (process.env.NTFY_TOPIC) list.push('ntfy');
  return list;
}

module.exports = { notify, channelsConfigured };
