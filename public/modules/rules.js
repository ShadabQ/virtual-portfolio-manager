import { apiRequest, createCell, formatCurrency, formatNumber, setStatus, showEmptyRow } from './api.js';
import { getCurrentWatchlist, getWatchlistById } from './watchlists.js';
import { loadPortfolio } from './portfolio.js';

let savedRules = [];
let pendingPlan = null;
let ruleWorker = null;
let workerReady = null;
let waitingForResult = null;
let workerTimer = null;
let workerIsReady = false;

const ruleSelect = document.getElementById('savedRuleSelect');
const ruleNameInput = document.getElementById('ruleName');
const ruleCodeInput = document.getElementById('ruleCode');
const watchlistSelect = document.getElementById('ruleWatchlist');
const status = document.getElementById('ruleStatus');
const preview = document.getElementById('rulePreview');
const confirmButton = document.getElementById('confirmRunBtn');

function terminateWorker(error) {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  if (waitingForResult) waitingForResult.reject(error);
  waitingForResult = null;
  ruleWorker?.terminate();
  ruleWorker = null;
  workerReady = null;
  workerIsReady = false;
}

function getWorker() {
  if (ruleWorker) return workerReady;
  ruleWorker = new Worker('/python-rule-worker.js', { type: 'module' });
  workerReady = new Promise((resolve, reject) => {
    workerTimer = setTimeout(() => {
      const error = new Error('Python runtime did not load within 90 seconds.');
      reject(error);
      terminateWorker(error);
    }, 90000);
    ruleWorker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        if (workerTimer) clearTimeout(workerTimer);
        workerTimer = null;
        workerIsReady = true;
        resolve();
        return;
      }
      if (data.type === 'error' && !workerIsReady) {
        if (workerTimer) clearTimeout(workerTimer);
        workerTimer = null;
        const error = new Error(data.message);
        reject(error);
        terminateWorker(error);
        return;
      }
      if (data.type === 'result' || data.type === 'error') {
        if (workerTimer) clearTimeout(workerTimer);
        workerTimer = null;
        const pending = waitingForResult;
        waitingForResult = null;
        if (data.type === 'result') pending?.resolve(data.symbols);
        else pending?.reject(new Error(data.message));
      }
    };
    ruleWorker.onerror = (event) => {
      const error = new Error(event.message || 'Python worker failed to load.');
      reject(error);
      terminateWorker(error);
    };
    ruleWorker.postMessage({ type: 'init' });
  });
  return workerReady;
}

async function executePythonFilter(code, stocks) {
  await getWorker();
  return new Promise((resolve, reject) => {
    waitingForResult = { resolve, reject };
    workerTimer = setTimeout(() => {
      terminateWorker(new Error('Rule exceeded the 15 second execution limit.'));
    }, 15000);
    ruleWorker.postMessage({ type: 'run', code, stocks });
  });
}

async function loadSavedRules() {
  const response = await apiRequest('/api/rules');
  savedRules = response.rules;
  const selected = ruleSelect.value;
  ruleSelect.replaceChildren(new Option('New rule', ''), ...savedRules.map((rule) => new Option(rule.name, rule.id)));
  if (savedRules.some((rule) => rule.id === selected)) ruleSelect.value = selected;
}

function renderPreview(plan) {
  pendingPlan = plan;
  preview.hidden = false;
  const summary = document.getElementById('previewSummary');
  const tradeCount = plan.trades.length;
  const values = [
    ['Matches', `${plan.matchedSymbols.length}`],
    ['Entries', `${plan.trades.filter((trade) => trade.side === 'BUY').length}`],
    ['Exits', `${plan.trades.filter((trade) => trade.side === 'SELL').length}`],
    ['Estimated cash after', formatCurrency(plan.estimatedCash)],
  ];
  summary.replaceChildren(...values.map(([label, value]) => {
    const item = document.createElement('span');
    item.innerHTML = `${label}: <strong></strong>`;
    item.querySelector('strong').textContent = value;
    return item;
  }));

  const tbody = document.getElementById('previewTradesBody');
  if (!tradeCount) {
    showEmptyRow(tbody, 5, 'No trades required. Existing matching positions will remain unchanged.');
  } else {
    tbody.replaceChildren(...plan.trades.map((trade) => {
      const row = document.createElement('tr');
      const side = trade.side === 'BUY' ? 'BUY' : 'SELL';
      row.append(
        createCell(side, trade.side === 'BUY' ? 'action-buy' : 'action-sell'),
        createCell(trade.symbol, 'symbol-cell'),
        createCell(formatNumber(trade.qty)),
        createCell(formatCurrency(trade.price)),
        createCell(formatCurrency(trade.amount))
      );
      return row;
    }));
  }
  confirmButton.disabled = !plan.canExecute;
}

function buildPlan({ matchedSymbols, watchlist, portfolio, quotes, amount, ruleName, ruleId }) {
  const matchSet = new Set(matchedSymbols);
  const watchlistSet = new Set(watchlist.symbols);
  const heldSymbols = new Set(portfolio.holdings.map((holding) => holding.symbol));
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const exits = portfolio.holdings.filter((holding) => watchlistSet.has(holding.symbol) && !matchSet.has(holding.symbol));
  const newMatches = matchedSymbols.filter((symbol) => !heldSymbols.has(symbol));
  const unavailable = [...exits.map((holding) => holding.symbol), ...newMatches]
    .filter((symbol) => !(quoteMap.get(symbol)?.ltp > 0));
  const skippedSymbols = newMatches.filter((symbol) => {
    const price = quoteMap.get(symbol)?.ltp || 0;
    return price > 0 && Math.floor(amount / price) < 1;
  });
  const trades = exits.map((holding) => ({
    side: 'SELL', symbol: holding.symbol, qty: holding.qty, price: quoteMap.get(holding.symbol)?.ltp || 0,
    amount: holding.qty * (quoteMap.get(holding.symbol)?.ltp || 0),
  }));
  const buyTrades = newMatches.map((symbol) => {
    const price = quoteMap.get(symbol)?.ltp || 0;
    const qty = price > 0 ? Math.floor(amount / price) : 0;
    return { side: 'BUY', symbol, qty, price, amount: qty * price };
  }).filter((trade) => trade.qty > 0);
  trades.push(...buyTrades);

  const exitValue = exits.reduce((sum, holding) => sum + holding.qty * (quoteMap.get(holding.symbol)?.ltp || 0), 0);
  const buyValue = buyTrades.reduce((sum, trade) => sum + trade.amount, 0);
  const estimatedCash = Number(portfolio.cashBalance || 0) + exitValue - buyValue;
  const tooMany = matchedSymbols.some((symbol) => !watchlistSet.has(symbol));
  const canExecute = !unavailable.length && !skippedSymbols.length && !tooMany && estimatedCash >= -0.0001;

  return {
    watchlistId: watchlist.id,
    matchedSymbols,
    investmentPerStock: amount,
    ruleName,
    ruleId,
    trades,
    estimatedCash,
    canExecute,
    unavailable,
    skippedSymbols,
    tooMany,
  };
}

async function runRule() {
  const ruleName = ruleNameInput.value.trim();
  const code = ruleCodeInput.value;
  const watchlist = getWatchlistById(watchlistSelect.value) || getCurrentWatchlist();
  const amount = Number(document.getElementById('investmentPerStock').value);
  if (!ruleName || !code.trim() || !watchlist) {
    setStatus(status, 'Name the rule, add Python code, and choose a watchlist.', 'error');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    setStatus(status, 'Enter a positive INR amount per new position.', 'error');
    return;
  }

  const runButton = document.getElementById('runRuleBtn');
  runButton.disabled = true;
  setStatus(status, 'Loading watchlist quotes…');
  preview.hidden = true;
  try {
    const query = new URLSearchParams({ symbols: watchlist.symbols.join(',') });
    const [quoteData, portfolio] = await Promise.all([
      apiRequest(`/api/market/quotes?${query}`),
      loadPortfolio(),
    ]);
    const stocks = quoteData.quotes.map((quote) => ({
      symbol: quote.symbol,
      name: quote.name,
      ltp: quote.ltp > 0 ? quote.ltp : null,
      previousClose: quote.previousClose,
      dailyChangePercent: quote.dailyChangePercent,
    }));
    setStatus(status, 'Running Python filter in an isolated browser worker…');
    const result = await executePythonFilter(code, stocks);
    const allowed = new Set(watchlist.symbols);
    const matchedSymbols = [...new Set(result)];
    if (matchedSymbols.some((symbol) => typeof symbol !== 'string' || !allowed.has(symbol))) {
      throw new Error('The rule returned symbols that are not in the selected watchlist.');
    }
    const plan = buildPlan({
      matchedSymbols,
      watchlist,
      portfolio,
      quotes: quoteData.quotes,
      amount,
      ruleName,
      ruleCode: code,
      ruleId: savedRules.some((rule) => rule.id === ruleSelect.value && rule.name === ruleName && rule.code === code)
        ? ruleSelect.value
        : null,
    });
    renderPreview(plan);
    if (plan.unavailable.length) {
      setStatus(status, `No current quote for ${plan.unavailable.join(', ')}. No trades can be confirmed.`, 'error');
    } else if (plan.skippedSymbols.length) {
      setStatus(status, `Increase INR per position to at least the share price for ${plan.skippedSymbols.join(', ')}.`, 'error');
    } else if (plan.tooMany) {
      setStatus(status, 'The rule selected symbols outside this watchlist.', 'error');
    } else if (!plan.canExecute) {
      setStatus(status, 'Estimated buys exceed available cash after planned exits.', 'error');
    } else {
      setStatus(status, `${matchedSymbols.length} match${matchedSymbols.length === 1 ? '' : 'es'} found. Review the trade preview before confirming.`, 'success');
    }
  } catch (error) {
    setStatus(status, error.message || 'Unable to run this rule.', 'error');
    preview.hidden = true;
  } finally {
    runButton.disabled = false;
  }
}

async function saveRule() {
  const name = ruleNameInput.value.trim();
  const code = ruleCodeInput.value;
  const watchlistId = watchlistSelect.value || null;
  if (!name || !code.trim()) {
    setStatus(status, 'Add a rule name and Python code before saving.', 'error');
    return;
  }
  const id = ruleSelect.value;
  const method = id ? 'PUT' : 'POST';
  const endpoint = id ? `/api/rules/${id}` : '/api/rules';
  const button = document.getElementById('saveRuleBtn');
  button.disabled = true;
  try {
    const result = await apiRequest(endpoint, { method, body: JSON.stringify({ name, code, watchlistId }) });
    await loadSavedRules();
    ruleSelect.value = result.rule.id;
    setStatus(status, 'Rule saved to the database.', 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function confirmRun() {
  if (!pendingPlan?.canExecute) return;
  confirmButton.disabled = true;
  setStatus(status, 'Confirming paper trades…');
  try {
    const result = await apiRequest('/api/strategy-runs', {
      method: 'POST',
      body: JSON.stringify(pendingPlan),
    });
    setStatus(status, result.message, 'success');
    preview.hidden = true;
    pendingPlan = null;
    await loadPortfolio();
    window.dispatchEvent(new Event('activity:updated'));
  } catch (error) {
    setStatus(status, error.message, 'error');
    confirmButton.disabled = false;
  }
}

export async function initRules() {
  document.getElementById('runRuleBtn').addEventListener('click', runRule);
  document.getElementById('saveRuleBtn').addEventListener('click', saveRule);
  confirmButton.addEventListener('click', confirmRun);
  ruleSelect.addEventListener('change', () => {
    const rule = savedRules.find((item) => item.id === ruleSelect.value);
    if (!rule) {
      ruleNameInput.value = '';
      ruleCodeInput.value = '';
      return;
    }
    ruleNameInput.value = rule.name;
    ruleCodeInput.value = rule.code;
    if (rule.watchlistId && getWatchlistById(rule.watchlistId)) watchlistSelect.value = rule.watchlistId;
  });
  await loadSavedRules();
}

export async function refreshRulesAfterWatchlistChange() {
  const selected = watchlistSelect.value;
  const data = await apiRequest('/api/watchlists');
  const lists = data.watchlists;
  watchlistSelect.replaceChildren(...lists.map((watchlist) => new Option(
    `${watchlist.name} · ${watchlist.symbols.length}`,
    watchlist.id
  )));
  if (lists.some((watchlist) => watchlist.id === selected)) watchlistSelect.value = selected;
}
