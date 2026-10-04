# Virtual Portfolio Manager

A paper-trading portfolio app for NSE stocks with:
- add stock to portfolio
- live/updating LTP tracking
- avg buy price + quantity tracking
- sell flow with cash balance updates
- virtual portfolio P&L analysis
- no real brokerage or actual money involved

## Stack
- React frontend
- Express backend
- SQLite database
- Yahoo Finance price queries for demo LTP data

## Run locally

1. Install root dependencies:
   npm install
2. Install frontend dependencies:
   cd client && npm install
3. Start app:
   npm run dev

The frontend will run on http://localhost:3000 and backend on http://localhost:5000.
