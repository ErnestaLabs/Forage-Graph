---
type: agent_memory
agent: kalshi_collector
role: prediction_market_feed
layer: data
updated: 2026-04-08
---

# Kalshi Collector

I pull open prediction market data from [[Kalshi]] — the US-regulated prediction exchange — and push it to the [[Forage Reality Graph]]. My primary value is as a **price reference point** for cross-venue arbitrage detection against [[Polymarket]].

## Identity
- **Module:** `trading_games/collectors/kalshi_collector.py`
- **Also used by:** `trading_games/kalshi_executor.py` (read-only client), `trading_games/cross_venue_signal.py`
- **API base:** `https://api.elections.kalshi.com/trade-api/v2`
- **No auth required for reads**

## CRITICAL: API migration
The old URL `trading-api.kalshi.com/trade-api/v2` returns **401 "API has been moved"**.
The correct URL is `api.elections.kalshi.com/trade-api/v2`. Fixed 2026-04-08.

## What I collect
```
PredictionMarket nodes — open markets with:
  ticker, title, yes_price (midpoint of yes_ask/yes_bid), close_time

Settled markets — for settlement divergence arb:
  ticker, title, result ("yes"/"no"), yes_price (1.0 or 0.0)
```

## Kalshi price format
- Prices are in **cents** (0–100), not decimals (0–1)
- YES midpoint: `(yes_ask + yes_bid) / 2 / 100`
- Must divide by 100 before comparing with [[Polymarket]] prices

## Settlement divergence arb pattern
```
Kalshi settles on AP/Reuters call → 0-4h post-event
Polymarket settles 24-48h later
Window: Kalshi=resolved but Polymarket still trading at 0.85-0.97
→ buy near-certain side on Polymarket (from Railway Ireland IP, not UK)
```

## Relationships
- [[Kalshi]] — my data source (US-regulated, professionals)
- [[polymarket_collector]] — my counterpart; combined we enable divergence detection
- [[cross_venue_signal]] — primary consumer of my data; computes PM/Kalshi gaps
- [[oracle]] — reads my `PredictionMarket` nodes to understand US professional positioning
- [[result_flow_watcher]] — monitors Kalshi settled markets for resolution signals
- [[Forage Reality Graph]] — my write destination

## Key insight: Kalshi vs Polymarket user base
- **Kalshi:** US-regulated, professional traders, API-heavy, institutional positioning
- **Polymarket:** Global, crypto-native, retail + quant, on-chain settlement
- Price gap = sentiment split between US professionals and global crypto crowd
- Gap > 4% on same event → directional signal for correlated IG instruments

## Observations
- 2026-04-08: API URL corrected — was returning 401 authentication errors
- Kalshi markets have significantly fewer categories than Polymarket — focus on overlapping political/macro markets
- Yes/No prices in cents: always /100 before storing in graph
