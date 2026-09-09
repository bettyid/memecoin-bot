/**
 * Pump.fun Memecoin Scanner — Backend Server
 * ==========================================
 * Connects to Pump.fun's real-time WebSocket feed,
 * scores every new coin against ×100 criteria,
 * and relays alerts to the frontend via WebSocket.
 *
 * Run:  node server/index.js
 * Then: open http://localhost:3000
 */

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

// ── WebSocket server (broadcasts to browser clients) ────────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);
  ws.send(JSON.stringify({ type: 'status', message: 'Connected to scanner' }));
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => { clients.delete(ws); });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ── Scoring engine ────────────────────────────────────────────────────────────
function scoreCoin(coin) {
  let score = 0;
  const reasons = [];

  // Safety checks
  if (coin.liquidityLocked) { score += 25; reasons.push({ label: 'Liq locked', pts: 25, pass: true }); }
  else reasons.push({ label: 'Liq locked', pts: 0, pass: false });

  if (coin.mintAuthorityRevoked) { score += 20; reasons.push({ label: 'Renounced', pts: 20, pass: true }); }
  else reasons.push({ label: 'Renounced', pts: 0, pass: false });

  if (!coin.hasMintFunction) { score += 15; reasons.push({ label: 'No mint', pts: 15, pass: true }); }
  else reasons.push({ label: 'No mint', pts: 0, pass: false });

  // Market cap
  if (coin.marketCapUsd < 2_000_000) { score += 15; reasons.push({ label: 'Low mcap', pts: 15, pass: true }); }
  else if (coin.marketCapUsd < 5_000_000) { score += 7; reasons.push({ label: 'Med mcap', pts: 7, pass: true }); }
  else reasons.push({ label: 'Low mcap', pts: 0, pass: false });

  // Whale concentration
  if (coin.top10HoldersPct < 30) { score += 10; reasons.push({ label: 'Low whale', pts: 10, pass: true }); }
  else reasons.push({ label: 'Low whale', pts: 0, pass: false });

  // Community
  if (coin.telegramMembers > 1000) { score += 8; reasons.push({ label: 'Big TG', pts: 8, pass: true }); }
  else if (coin.telegramMembers > 300) { score += 4; reasons.push({ label: 'TG ok', pts: 4, pass: true }); }
  else reasons.push({ label: 'TG small', pts: 0, pass: false });

  if (coin.telegramGrowthPerHour > 100) { score += 7; reasons.push({ label: 'TG growth', pts: 7, pass: true }); }
  else reasons.push({ label: 'TG growth', pts: 0, pass: false });

  // Momentum
  if (coin.priceChange1h > 0) { score += 5; reasons.push({ label: 'Positive', pts: 5, pass: true }); }
  else reasons.push({ label: 'Positive', pts: 0, pass: false });

  // Vol/mcap ratio (high = real activity)
  if (coin.volume24h / coin.marketCapUsd > 0.15) { score += 5; reasons.push({ label: 'High vol', pts: 5, pass: true }); }
  else reasons.push({ label: 'High vol', pts: 0, pass: false });

  // Freshness
  if (coin.ageMinutes < 30) { score += 5; reasons.push({ label: 'Fresh', pts: 5, pass: true }); }
  else if (coin.ageMinutes < 120) { score += 2; reasons.push({ label: 'New', pts: 2, pass: true }); }
  else reasons.push({ label: 'Old', pts: 0, pass: false });

  return { score: Math.min(score, 100), reasons };
}

// ── Pump.fun WebSocket connection ─────────────────────────────────────────────
const PUMP_WS = 'wss://frontend-api.pump.fun/ws';
const PUMP_API = 'https://frontend-api.pump.fun';
let pumpSocket = null;
let reconnectTimer = null;
let seenCoins = new Map(); // mint -> coin data

async function fetchCoinDetails(mint) {
  try {
    const res = await fetch(`${PUMP_API}/coins/${mint}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 5000
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchHolders(mint) {
  try {
    const res = await fetch(`${PUMP_API}/coins/${mint}/holders?limit=10`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 5000
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.holders || [];
  } catch (e) {
    return [];
  }
}

async function processCoin(raw) {
  const mint = raw.mint;
  if (seenCoins.has(mint)) return;
  seenCoins.set(mint, true);

  // Keep memory lean
  if (seenCoins.size > 500) {
    const firstKey = seenCoins.keys().next().value;
    seenCoins.delete(firstKey);
  }

  // Fetch full details
  const details = await fetchCoinDetails(mint);
  if (!details) return;

  const holders = await fetchHolders(mint);
  const top10Sum = holders.slice(0, 10).reduce((acc, h) => acc + (h.percentage || 0), 0);

  const ageMinutes = Math.floor((Date.now() - new Date(details.created_timestamp || Date.now()).getTime()) / 60000);

  const coin = {
    // Identity
    id: mint,
    mint,
    name: details.name || raw.name || 'Unknown',
    ticker: details.symbol || raw.symbol || '???',
    description: details.description || '',
    imageUrl: details.image_uri || '',

    // Market data
    marketCapUsd: details.market_cap || raw.market_cap || 0,
    priceUsd: details.price || 0,
    priceChange1h: details.price_change_1h || 0,
    volume24h: details.volume_24h || 0,
    liquidityUsd: details.virtual_sol_reserves ? details.virtual_sol_reserves * 150 : 0,

    // Safety
    liquidityLocked: details.is_locked === true,
    mintAuthorityRevoked: details.mint_authority === null || details.mint_authority === '',
    hasMintFunction: !(details.mint_authority === null || details.mint_authority === ''),
    freezeAuthorityRevoked: details.freeze_authority === null,

    // Holders
    top10HoldersPct: top10Sum,
    topHolders: holders.slice(0, 5).map(h => ({
      address: h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : '???',
      pct: (h.percentage || 0).toFixed(2)
    })),

    // Community (Pump.fun exposes these if present)
    telegramMembers: details.telegram_members || 0,
    telegramGrowthPerHour: details.telegram_growth || 0,
    twitterFollowers: details.twitter_followers || 0,
    websiteUrl: details.website || '',
    telegramUrl: details.telegram || '',
    twitterUrl: details.twitter || '',

    // Meta
    ageMinutes,
    pumpUrl: `https://pump.fun/coin/${mint}`,
    dexUrl: `https://dexscreener.com/solana/${mint}`,
    birdeyeUrl: `https://birdeye.so/token/${mint}?chain=solana`,
    solscanUrl: `https://solscan.io/token/${mint}`,
    createdAt: details.created_timestamp || new Date().toISOString()
  };

  const { score, reasons } = scoreCoin(coin);
  coin.score = score;
  coin.scoreBreakdown = reasons;

  const label = score >= 70 ? 'HOT' : score >= 45 ? 'WATCH' : 'WEAK';
  coin.scoreLabel = label;

  console.log(`[COIN] $${coin.ticker} — Score: ${score}/100 (${label}) — MCap: $${Math.round(coin.marketCapUsd).toLocaleString()}`);

  broadcast({ type: 'coin', coin });

  if (score >= 70) {
    console.log(`[🔥 ALERT] $${coin.ticker} scored ${score}/100 — ${coin.pumpUrl}`);
    broadcast({ type: 'alert', coin });
  }
}

function connectToPumpFun() {
  if (pumpSocket) {
    try { pumpSocket.terminate(); } catch (e) {}
    pumpSocket = null;
  }

  console.log('[Pump.fun] Connecting to WebSocket...');
  broadcast({ type: 'status', message: 'Connecting to Pump.fun...' });

  pumpSocket = new WebSocket(PUMP_WS, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://pump.fun'
    }
  });

  pumpSocket.on('open', () => {
    console.log('[Pump.fun] Connected ✓');
    broadcast({ type: 'status', message: 'Live — connected to Pump.fun' });

    // Subscribe to new coin creations
    pumpSocket.send(JSON.stringify({ method: 'subscribeNewToken' }));

    // Subscribe to trades on existing coins
    pumpSocket.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [] }));
  });

  pumpSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.txType === 'create' || msg.type === 'newToken') {
        await processCoin(msg);
      } else if (msg.mint && msg.txType === 'buy') {
        // Price update for existing coin
        broadcast({ type: 'trade', mint: msg.mint, price: msg.tokenAmount, sol: msg.solAmount });
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  pumpSocket.on('close', (code, reason) => {
    console.log(`[Pump.fun] Disconnected (${code}). Reconnecting in 5s...`);
    broadcast({ type: 'status', message: 'Disconnected — reconnecting...' });
    reconnectTimer = setTimeout(connectToPumpFun, 5000);
  });

  pumpSocket.on('error', (err) => {
    console.error('[Pump.fun] WebSocket error:', err.message);
    broadcast({ type: 'status', message: 'Connection error — retrying...' });
  });

  // Keep-alive ping every 30s
  const pingInterval = setInterval(() => {
    if (pumpSocket && pumpSocket.readyState === WebSocket.OPEN) {
      pumpSocket.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
}

// ── REST API endpoints ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    connected: pumpSocket && pumpSocket.readyState === WebSocket.OPEN,
    clients: clients.size,
    coinsTracked: seenCoins.size
  });
});

app.get('/api/recent', async (req, res) => {
  try {
    const response = await fetch(`${PUMP_API}/coins?offset=0&limit=20&sort=created_timestamp&order=desc&includeNsfw=false`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const data = await response.json();
    const coins = await Promise.all((data || []).slice(0, 10).map(async (raw) => {
      const ageMinutes = Math.floor((Date.now() - new Date(raw.created_timestamp || Date.now()).getTime()) / 60000);
      const coin = {
        id: raw.mint,
        mint: raw.mint,
        name: raw.name,
        ticker: raw.symbol,
        marketCapUsd: raw.market_cap || 0,
        priceUsd: raw.price || 0,
        priceChange1h: raw.price_change_1h || 0,
        volume24h: raw.volume_24h || 0,
        liquidityLocked: raw.is_locked === true,
        mintAuthorityRevoked: raw.mint_authority === null,
        hasMintFunction: !(raw.mint_authority === null),
        freezeAuthorityRevoked: raw.freeze_authority === null,
        top10HoldersPct: 0,
        topHolders: [],
        telegramMembers: raw.telegram_members || 0,
        telegramGrowthPerHour: 0,
        twitterFollowers: raw.twitter_followers || 0,
        ageMinutes,
        pumpUrl: `https://pump.fun/coin/${raw.mint}`,
        dexUrl: `https://dexscreener.com/solana/${raw.mint}`,
        birdeyeUrl: `https://birdeye.so/token/${raw.mint}?chain=solana`,
        solscanUrl: `https://solscan.io/token/${raw.mint}`,
        imageUrl: raw.image_uri || '',
        createdAt: raw.created_timestamp
      };
      const { score, reasons } = scoreCoin(coin);
      coin.score = score;
      coin.scoreBreakdown = reasons;
      coin.scoreLabel = score >= 70 ? 'HOT' : score >= 45 ? 'WATCH' : 'WEAK';
      return coin;
    }));
    res.json(coins);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Memecoin Scanner — v1.0            ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  UI:  http://localhost:${PORT}          ║`);
  console.log(`║  API: http://localhost:${PORT}/api      ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  connectToPumpFun();
});

process.on('SIGINT', () => {
  console.log('\n[Shutting down...]');
  if (pumpSocket) pumpSocket.terminate();
  clearTimeout(reconnectTimer);
  server.close(() => process.exit(0));
});
  
