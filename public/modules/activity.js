import { apiRequest } from './api.js';

function formatDate(value) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function createRunItem(run, watchlistName) {
  const item = document.createElement('article');
  item.className = 'run-item';
  const title = document.createElement('div');
  title.className = 'run-title';
  title.textContent = run.ruleName;
  const count = document.createElement('div');
  count.className = 'run-count';
  count.textContent = `${run.trades.length} trade${run.trades.length === 1 ? '' : 's'}`;
  const meta = document.createElement('div');
  meta.className = 'run-meta';
  meta.textContent = `${watchlistName} · ${formatDate(run.createdAt)}`;
  item.append(title, count, meta);
  return item;
}

export async function loadActivity(watchlists = []) {
  const { runs } = await apiRequest('/api/strategy-runs');
  const listNames = new Map(watchlists.map((watchlist) => [watchlist.id, watchlist.name]));
  const recent = runs.slice(0, 5);
  const overview = document.getElementById('overviewRuns');
  if (!recent.length) {
    const empty = document.createElement('p');
    empty.className = 'muted-copy';
    empty.textContent = 'No rule runs yet.';
    overview.replaceChildren(empty);
  } else {
    overview.replaceChildren(...recent.map((run) => createRunItem(run, listNames.get(run.watchlistId) || 'Watchlist')));
  }

  const activity = document.getElementById('activityRuns');
  if (!runs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted-copy';
    empty.textContent = 'Rule executions will appear here.';
    activity.replaceChildren(empty);
  } else {
    activity.replaceChildren(...runs.map((run) => createRunItem(run, listNames.get(run.watchlistId) || 'Watchlist')));
  }
}
