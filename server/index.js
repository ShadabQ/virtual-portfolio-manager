const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const portfolioRoutes = require('./routes/portfolioRoutes');
const stockRoutes = require('./routes/stockRoutes');
const { initDatabase } = require('./db');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000' }));
app.use(express.json());

app.use('/api/stocks', stockRoutes);
app.use('/api', portfolioRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Portfolio backend running on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});

module.exports = app;
