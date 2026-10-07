require('dotenv').config();

const express = require('express');
const path = require('path');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTING_CASH = 1000000;
const QUOTE_REQUEST_TIMEOUT_MS = 6000;
const QUOTE_BATCH_TIMEOUT_MS = 30000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Set it in the environment before starting the app.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

const stockUniverse = require('./data/stockUniverse.json');
const nifty50Symbols = require('./data/nifty50Symbols.json');
const stockBySymbol = new Map(stockUniverse.map((stock) => [stock.symbol, stock]));
const quoteCache = new Map();
const quoteRequests = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_state (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbols JSONB NOT NULL,
      is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      watchlist_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT,
      rule_name TEXT NOT NULL,
      rule_code TEXT NOT NULL DEFAULT '',
      watchlist_id TEXT NOT NULL,
      matched_symbols JSONB NOT NULL,
      trades JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS rule_code TEXT NOT NULL DEFAULT \'\'');

  const presets = [
    { id: 'nifty-50', name: 'Nifty 50', symbols: nifty50Symbols },
    { id: 'nifty-500', name: 'Nifty 500', symbols: stockUniverse.map((stock) => stock.symbol) },
  ];
  for (const preset of presets) {
    await pool.query(
      `
        INSERT INTO watchlists (id, name, symbols, is_builtin)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, symbols = EXCLUDED.symbols, is_builtin = TRUE
      `,
      [preset.id, preset.name, JSON.stringify(preset.symbols)]
    );
  }
  await pool.query(
    'INSERT INTO portfolio_state (id, state) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    ['default', JSON.stringify({ cashBalance: STARTING_CASH, realizedPnl: 0, holdings: [] })]
  );
}

async function readPortfolio() {
  const { rows } = await pool.query('SELECT state FROM portfolio_state WHERE id = $1', ['default']);

  if (rows.length > 0) {
    return rows[0].state;
  }

  const initialPortfolio = { cashBalance: STARTING_CASH, realizedPnl: 0, holdings: [] };
  await writePortfolio(initialPortfolio);
  return initialPortfolio;
}

async function writePortfolio(portfolio) {
  await pool.query(
    `
      INSERT INTO portfolio_state (id, state)
      VALUES ('default', $1)
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state
    `,
    [JSON.stringify(portfolio)]
  );
}

async function withLockedPortfolio(update) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT state FROM portfolio_state WHERE id = $1 FOR UPDATE',
      ['default']
    );
    if (!rows.length) {
      throw Object.assign(new Error('Portfolio state is unavailable.'), { statusCode: 500 });
    }
    const result = await update(rows[0].state);
    await client.query(
      'UPDATE portfolio_state SET state = $1 WHERE id = $2',
      [JSON.stringify(rows[0].state), 'default']
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function roundTo(value, decimals = 2) {
  return Number(value.toFixed(decimals));
}

function findStock(symbol) {
  return stockBySymbol.get(symbol);
}

function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols)) {
    throw new Error('Symbols must be an array.');
  }

  const uniqueSymbols = [...new Set(symbols)];
  if (uniqueSymbols.length === 0 || uniqueSymbols.length > stockUniverse.length) {
    throw new Error(`Choose between 1 and ${stockUniverse.length} stocks.`);
  }

  const invalidSymbol = uniqueSymbols.find((symbol) => !findStock(symbol));
  if (invalidSymbol) {
    throw new Error(`Unknown stock symbol: ${invalidSymbol}`);
  }

  return uniqueSymbols;
}

async function getQuotesForSymbols(symbols, concurrency = 8) {
  const quotes = new Array(symbols.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, symbols.length);
  const deadline = Date.now() + QUOTE_BATCH_TIMEOUT_MS;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < symbols.length && Date.now() < deadline) {
      const index = nextIndex++;
      quotes[index] = await getQuote(symbols[index]);
    }
  }));

  return symbols.map((symbol, index) => quotes[index] || {
    symbol,
    ltp: 0,
    previousClose: null,
    dailyChangePercent: null,
    currency: 'INR',
  });
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;

  try {
    const response = await axios.get(url, { timeout: QUOTE_REQUEST_TIMEOUT_MS });
    const result = response.data?.chart?.result?.[0];
    const meta = result?.meta;

    if (meta && Number.isFinite(meta.regularMarketPrice)) {
      return {
        symbol,
        ltp: roundTo(meta.regularMarketPrice),
        previousClose: Number.isFinite(meta.chartPreviousClose) ? roundTo(meta.chartPreviousClose) : null,
        dailyChangePercent: Number.isFinite(meta.regularMarketChangePercent)
          ? roundTo(meta.regularMarketChangePercent, 4)
          : null,
        currency: meta.currency || 'INR',
      };
    }

    if (result && Array.isArray(result.indicators?.quote) && result.indicators.quote[0]) {
      const close = result.indicators.quote[0].close?.slice(-1)?.[0];
      if (Number.isFinite(close)) {
        return {
          symbol,
          ltp: roundTo(close),
          previousClose: Number.isFinite(result.meta?.chartPreviousClose) ? roundTo(result.meta.chartPreviousClose) : null,
          dailyChangePercent: null,
          currency: 'INR',
        };
      }
    }
  } catch (error) {
    console.warn(`Unable to fetch latest price for ${symbol}: ${error.message}`);
  }

  return { symbol, ltp: 0, previousClose: null, dailyChangePercent: null, currency: 'INR' };
}

async function getQuote(symbol) {
  const cached = quoteCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;
  if (quoteRequests.has(symbol)) return quoteRequests.get(symbol);

  const request = fetchQuote(symbol).then((quote) => {
    quoteCache.set(symbol, {
      quote,
      expiresAt: Date.now() + (quote.ltp > 0 ? 15000 : 5000),
    });
    return quote;
  }).finally(() => quoteRequests.delete(symbol));
  quoteRequests.set(symbol, request);
  return request;
}

async function buildPortfolioSnapshot(portfolio) {
  const quoteMap = new Map((await getQuotesForSymbols(portfolio.holdings.map((holding) => holding.symbol)))
    .map((quote) => [quote.symbol, quote]));

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

app.get('/api/watchlists', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, symbols, is_builtin AS "isBuiltin", updated_at AS "updatedAt" FROM watchlists ORDER BY is_builtin DESC, name ASC'
    );
    res.json({ watchlists: rows });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load watchlists.' });
  }
});

app.post('/api/watchlists', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 80) {
      return res.status(400).json({ error: 'Watchlist name must be between 1 and 80 characters.' });
    }
    const symbols = normalizeSymbols(req.body.symbols);
    const id = randomUUID();
    const { rows } = await pool.query(
      'INSERT INTO watchlists (id, name, symbols) VALUES ($1, $2, $3) RETURNING id, name, symbols, is_builtin AS "isBuiltin", updated_at AS "updatedAt"',
      [id, name, JSON.stringify(symbols)]
    );
    res.status(201).json({ watchlist: rows[0] });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to create watchlist.' });
  }
});

app.put('/api/watchlists/:id', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 80) {
      return res.status(400).json({ error: 'Watchlist name must be between 1 and 80 characters.' });
    }
    const symbols = normalizeSymbols(req.body.symbols);
    const { rows } = await pool.query(
      'UPDATE watchlists SET name = $2, symbols = $3, updated_at = NOW() WHERE id = $1 AND is_builtin = FALSE RETURNING id, name, symbols, is_builtin AS "isBuiltin", updated_at AS "updatedAt"',
      [req.params.id, name, JSON.stringify(symbols)]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Custom watchlist not found.' });
    }
    res.json({ watchlist: rows[0] });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to update watchlist.' });
  }
});

app.delete('/api/watchlists/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM watchlists WHERE id = $1 AND is_builtin = FALSE',
      [req.params.id]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Custom watchlist not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to delete watchlist.' });
  }
});

app.get('/api/rules', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, code, watchlist_id AS "watchlistId", created_at AS "createdAt", updated_at AS "updatedAt" FROM saved_rules ORDER BY updated_at DESC'
    );
    res.json({ rules: rows });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load saved rules.' });
  }
});

app.post('/api/rules', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '');
    if (!name || name.length > 80 || !code.trim() || code.length > 25000) {
      return res.status(400).json({ error: 'Provide a rule name and Python code under 25,000 characters.' });
    }
    const id = randomUUID();
    const watchlistId = req.body.watchlistId || null;
    const { rows } = await pool.query(
      'INSERT INTO saved_rules (id, name, code, watchlist_id) VALUES ($1, $2, $3, $4) RETURNING id, name, code, watchlist_id AS "watchlistId", created_at AS "createdAt", updated_at AS "updatedAt"',
      [id, name, code, watchlistId]
    );
    res.status(201).json({ rule: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save rule.' });
  }
});

app.put('/api/rules/:id', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '');
    if (!name || name.length > 80 || !code.trim() || code.length > 25000) {
      return res.status(400).json({ error: 'Provide a rule name and Python code under 25,000 characters.' });
    }
    const { rows } = await pool.query(
      'UPDATE saved_rules SET name = $2, code = $3, watchlist_id = $4, updated_at = NOW() WHERE id = $1 RETURNING id, name, code, watchlist_id AS "watchlistId", created_at AS "createdAt", updated_at AS "updatedAt"',
      [req.params.id, name, code, req.body.watchlistId || null]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Saved rule not found.' });
    }
    res.json({ rule: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update rule.' });
  }
});

app.delete('/api/rules/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM saved_rules WHERE id = $1', [req.params.id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Saved rule not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to delete rule.' });
  }
});

app.get('/api/market/quotes', async (req, res) => {
  try {
    const requestedSymbols = String(req.query.symbols || '').split(',').filter(Boolean);
    const symbols = [...new Set(requestedSymbols)];
    if (!symbols.length || symbols.length > stockUniverse.length || symbols.some((symbol) => !findStock(symbol))) {
      return res.status(400).json({ error: 'Provide between 1 and 500 valid stock symbols.' });
    }
    const quotes = await getQuotesForSymbols(symbols);
    res.json({
      quotes: quotes.map((quote) => ({
        ...quote,
        name: findStock(quote.symbol).name,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load watchlist quotes.' });
  }
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
    const portfolio = await readPortfolio();
    const snapshot = await buildPortfolioSnapshot(portfolio);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load portfolio.' });
  }
});

app.post('/api/portfolio/buy', async (req, res) => {
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

    const result = await withLockedPortfolio((portfolio) => {
      const totalCost = quantity * price;
      if (portfolio.cashBalance < totalCost) {
        throw Object.assign(new Error('Not enough virtual balance for this trade.'), { statusCode: 400 });
      }

      const existing = portfolio.holdings.find((item) => item.symbol === symbol);
      if (existing) {
        const totalQty = existing.qty + quantity;
        existing.avgBuyPrice = ((existing.avgBuyPrice * existing.qty) + totalCost) / totalQty;
        existing.qty = totalQty;
      } else {
        portfolio.holdings.push({ symbol, qty: quantity, avgBuyPrice: price });
      }

      portfolio.cashBalance = roundTo(portfolio.cashBalance - totalCost);
      return { success: true, message: `${quantity} shares of ${symbol} added to your portfolio.` };
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to process buy order.' });
  }
});

app.post('/api/portfolio/sell', async (req, res) => {
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

    const result = await withLockedPortfolio((portfolio) => {
      const holding = portfolio.holdings.find((item) => item.symbol === symbol);
      if (!holding) {
        throw Object.assign(new Error('This stock is not present in your portfolio.'), { statusCode: 400 });
      }
      if (holding.qty < quantity) {
        throw Object.assign(new Error('You cannot sell more shares than you own.'), { statusCode: 400 });
      }

      const proceeds = quantity * price;
      const realizedGain = (price - holding.avgBuyPrice) * quantity;
      holding.qty -= quantity;
      portfolio.cashBalance = roundTo(portfolio.cashBalance + proceeds);
      portfolio.realizedPnl = roundTo((Number(portfolio.realizedPnl) || 0) + realizedGain);
      if (holding.qty === 0) {
        portfolio.holdings = portfolio.holdings.filter((item) => item.symbol !== symbol);
      }

      return { success: true, message: `${quantity} shares of ${symbol} sold successfully.` };
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to process sell order.' });
  }
});

app.get('/api/strategy-runs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, rule_id AS "ruleId", rule_name AS "ruleName", rule_code AS "ruleCode", watchlist_id AS "watchlistId", matched_symbols AS "matchedSymbols", trades, created_at AS "createdAt" FROM strategy_runs ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ runs: rows });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load rule run history.' });
  }
});

app.post('/api/strategy-runs', async (req, res) => {
  const rawMatchedSymbols = req.body?.matchedSymbols;
  if (!Array.isArray(rawMatchedSymbols)) {
    return res.status(400).json({ error: 'Provide the rule results as an array of stock symbols.' });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    const { watchlistId } = req.body;
    const matchedSymbols = [...new Set(rawMatchedSymbols)];
    const investmentPerStock = Number(req.body.investmentPerStock);
    let ruleName = String(req.body.ruleName || '').trim();
    const ruleCode = String(req.body.ruleCode || '');

    if (!watchlistId || !ruleName || ruleName.length > 80 || !ruleCode.trim() || ruleCode.length > 25000) {
      return res.status(400).json({ error: 'Select a watchlist, name the rule, and provide the rule results.' });
    }
    if (!Number.isFinite(investmentPerStock) || investmentPerStock <= 0) {
      return res.status(400).json({ error: 'Investment per stock must be a positive INR amount.' });
    }

    const watchlistResult = await pool.query('SELECT symbols FROM watchlists WHERE id = $1', [watchlistId]);
    if (!watchlistResult.rows.length) {
      return res.status(404).json({ error: 'Watchlist not found.' });
    }
    const watchlistSymbols = watchlistResult.rows[0].symbols;
    const watchlistSet = new Set(watchlistSymbols);
    if (matchedSymbols.some((symbol) => !watchlistSet.has(symbol) || !findStock(symbol))) {
      return res.status(400).json({ error: 'Rule results contain stocks outside the selected watchlist.' });
    }

    let ruleId = req.body.ruleId || null;
    if (ruleId) {
      const savedRule = await pool.query('SELECT name, code FROM saved_rules WHERE id = $1', [ruleId]);
      if (!savedRule.rows.length) {
        return res.status(404).json({ error: 'Saved rule not found.' });
      }
      if (savedRule.rows[0].name !== ruleName || savedRule.rows[0].code !== ruleCode) {
        ruleId = null;
      }
    }

    const initialPortfolio = await readPortfolio();
    const initialHoldingSymbols = new Set(initialPortfolio.holdings.map((holding) => holding.symbol));
    const expectedExits = initialPortfolio.holdings
      .filter((holding) => watchlistSet.has(holding.symbol) && !matchedSymbols.includes(holding.symbol))
      .map((holding) => holding.symbol);
    const expectedEntries = matchedSymbols.filter((symbol) => !initialHoldingSymbols.has(symbol));
    const quoteSymbols = [...new Set([...expectedExits, ...expectedEntries])];
    const quotes = await getQuotesForSymbols(quoteSymbols);
    const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
    const unavailableSymbol = quoteSymbols.find((symbol) => !(quoteMap.get(symbol)?.ltp > 0));
    if (unavailableSymbol) {
      return res.status(503).json({ error: `A current price is unavailable for ${unavailableSymbol}; no trades were placed.` });
    }
    const unbuyableSymbol = expectedEntries.find((symbol) => Math.floor(investmentPerStock / quoteMap.get(symbol).ltp) < 1);
    if (unbuyableSymbol) {
      return res.status(400).json({ error: `Increase the INR amount per stock to at least the share price for ${unbuyableSymbol}.` });
    }

    await client.query('BEGIN');
    transactionStarted = true;
    const lockedWatchlist = await client.query('SELECT symbols FROM watchlists WHERE id = $1 FOR SHARE', [watchlistId]);
    if (!lockedWatchlist.rows.length) {
      throw Object.assign(new Error('Watchlist was deleted while this run was being prepared.'), { statusCode: 409 });
    }
    if (JSON.stringify(lockedWatchlist.rows[0].symbols) !== JSON.stringify(watchlistSymbols)) {
      throw Object.assign(new Error('Watchlist changed while this run was being prepared. Review and run it again.'), { statusCode: 409 });
    }
    const lockedState = await client.query(
      'SELECT state FROM portfolio_state WHERE id = $1 FOR UPDATE',
      ['default']
    );
    const portfolio = lockedState.rows[0]?.state;
    if (!portfolio) {
      throw Object.assign(new Error('Portfolio state is unavailable.'), { statusCode: 500 });
    }

    const currentHoldingSymbols = new Set(portfolio.holdings.map((holding) => holding.symbol));
    const currentExits = portfolio.holdings
      .filter((holding) => watchlistSet.has(holding.symbol) && !matchedSymbols.includes(holding.symbol))
      .map((holding) => holding.symbol);
    const currentEntries = matchedSymbols.filter((symbol) => !currentHoldingSymbols.has(symbol));
    if (
      currentExits.some((symbol) => !quoteMap.has(symbol)) ||
      currentEntries.some((symbol) => !quoteMap.has(symbol))
    ) {
      throw Object.assign(new Error('Portfolio changed while this run was being prepared. Review and run it again.'), { statusCode: 409 });
    }

    const exitProceeds = currentExits.reduce((sum, symbol) => {
      const holding = portfolio.holdings.find((item) => item.symbol === symbol);
      return sum + holding.qty * quoteMap.get(symbol).ltp;
    }, 0);
    const newPositions = currentEntries.map((symbol) => {
      const price = quoteMap.get(symbol).ltp;
      const qty = Math.floor(investmentPerStock / price);
      return { symbol, price, qty, cost: qty * price };
    }).filter((position) => position.qty > 0);
    const totalEntryCost = newPositions.reduce((sum, position) => sum + position.cost, 0);
    if (totalEntryCost > Number(portfolio.cashBalance || 0) + exitProceeds) {
      throw Object.assign(new Error('Available cash cannot cover these entries after the planned exits.'), { statusCode: 400 });
    }

    const trades = [];
    for (const symbol of currentExits) {
      const holding = portfolio.holdings.find((item) => item.symbol === symbol);
      const price = quoteMap.get(symbol).ltp;
      const proceeds = roundTo(holding.qty * price);
      const realizedPnl = roundTo((price - holding.avgBuyPrice) * holding.qty);
      portfolio.cashBalance = roundTo(Number(portfolio.cashBalance || 0) + proceeds);
      portfolio.realizedPnl = roundTo(Number(portfolio.realizedPnl || 0) + realizedPnl);
      portfolio.holdings = portfolio.holdings.filter((item) => item.symbol !== symbol);
      trades.push({ side: 'SELL', symbol, qty: holding.qty, price, amount: proceeds, realizedPnl });
    }

    for (const position of newPositions) {
      portfolio.cashBalance = roundTo(Number(portfolio.cashBalance || 0) - position.cost);
      portfolio.holdings.push({ symbol: position.symbol, qty: position.qty, avgBuyPrice: position.price });
      trades.push({
        side: 'BUY',
        symbol: position.symbol,
        qty: position.qty,
        price: position.price,
        amount: roundTo(position.cost),
      });
    }

    const runId = randomUUID();
    await client.query(
      'UPDATE portfolio_state SET state = $1 WHERE id = $2',
      [JSON.stringify(portfolio), 'default']
    );
    await client.query(
      'INSERT INTO strategy_runs (id, rule_id, rule_name, rule_code, watchlist_id, matched_symbols, trades) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [runId, ruleId, ruleName, ruleCode, watchlistId, JSON.stringify(matchedSymbols), JSON.stringify(trades)]
    );
    await client.query('COMMIT');
    transactionStarted = false;

    res.json({
      success: true,
      runId,
      ruleName,
      trades,
      cashBalance: roundTo(Number(portfolio.cashBalance || 0)),
      message: `${trades.length} paper trade${trades.length === 1 ? '' : 's'} executed.`,
    });
  } catch (error) {
    if (transactionStarted && client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to execute rule run.' });
  } finally {
    client?.release();
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Virtual portfolio manager running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize portfolio database:', error);
    process.exit(1);
  });

module.exports = app;
