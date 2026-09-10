const express = require('express');
const http = require('http');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.static(path.join(__dirname, '../public')));

function score(c) {
  let s = 0;
  if (c.marketCapUsd > 0 && c.marketCapUsd < 2000000) s += 20;
  if (c.priceChange1h > 0) s += 15;
  if (c.volume24h > 0 && c.marketCapUsd > 0 && c.volume24h / c.marketCapUsd > 0.1) s += 15;
  if (c.liquidityUsd > 5000) s += 15;
  if (c.ageMinutes < 60) s += 20;
  if (c.ageMinutes < 30) s += 15;
  return Math.min(s, 100);
}

app.get('/api/recent', async (req, res) => {
  try {
    const r = await fetch(
      'https://api.dexscreener.com/token-boosts/latest/v1',
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await r.json();
    const solana = (Array.isArray(data) ? data : [])
      .filter(t => t.chainId === 'solana')
      .slice(0, 40);

    const coins = await Promise.all(solana.map(async (t) => {
      try {
        const pr = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`,
          { headers: { 'Accept': 'application/json' } }
        );
        const pd = await pr.json();
        const pair = pd.pairs && pd.pairs[0];
        const mcap = pair?.fdv || 0;
        const vol = pair?.volume?.h24 || 0;
        const chg = pair?.priceChange?.h1 || 0;
        const liq = pair?.liquidity?.usd || 0;
        const age = pair?.pairCreatedAt
          ? Math.floor((Date.now() - pair.pairCreatedAt) / 60000)
          : 30;
        const c = {
          id: t.tokenAddress,
          mint: t.tokenAddress,
          name: pair?.baseToken?.name || t.description || 'Unknown',
          ticker: pair?.baseToken?.symbol || '???',
          imageUrl: t.icon || '',
          marketCapUsd: mcap,
          priceChange1h: chg,
          volume24h: vol,
          liquidityUsd: liq,
          mintAuthorityRevoked: true,
          hasMintFunction: false,
          ageMinutes: isNaN(age) || age < 0 ? 30 : age,
          pumpUrl: `https://pump.fun/coin/${t.tokenAddress}`,
          dexUrl: `https://dexscreener.com/solana/${t.tokenAddress}`,
          birdeyeUrl: `https://birdeye.so/token/${t.tokenAddress}?chain=solana`,
        };
        c.score = score(c);
        return c;
      } catch(e) {
        return null;
      }
    }));

    res.json(coins.filter(Boolean));
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
