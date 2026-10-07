# Virtual Portfolio Manager

A compact paper-trading workspace for managing NSE watchlists, saving Python stock filters, and reviewing rule-driven portfolio trades. No real brokerage orders are placed.

## Run locally

1. Install Node.js dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your PostgreSQL connection string.
3. Start the app with `npm start` and open `http://localhost:3000`.

PostgreSQL stores the portfolio, custom watchlists, saved rules, and rule run history. The built-in Nifty 50 and Nifty 500 lists are seeded on startup. Stock prices and daily change data are fetched from Yahoo Finance.

## Python rules

Define `screen(stocks)` and return a list of symbols or stock rows. Each row includes `symbol`, `name`, `ltp`, `previousClose`, and `dailyChangePercent`.

```python
def screen(stocks):
    return [
        stock["symbol"] for stock in stocks
        if stock["dailyChangePercent"] is not None
        and stock["dailyChangePercent"] > 0
    ]
```

Rules run manually in a browser WebAssembly worker. Imports and private-object access are disabled; execution is time-limited. The run preview shows new entries and exits before confirmation. The entered INR amount is the maximum allocation per new stock, converted to whole shares at the current quote. Existing holdings are exited only when they belong to the selected watchlist and do not match.
