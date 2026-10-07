const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTING_CASH = 1000000;

const dataDir = path.join(__dirname, 'data');
const portfolioFile = path.join(dataDir, 'portfolio.json');
const stockUniverse = require('./data/stockUniverse.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(portfolioFile)) {
  fs.writeFileSync(
    portfolioFile,
    JSON.stringify({ cashBalance: STARTING_CASH, realizedPnl: 0, holdings: [] }, null, 2),
    'utf8'
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readPortfolio() {
  const fileContents = fs.readFileSync(portfolioFile, 'utf8');
  return JSON.parse(fileContents);
}

function writePortfolio(portfolio) {
  fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2), 'utf8');
}

function roundTo(value, decimals = 2) {
  return Number(value.toFixed(decimals));
}

function findStock(symbol) {
  return stockUniverse.find((stock) => stock.symbol === symbol);
}

async function getQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const result = response.data?.chart?.result?.[0];
    const meta = result?.meta;

    if (meta && Number.isFinite(meta.regularMarketPrice)) {
      return {
        symbol,
        ltp: roundTo(meta.regularMarketPrice),
        currency: meta.currency || 'INR',
      };
    }

    if (result && Array.isArray(result.indicators?.quote) && result.indicators.quote[0]) {
      const close = result.indicators.quote[0].close?.slice(-1)?.[0];
      if (Number.isFinite(close)) {
        return { symbol, ltp: roundTo(close), currency: 'INR' };
      }
    }
  } catch (error) {
    console.warn(`Unable to fetch latest price for ${symbol}: ${error.message}`);
  }

  return { symbol, ltp: 0, currency: 'INR' };
}

async function buildPortfolioSnapshot(portfolio) {
  const quoteMap = new Map();

  for (const holding of portfolio.holdings) {
    const quote = await getQuote(holding.symbol);
    quoteMap.set(holding.symbol, quote);
  }

  const holdings = portfolio.holdings.map((holding) => {
    const stockInfo = findStock(holding.symbol);
    const quote = quoteMap.get(holding.symbol) || { symbol: holding.symbol, ltp: 0, currency: 'INR' };
    const ltp = Number(quote.ltp) || 0;
    const investedValue = roundTo(holding.avgBuyPrice * holding.qty);
    const marketValue = roundTo(ltp * holding.qty);
    const pnl = roundTo(marketValue - investedValue);

    return {
      symbol: holding.symbol,
      company: stockInfo ? stockInfo.name : holding.symbol,
      qty: holding.qty,
      avgBuyPrice: roundTo(holding.avgBuyPrice),
      ltp: roundTo(ltp),
      investedValue,
      marketValue,
      pnl,
      percentChange: holding.avgBuyPrice > 0 ? roundTo(((ltp - holding.avgBuyPrice) / holding.avgBuyPrice) * 100) : 0,
    };
  });

  const totalInvested = roundTo(holdings.reduce((sum, item) => sum + item.investedValue, 0));
  const totalMarketValue = roundTo(holdings.reduce((sum, item) => sum + item.marketValue, 0));
  const unrealizedPnl = roundTo(holdings.reduce((sum, item) => sum + item.pnl, 0));
  const totalPnl = roundTo(unrealizedPnl + Number(portfolio.realizedPnl || 0));

  return {
    cashBalance: roundTo(Number(portfolio.cashBalance || 0)),
    realizedPnl: roundTo(Number(portfolio.realizedPnl || 0)),
    totalInvested,
    totalMarketValue,
    totalPnl,
    totalBalance: roundTo(Number(portfolio.cashBalance || 0) + totalMarketValue),
    holdings,
    startingCash: STARTING_CASH,
  };
}

app.get('/api/stocks', (req, res) => {
  res.json({ stocks: stockUniverse });
});

app.get('/api/stock/:symbol/quote', async (req, res) => {
  try {
    const { symbol } = req.params;
    const stock = findStock(symbol);

    if (!stock) {
      return res.status(404).json({ error: 'Stock not found in the Nifty 500 universe.' });
    }

    const quote = await getQuote(symbol);
    res.json({ symbol, company: stock.name, ltp: quote.ltp, currency: quote.currency || 'INR' });
  } catch (error) {
    res.status(500).json({ error: 'Unable to fetch stock quote.' });
  }
});

app.get('/api/portfolio', async (req, res) => {
  try {
    const portfolio = readPortfolio();
    const snapshot = await buildPortfolioSnapshot(portfolio);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load portfolio.' });
  }
});

app.post('/api/portfolio/buy', (req, res) => {
  try {
    const { symbol, qty, buyPrice } = req.body;

    if (!symbol || !qty || !buyPrice) {
      return res.status(400).json({ error: 'Symbol, quantity, and buy price are required.' });
    }

    const stock = findStock(symbol);
    if (!stock) {
      return res.status(400).json({ error: 'Stock not found in the NSE 500 universe.' });
    }

    const quantity = Number(qty);
    const price = Number(buyPrice);

    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Quantity and buy price must be positive numbers.' });
    }

    const portfolio = readPortfolio();
    const totalCost = quantity * price;

    if (portfolio.cashBalance < totalCost) {
      return res.status(400).json({ error: 'Not enough virtual balance for this trade.' });
    }

    const existing = portfolio.holdings.find((item) => item.symbol === symbol);

    if (existing) {
      const totalQty = existing.qty + quantity;
      const weightedAverage = ((existing.avgBuyPrice * existing.qty) + totalCost) / totalQty;
      existing.qty = totalQty;
      existing.avgBuyPrice = weightedAverage;
    } else {
      portfolio.holdings.push({ symbol, qty: quantity, avgBuyPrice: price });
    }

    portfolio.cashBalance = roundTo(portfolio.cashBalance - totalCost);
    writePortfolio(portfolio);

    res.json({ success: true, message: `${quantity} shares of ${symbol} added to your portfolio.` });
  } catch (error) {
    res.status(500).json({ error: 'Unable to process buy order.' });
  }
});

app.post('/api/portfolio/sell', (req, res) => {
  try {
    const { symbol, qty, sellPrice } = req.body;

    if (!symbol || !qty || !sellPrice) {
      return res.status(400).json({ error: 'Symbol, quantity, and sell price are required.' });
    }

    const quantity = Number(qty);
    const price = Number(sellPrice);

    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Quantity and sell price must be positive numbers.' });
    }

    const portfolio = readPortfolio();
    const holding = portfolio.holdings.find((item) => item.symbol === symbol);

    if (!holding) {
      return res.status(400).json({ error: 'This stock is not present in your portfolio.' });
    }

    if (holding.qty < quantity) {
      return res.status(400).json({ error: 'You cannot sell more shares than you own.' });
    }

    const proceeds = quantity * price;
    const realizedGain = (price - holding.avgBuyPrice) * quantity;

    holding.qty -= quantity;
    portfolio.cashBalance = roundTo(portfolio.cashBalance + proceeds);
    portfolio.realizedPnl = roundTo((Number(portfolio.realizedPnl) || 0) + realizedGain);

    if (holding.qty === 0) {
      portfolio.holdings = portfolio.holdings.filter((item) => item.symbol !== symbol);
    }

    writePortfolio(portfolio);
    res.json({ success: true, message: `${quantity} shares of ${symbol} sold successfully.` });
  } catch (error) {
    res.status(500).json({ error: 'Unable to process sell order.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Virtual portfolio manager running at http://localhost:${PORT}`);
});

module.exports = app;
