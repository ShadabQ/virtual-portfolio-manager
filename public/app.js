* {
  box-sizing: border-box;
}

:root {
  --bg: #08151e;
  --bg-soft: #112635;
  --panel: #102a39;
  --panel-strong: #173b4d;
  --line: rgba(255, 255, 255, 0.08);
  --text: #edf7ff;
  --muted: #a8bfd0;
  --accent: #5ec0ff;
  --accent-2: #30c48d;
  --danger: #ff6b6b;
  --warning: #f9c74f;
  --shadow: rgba(0, 0, 0, 0.22);
}

body {
  margin: 0;
  font-family: Inter, "Segoe UI", sans-serif;
  background: linear-gradient(135deg, #08151e, #0d1f2b 35%, #122a39 100%);
  color: var(--text);
}

button, input, select {
  font: inherit;
}

.page-shell {
  max-width: 1300px;
  margin: 0 auto;
  padding: 32px 20px 40px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.eyebrow {
  margin: 0 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 11px;
  color: var(--accent);
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 3vw, 2.8rem);
}

h2 {
  margin-top: 0;
  font-size: 1.1rem;
}

.layout {
  display: grid;
  gap: 20px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.summary-card,
.panel,
.form-card {
  background: rgba(16, 42, 57, 0.9);
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 18px 40px var(--shadow);
}

.summary-card {
  padding: 18px 20px;
}

.summary-label {
  display: block;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 8px;
}

.summary-value {
  font-size: clamp(1.6rem, 2vw, 2.2rem);
  font-weight: 700;
}

.summary-trend {
  margin-top: 12px;
  color: var(--muted);
  font-size: 0.84rem;
}

.forms-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  padding: 18px;
}

.form-card {
  padding: 18px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

label {
  font-size: 0.88rem;
  color: var(--muted);
}

input, select {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 12px;
}

button {
  border: none;
  border-radius: 10px;
  padding: 11px 18px;
  cursor: pointer;
  transition: transform 0.2s ease, opacity 0.2s ease;
}

button:hover {
  transform: translateY(-1px);
}

.primary-btn {
  background: linear-gradient(135deg, var(--accent), #4a8df7);
  color: #06151d;
  font-weight: 700;
}

.secondary-btn {
  background: linear-gradient(135deg, var(--accent-2), #3ecaa5);
  color: #041914;
  font-weight: 700;
}

.panel {
  padding: 18px;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 760px;
}

th, td {
  text-align: left;
  padding: 12px 12px;
  border-bottom: 1px solid var(--line);
}

th {
  color: var(--muted);
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

tbody tr:hover {
  background: rgba(255, 255, 255, 0.02);
}

.pnl-positive {
  color: var(--accent-2);
  font-weight: 700;
}

.pnl-negative {
  color: var(--danger);
  font-weight: 700;
}

@media (max-width: 720px) {
  .field-row {
    grid-template-columns: 1fr;
  }
  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }
}
