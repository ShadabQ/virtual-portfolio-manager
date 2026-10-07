import { apiRequest } from './modules/api.js';
import { getWatchlists, initWatchlists, loadWatchlists, refreshSelectedWatchlist } from './modules/watchlists.js';
import { initRules, refreshRulesAfterWatchlistChange } from './modules/rules.js';
import { loadPortfolio, setupManualTrades } from './modules/portfolio.js';
import { loadActivity } from './modules/activity.js';

const titles = {
  overview: 'Overview',
  watchlists: 'Watchlists',
  rules: 'Rules',
  portfolio: 'Portfolio',
  activity: 'Activity',
};

function showView(viewName) {
  for (const view of document.querySelectorAll('.page-view')) {
    view.classList.toggle('is-hidden', view.id !== `view-${viewName}`);
  }
  for (const button of document.querySelectorAll('.nav-link')) {
    const active = button.dataset.view === viewName;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.getElementById('pageTitle').textContent = titles[viewName] || 'Overview';
  if (viewName === 'watchlists') refreshSelectedWatchlist();
}

async function refreshWorkspace() {
  const status = document.getElementById('globalStatus');
  try {
    await Promise.all([loadPortfolio(), loadActivity(getWatchlists())]);
    status.textContent = '';
  } catch (error) {
    status.textContent = error.message;
  }
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}

document.getElementById('refreshBtn').addEventListener('click', refreshWorkspace);
window.addEventListener('portfolio:updated', refreshWorkspace);
window.addEventListener('activity:updated', () => loadActivity(getWatchlists()));
window.addEventListener('watchlists:changed', async () => {
  await refreshRulesAfterWatchlistChange();
  await loadActivity(getWatchlists());
});

async function start() {
  const status = document.getElementById('globalStatus');
  try {
    const { stocks } = await apiRequest('/api/stocks');
    setupManualTrades(stocks);
    initWatchlists(stocks);
    await loadWatchlists();
    await initRules();
    await refreshWorkspace();
  } catch (error) {
    status.textContent = error.message || 'Unable to initialize the workspace.';
  }
}

start();
