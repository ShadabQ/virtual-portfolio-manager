const summaryGrid = document.getElementById('summaryGrid');
const portfolioTableBody = document.getElementById('portfolioTableBody');
const buyForm = document.getElementById('buyForm');
const sellForm = document.getElementById('sellForm');
const refreshBtn = document.getElementById('refreshBtn');
const buySymbol = document.getElementById('buySymbol');
const sellSymbol = document.getElementById('sellSymbol');
const buyPriceInput = document.getElementById('buyPrice');
const sellPriceInput = document.getElementById('sellPrice');
const quoteCache = new Map();

function setNotice(form, message, type = '') {
  const notice = form.querySelector('.notice') || document.createElement('div');
  notice.textContent = message || '';
  notice.className = `notice ${type}`.trim();
  if (!form.contains(notice)) {
    form.appendChild(notice);
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function renderSummary(portfolio) {
  const cards = [
    {
      label: 'Cash balance',
      value: formatCurrency(portfolio.cashBalance || 0),
      trend: `Starting cash: ${formatCurrency(portfolio.startingCash || 0)}`,
    },
    {
      label: 'Invested value',
      value: formatCurrency(portfolio.totalInvested || 0),
      trend: `${(portfolio.holdings || []).length} active positions`,
    },
    {
      label: 'Current value',
      value: formatCurrency(portfolio.totalMarketValue || 0),
      trend: `${formatCurrency((portfolio.totalMarketValue || 0) - (portfolio.totalInvested || 0))} vs invested`,
    },
    {
      label: 'Total P&L',
      value: `${formatCurrency(portfolio.totalPnl || 0)}`,
      trend: `${(portfolio.totalPnl || 0) >= 0 ? 'Up' : 'Down'} from starting balance`,
    },
  ];

  summaryGrid.innerHTML = cards.map((card) => `
    <article class="summary-card">
      <span class="summary-label">${card.label}</span>
      <p class="summary-value">${card.value}</p>
      <div class="summary-trend">${card.trend}</div>
    </article>
  `).join('');
}

function renderTable(portfolio) {
  const holdings = portfolio.holdings || [];

  if (!holdings.length) {
    portfolioTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">No holdings yet. Add a stock to begin tracking your portfolio.</td>
      </tr>
    `;
    return;
  }

  portfolioTableBody.innerHTML = holdings.map((holding) => {
    const pnlClass = holding.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';

    return `
      <tr>
        <td class="symbol-cell">${holding.symbol}</td>
        <td class="company-cell">${holding.company}</td>
        <td>${formatNumber(holding.qty)}</td>
        <td>${formatCurrency(holding.avgBuyPrice)}</td>
        <td>${formatCurrency(holding.ltp)}</td>
        <td>${formatCurrency(holding.investedValue)}</td>
        <td>${formatCurrency(holding.marketValue)}</td>
        <td class="${pnlClass}">${formatCurrency(holding.pnl)}</td>
      </tr>
    `;
  }).join('');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function populateStockOptions(stocks) {
  const options = ['<option value="">Select stock</option>']
    .concat(stocks.map((stock) => `<option value="${stock.symbol}">${stock.symbol} — ${stock.name}</option>`))
    .join('');

  buySymbol.innerHTML = options;
  sellSymbol.innerHTML = options;
}

async function updatePriceForSelection(selectElement, priceInput) {
  const symbol = selectElement.value;
  if (!symbol) {
    priceInput.value = '';
    return;
  }

  try {
    if (quoteCache.has(symbol)) {
      priceInput.value = quoteCache.get(symbol).toFixed(2);
      return;
    }

    const quote = await fetchJson(`/api/stock/${encodeURIComponent(symbol)}/quote`);
    const value = Number(quote.ltp) || 0;
    quoteCache.set(symbol, value);
    priceInput.value = value ? value.toFixed(2) : '';
  } catch (error) {
    console.warn('Unable to fetch price for selection:', error);
    priceInput.value = '';
  }
}

async function refreshData() {
  try {
    const [stockData, portfolioData] = await Promise.all([
      fetchJson('/api/stocks'),
      fetchJson('/api/portfolio'),
    ]);

    populateStockOptions(stockData.stocks || []);
    renderSummary(portfolioData);
    renderTable(portfolioData);
  } catch (error) {
    console.error(error);
    setNotice(buyForm, error.message || 'Unable to load portfolio data.', 'error');
  }
}

async function submitTrade(event, endpoint, form) {
  event.preventDefault();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    const result = await fetchJson(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    setNotice(form, result.message || 'Trade submitted successfully.', 'success');
    form.reset();
    await refreshData();
  } catch (error) {
    setNotice(form, error.message || 'Trade failed.', 'error');
  }
}

buySymbol.addEventListener('change', () => updatePriceForSelection(buySymbol, buyPriceInput));
sellSymbol.addEventListener('change', () => updatePriceForSelection(sellSymbol, sellPriceInput));

buyForm.addEventListener('submit', (event) => submitTrade(event, '/api/portfolio/buy', buyForm));
sellForm.addEventListener('submit', (event) => submitTrade(event, '/api/portfolio/sell', sellForm));
refreshBtn.addEventListener('click', refreshData);

refreshData();
