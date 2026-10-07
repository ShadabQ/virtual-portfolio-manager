import { apiRequest, createCell, formatCurrency, formatNumber, showEmptyRow, setStatus } from './api.js';

let currentPortfolio = null;

function renderSummary(target, portfolio) {
  const cards = [
    { label: 'Cash', value: formatCurrency(portfolio.cashBalance), note: 'Available to deploy' },
    { label: 'Invested', value: formatCurrency(portfolio.totalInvested), note: `${portfolio.holdings.length} open positions` },
    { label: 'Market value', value: formatCurrency(portfolio.totalMarketValue), note: 'Current holdings' },
    { label: 'Net P&L', value: formatCurrency(portfolio.totalPnl), note: `Realized ${formatCurrency(portfolio.realizedPnl)}` },
  ];
  target.replaceChildren(...cards.map((card) => {
    const article = document.createElement('article');
    article.className = 'summary-card';
    const label = document.createElement('span');
    label.className = 'summary-label';
    label.textContent = card.label;
    const value = document.createElement('p');
    value.className = 'summary-value';
    value.textContent = card.value;
    const note = document.createElement('div');
    note.className = 'summary-trend';
    note.textContent = card.note;
    article.append(label, value, note);
    return article;
  }));
}

function renderHoldings(tbody, holdings, compact = false) {
  if (!holdings.length) {
    showEmptyRow(tbody, compact ? 4 : 8, 'No positions yet. Run a rule or add a paper trade.');
    return;
  }
  const visibleHoldings = compact ? holdings.slice(0, 6) : holdings;
  const rows = visibleHoldings.map((holding) => {
    const row = document.createElement('tr');
    if (compact) {
      row.append(
        createCell(holding.symbol, 'symbol-cell'),
        createCell(formatNumber(holding.qty)),
        createCell(formatCurrency(holding.ltp)),
        createCell(formatCurrency(holding.pnl), holding.pnl >= 0 ? 'pnl-positive' : 'pnl-negative')
      );
      return row;
    }
    row.append(
      createCell(holding.symbol, 'symbol-cell'),
      createCell(holding.company, 'company-cell'),
      createCell(formatNumber(holding.qty)),
      createCell(formatCurrency(holding.avgBuyPrice)),
      createCell(formatCurrency(holding.ltp)),
      createCell(formatCurrency(holding.investedValue)),
      createCell(formatCurrency(holding.marketValue)),
      createCell(formatCurrency(holding.pnl), holding.pnl >= 0 ? 'pnl-positive' : 'pnl-negative')
    );
    return row;
  });
  tbody.replaceChildren(...rows);
}

export async function loadPortfolio() {
  currentPortfolio = await apiRequest('/api/portfolio');
  renderSummary(document.getElementById('summaryGrid'), currentPortfolio);
  renderSummary(document.getElementById('portfolioSummaryGrid'), currentPortfolio);
  renderHoldings(document.getElementById('overviewHoldingsBody'), currentPortfolio.holdings, true);
  renderHoldings(document.getElementById('portfolioTableBody'), currentPortfolio.holdings);
  return currentPortfolio;
}

export function getCurrentPortfolio() {
  return currentPortfolio;
}

export function setupManualTrades(stocks) {
  const options = [new Option('Select stock', '')];
  for (const stock of stocks) options.push(new Option(`${stock.symbol} - ${stock.name}`, stock.symbol));
  for (const select of [document.getElementById('buySymbol'), document.getElementById('sellSymbol')]) {
    select.replaceChildren(...options.map((option) => option.cloneNode(true)));
  }

  const quoteForSelection = async (select, input) => {
    if (!select.value) {
      input.value = '';
      return;
    }
    try {
      const quote = await apiRequest(`/api/stock/${encodeURIComponent(select.value)}/quote`);
      input.value = quote.ltp > 0 ? Number(quote.ltp).toFixed(2) : '';
    } catch {
      input.value = '';
    }
  };

  document.getElementById('buySymbol').addEventListener('change', (event) => {
    quoteForSelection(event.currentTarget, document.getElementById('buyPrice'));
  });
  document.getElementById('sellSymbol').addEventListener('change', (event) => {
    quoteForSelection(event.currentTarget, document.getElementById('sellPrice'));
  });

  for (const [formId, endpoint] of [['buyForm', '/api/portfolio/buy'], ['sellForm', '/api/portfolio/sell']]) {
    const form = document.getElementById(formId);
    const status = form.querySelector('.form-status');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const result = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify(payload) });
        setStatus(status, result.message, 'success');
        form.reset();
        window.dispatchEvent(new Event('portfolio:updated'));
      } catch (error) {
        setStatus(status, error.message, 'error');
      }
    });
  }
}
