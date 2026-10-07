import { apiRequest, createCell, formatCurrency, formatPercent, showEmptyRow, setStatus } from './api.js';

let stocks = [];
let watchlists = [];
let selectedId = '';
let draftSymbols = [];
let editingId = null;
let quoteRequestId = 0;

const listSelect = document.getElementById('watchlistSelect');
const ruleSelect = document.getElementById('ruleWatchlist');
const dialog = document.getElementById('watchlistDialog');
const form = document.getElementById('watchlistForm');
const status = document.getElementById('watchlistFormStatus');

export function getWatchlists() {
  return watchlists;
}

export function getCurrentWatchlist() {
  return watchlists.find((watchlist) => watchlist.id === selectedId) || null;
}

export function getWatchlistById(id) {
  return watchlists.find((watchlist) => watchlist.id === id) || null;
}

function fillSelect(select, preserveId) {
  const previous = preserveId || select.value;
  select.replaceChildren(...watchlists.map((watchlist) => new Option(
    `${watchlist.name} · ${watchlist.symbols.length}`,
    watchlist.id
  )));
  if (watchlists.some((watchlist) => watchlist.id === previous)) select.value = previous;
}

function renderDraft() {
  const container = document.getElementById('selectedWatchlistSymbols');
  const nameBySymbol = new Map(stocks.map((stock) => [stock.symbol, stock.name]));
  if (!draftSymbols.length) {
    const empty = document.createElement('span');
    empty.className = 'muted-copy';
    empty.textContent = 'No stocks added';
    container.replaceChildren(empty);
    return;
  }
  const chips = draftSymbols.map((symbol) => {
    const chip = document.createElement('span');
    chip.className = 'symbol-chip';
    const label = document.createElement('span');
    label.textContent = symbol;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${symbol}`);
    remove.addEventListener('click', () => {
      draftSymbols = draftSymbols.filter((item) => item !== symbol);
      renderDraft();
    });
    chip.title = nameBySymbol.get(symbol) || symbol;
    chip.append(label, remove);
    return chip;
  });
  container.replaceChildren(...chips);
}

function populateStockPicker() {
  const picker = document.getElementById('stockPicker');
  picker.replaceChildren(new Option('Choose a stock', ''), ...stocks.map((stock) => new Option(
    `${stock.symbol} - ${stock.name}`,
    stock.symbol
  )));
}

async function renderSelectedWatchlist() {
  const watchlist = getCurrentWatchlist();
  const tbody = document.getElementById('watchlistStocksBody');
  const count = document.getElementById('watchlistCount');
  const editButton = document.getElementById('editWatchlistBtn');
  editButton.hidden = !watchlist || watchlist.isBuiltin;
  if (!watchlist) {
    count.textContent = '';
    showEmptyRow(tbody, 4, 'Create a watchlist to get started.');
    return;
  }
  selectedId = watchlist.id;
  count.textContent = `${watchlist.symbols.length} stocks`;
  if (!watchlist.symbols.length) {
    showEmptyRow(tbody, 4, 'This watchlist is empty.');
    return;
  }
  const requestId = ++quoteRequestId;
  showEmptyRow(tbody, 4, 'Loading quotes…');
  try {
    const query = new URLSearchParams({ symbols: watchlist.symbols.join(',') });
    const { quotes } = await apiRequest(`/api/market/quotes?${query}`);
    if (requestId !== quoteRequestId) return;
    const rows = quotes.map((quote) => {
      const row = document.createElement('tr');
      row.append(
        createCell(quote.symbol, 'symbol-cell'),
        createCell(quote.name, 'company-cell'),
        createCell(quote.ltp > 0 ? formatCurrency(quote.ltp) : 'Unavailable'),
        createCell(
          formatPercent(quote.dailyChangePercent),
          quote.dailyChangePercent === null ? '' : quote.dailyChangePercent >= 0 ? 'change-positive' : 'change-negative'
        )
      );
      return row;
    });
    tbody.replaceChildren(...rows);
  } catch (error) {
    if (requestId === quoteRequestId) showEmptyRow(tbody, 4, error.message);
  }
}

export async function refreshSelectedWatchlist() {
  return renderSelectedWatchlist();
}

export async function loadWatchlists() {
  const current = selectedId || listSelect.value;
  const data = await apiRequest('/api/watchlists');
  watchlists = data.watchlists;
  fillSelect(listSelect, current);
  fillSelect(ruleSelect, ruleSelect.value || current);
  selectedId = listSelect.value;
  const currentList = getCurrentWatchlist();
  document.getElementById('watchlistCount').textContent = currentList ? `${currentList.symbols.length} stocks` : '';
  return watchlists;
}

function openDialog(watchlist = null) {
  editingId = watchlist && !watchlist.isBuiltin ? watchlist.id : null;
  draftSymbols = watchlist ? [...watchlist.symbols] : [];
  document.getElementById('watchlistDialogTitle').textContent = editingId ? 'Edit watchlist' : 'New watchlist';
  document.getElementById('customWatchlistName').value = editingId ? watchlist.name : '';
  document.getElementById('deleteWatchlistBtn').hidden = !editingId;
  setStatus(status, '');
  renderDraft();
  dialog.showModal();
}

export function initWatchlists(stockList) {
  stocks = stockList;
  populateStockPicker();
  document.getElementById('createWatchlistBtn').addEventListener('click', () => openDialog());
  document.getElementById('editWatchlistBtn').addEventListener('click', () => openDialog(getCurrentWatchlist()));
  document.getElementById('closeWatchlistDialog').addEventListener('click', () => dialog.close());
  document.getElementById('cancelWatchlistBtn').addEventListener('click', () => dialog.close());
  document.getElementById('addWatchlistStockBtn').addEventListener('click', () => {
    const symbol = document.getElementById('stockPicker').value;
    if (symbol && !draftSymbols.includes(symbol)) draftSymbols.push(symbol);
    renderDraft();
  });
  listSelect.addEventListener('change', async () => {
    selectedId = listSelect.value;
    await renderSelectedWatchlist();
  });
  ruleSelect.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('rule-watchlist:changed', { detail: ruleSelect.value }));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.getElementById('customWatchlistName').value.trim();
    if (!draftSymbols.length) {
      setStatus(status, 'Add at least one stock.', 'error');
      return;
    }
    const method = editingId ? 'PUT' : 'POST';
    const endpoint = editingId ? `/api/watchlists/${editingId}` : '/api/watchlists';
    try {
      const result = await apiRequest(endpoint, { method, body: JSON.stringify({ name, symbols: draftSymbols }) });
      dialog.close();
      await loadWatchlists();
      listSelect.value = result.watchlist.id;
      selectedId = listSelect.value;
      editingId = null;
      await renderSelectedWatchlist();
      window.dispatchEvent(new CustomEvent('watchlists:changed', { detail: watchlists }));
    } catch (error) {
      setStatus(status, error.message, 'error');
    }
  });
  document.getElementById('deleteWatchlistBtn').addEventListener('click', async () => {
    if (!editingId || !window.confirm('Delete this custom watchlist?')) return;
    try {
      await apiRequest(`/api/watchlists/${editingId}`, { method: 'DELETE' });
      dialog.close();
      await loadWatchlists();
      selectedId = listSelect.value;
      await renderSelectedWatchlist();
      window.dispatchEvent(new CustomEvent('watchlists:changed', { detail: watchlists }));
    } catch (error) {
      setStatus(status, error.message, 'error');
    }
  });
}
