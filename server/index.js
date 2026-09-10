const express = require('express');
const http = require('http');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.static(path.join(__dirname, '../public')));

const seen = new Set();

function score(c) {
  let s = 0;
  if (c.liquidityLocked) s += 25;
  if (c.mintAuthorityRevoked) s += 20;
  if (!c.hasMintFunction) s += 15;
  if (c.marketCapUsd < 2000000) s += 15;
  if (c.top10HoldersPct < 30) s += 10;
  if (c.priceChange1h > 0) s += 5;
  if (c.volume24h / (c.marketCapUsd || 1) > 0.15) s += 5;
  if (c.ageMinutes < 30) s += 7;
  return Math.min(s, 100);
}

app.get('/api/recent', async (req, res) => {
  try {
    const r = await fetch(
      'https://api.dexscreener.com/token-profiles/latest/v1',
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await r.json();
    const coins = (data || [])
      .filter(t => t.chainId === 'solana')
      .slice(0, 30)
      .map(t => {
        const age = Math.floor((Date.now() - new Date(t.header || Date.now()).getTime()) / 60000);
        const mcap = t.marketCap || 0;
        const vol = t.volume?.h24 || 0;
        const chg = t.priceChange?.h1 || 0;
        const c = {
          id: t.tokenAddress,
          mint: t.tokenAddress,
          name: t.description || t.tokenAddress?.slice(0, 8) || 'Unknown',
          ticker: t.symbol || '???',
          imageUrl: t.icon || '',
          marketCapUsd: mcap,
          priceChange1h: chg,
          volume24h: vol,
          liquidityUsd: t.liquidity?.usd || 0,
          liquidityLocked: false,
          mintAuthorityRevoked: true,
          hasMintFunction: false,
          top10HoldersPct: 0,
          telegramMembers: 0,
          ageMinutes: isNaN(age) || age < 0 ? 30 : age,
          pumpUrl: `https://pump.fun/coin/${t.tokenAddress}`,
          dexUrl: `https://dexscreener.com/solana/${t.tokenAddress}`,
          birdeyeUrl: `https://birdeye.so/token/${t.tokenAddress}?chain=solana`,
          solscanUrl: `https://solscan.io/token/${t.tokenAddress}`,
        };
        c.score = score(c);
        c.scoreLabel = c.score >= 70 ? 'HOT' : c.score >= 45 ? 'WATCH' : 'WEAK';
        return c;
      });
    res.json(coins);
  } catch (e) {
    console.error(e.message);
    res.json([]);
  }
});

app.get('/api/status', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
http.createServer(app).listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
