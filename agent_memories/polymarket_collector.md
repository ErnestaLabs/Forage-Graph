---
type: agent_memory
agent: polymarket_collector
role: market_data_collector
layer: data
updated: 2026-04-08
---

# Polymarket Collector

I pull active prediction market data from [[Polymarket]] via the Gamma API and push it to the [[Forage Reality Graph]]. I am the primary source of probabilistic event pricing.

## Identity
- **Module:** `trading_games/collectors/polymarket_collector.py`
- **APIs:** `gamma-api.polymarket.com` (markets), `data-api.polymarket.com` (trades)
- **No auth required** — public API
- **Managed by:** [[market_pulse_watcher]] runs me on a cycle

## What I collect
```
PredictionMarket nodes — every active market with:
  yes_price, volume, liquidity, end_date, category

OddsSnapshot nodes — price checkpoint per market per run:
  market_id, yes_price, volume, timestamp_ms

Source nodes — top wallet addresses by volume:
  proxyWallet → aggregated from /trades?limit=500&taker_side=BUY
```

## Key implementation note
The `/leaderboard` endpoint is **dead (404)**. I now aggregate top wallets from `/trades` by summing `usdcSize` per `maker` address. This was fixed 2026-04-08.

## My YES price extraction logic
```python
# Priority order:
1. tokens[] where outcome.upper() == "YES" → token.price
2. lastTradePrice
3. bestAsk
```

## What I push to graph
```python
POST /ingest/bulk
{"nodes": [market_nodes + snapshot_nodes + wallet_nodes], "source": "polymarket_collector"}
```

## Relationships
- [[Polymarket]] — my data source
- [[onchain_collector]] — parallel smart money source; we deduplicate wallet nodes by address
- [[cross_venue_signal]] — consumes my `PredictionMarket` nodes to find divergences vs [[Kalshi]]
- [[oracle]] — reads my `PredictionMarket` and `OddsSnapshot` nodes every cycle
- [[market_pulse_watcher]] — schedules my runs
- [[Forage Reality Graph]] — my write destination

## Observations
- 2026-04-08: Confirmed `/leaderboard` endpoint returns 404 — replaced with volume aggregation from `/trades`
- Most active markets by 24hr volume: US election outcomes, Fed rate decisions, macro events
- `bestAsk` is unreliable — use `tokens[].price` for YES price when available
- UK users are geoblocked from Polymarket execution but reads are unrestricted globally
