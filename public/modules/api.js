export async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('This API route is not available in the running server. Restart the app after configuring DATABASE_URL.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(value || 0));
}

export function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Unavailable';
  return `${Number(value).toFixed(2)}%`;
}

export function setStatus(element, message, type = '') {
  element.textContent = message || '';
  element.classList.toggle('is-error', type === 'error');
  element.classList.toggle('is-success', type === 'success');
}

export function createCell(value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value ?? '';
  if (className) cell.className = className;
  return cell;
}

export function showEmptyRow(tbody, columnCount, message) {
  const row = document.createElement('tr');
  const cell = createCell(message, 'empty-row');
  cell.colSpan = columnCount;
  row.append(cell);
  tbody.replaceChildren(row);
}
