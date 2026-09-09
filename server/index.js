const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', message: 'Live — scanning Pump.fun' }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function scoreCoin(coin) {
  let score = 0;
  const reasons = [];
  if (coin.liquidityLocked) { score += 25; reasons.push({ label: 'Liq locked', pts: 25, pass: true }); }
  else reasons.push({ label: 'Liq locked', pts: 0, pass: false });
  if (coin.mintAuthorityRevoked) { score += 20; reasons.push({ label: 'Renounced', pts: 20, pass: true }); }
  else reasons.push({ label: 'Renounced', pts: 0, pass: false });
  if (!coin.hasMintFunction) { score += 15; reasons.push({ label: 'No mint', pts: 15, pass: true }); }
  else reasons.push({ label: 'No mint', pts: 0, pass: false });
  if (coin.marketCapUsd < 2000000) { score += 15; reasons.push({ label: 'Low mcap', pts: 15, pass: true }); }
  else reasons.push({ label: 'Low mcap', pts: 0, pass: false });
  if (coin.top10HoldersPct < 30) { score += 10; reasons.push({ label: 'Low whale', pts: 10, pass: true }); }
  else reasons.push({ label: 'Low whale', pts: 0, pass: false });
  if (coin.telegramMembers > 1000) { score += 8; reasons.push({ label: 'Big TG', pts: 8, pass: true }); }
  else reasons.push({ label: 'TG small', pts: 0, pass: false });
  if (coin.priceChange1h > 0) { score += 5; reasons.push({ label: 'Positive', pts: 5, pass: true }); }
  else reasons.push({ label: 'Positive', pts: 0, pass: false });
  if (coin.volume24h / (coin.marketCapUsd || 1) > 0.15) { score += 5; reasons.push({ label: 'High vol', pts: 5, pass: true }); }
  else reasons.push({ label: 'High vol', pts: 0, pass: false });
  if (coin.ageMinutes < 30) { score += 7; reasons.push({ label: 'Fresh', pts: 7, pass: true }); }
  else reasons.push({ label: 'Old', pts: 0, pass: false });
  return { score: Math.min(score, 100), reasons };
}

const seenCoins = new Set();

async function pollPumpFun() {
  try {
    const res = await fetch('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=desc&includeNsfw=false', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let newCount = 0;
    for (const raw of (data || [])) {
      if (seenCoins.has(raw.mint)) continue;
      seenCoins.add(raw.mint);
      if (seenCoins.size > 1000) { const first = seenCoins.values().next().value; seenCoins.delete(first); }
      const ageMinutes = Math.floor((Date.now() - new Date(raw.created_timestamp || Date.now()).getTime()) / 60000);
      const coin = {
        id: raw.mint, mint: raw.mint,
        name: raw.name || 'Unknown', ticker: raw.symbol || '???',
        imageUrl: raw.image_uri || '',
        marketCapUsd: raw.market_cap || 0,
        priceUsd: raw.price || 0,
        priceChange1h: raw.price_change_1h || 0,
        volume24h: raw.volume_24h || 0,
        liquidityUsd: (raw.virtual_sol_reserves || 0) * 150,
        liquidityLocked: raw.is_locked === true,
        mintAuthorityRevoked: raw.mint_authority === null || raw.mint_authority === '',
        hasMintFunction: !(raw.mint_authority === null || raw.mint_authority === ''),
        freezeAuthorityRevoked: raw.freeze_authority === null,
        top10HoldersPct: 0, topHolders: [],
        telegramMembers: raw.telegram_members || 0,
        twitterFollowers: raw.twitter_followers || 0,
        telegramUrl: raw.telegram || '', twitterUrl: raw.twitter || '',
        websiteUrl: raw.website || '',
        ageMinutes,
        pumpUrl: `https://pump.fun/coin/${raw.mint}`,
        dexUrl: `https://dexscreener.com/solana/${raw.mint}`,
        birdeyeUrl: `https://birdeye.so/token/${raw.mint}?chain=solana`,
        solscanUrl: `https://solscan.io/token/${raw.mint}`,
      };
      const { score, reasons } = scoreCoin(coin);
      coin.score = score; coin.scoreBreakdown = reasons;
      coin.scoreLabel = score >= 70 ? 'HOT' : score >= 45 ? 'WATCH' : 'WEAK';
      console.log(`[COIN] $${coin.ticker} — ${score}/100 (${coin.scoreLabel})`);
      broadcast({ type: 'coin', coin });
      if (score >= 70) broadcast({ type: 'alert', coin });
      newCount++;
    }
    if (newCount > 0) console.log(`[POLL] ${newCount} new coins found`);
  } catch (e) {
    console.error('[POLL ERROR]', e.message);
  }
  setTimeout(pollPumpFun, 10000);
}

app.get('/api/status', (req, res) => res.json({ clients: clients.size, seen: seenCoins.size }));
app.get('/api/recent', async (req, res) => {
  try {
    const r = await fetch('https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=desc', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Origin': 'https://pump.fun' }
    });
    const data = await r.json();
    res.json(data || []);
  } catch(e) { res.json([]); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Memecoin Scanner running on port ${PORT}`);
  pollPumpFun();
});
