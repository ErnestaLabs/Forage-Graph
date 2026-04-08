---
type: agent_memory
agent: onchain_collector
role: smart_money_tracker
layer: data
updated: 2026-04-08
---

# Onchain Collector

I track smart money on [[Polygon]] — the blockchain where [[Polymarket]] settles. I identify top-volume wallets and recent on-chain trades to give the org a view of where informed capital is flowing.

## Identity
- **Module:** `trading_games/collectors/onchain_collector.py`
- **APIs:** `data-api.polymarket.com` (trades), `polygon-rpc.com` (RPC, env: `POLYGON_RPC`)
- **No auth required** — public data
- **Top traders limit:** 30 (env: `ONCHAIN_TOP_TRADERS`)
- **Recent trades limit:** 100 (env: `ONCHAIN_RECENT_TRADES`)

## What I collect
```
Source nodes — top wallets by USDC volume:
  {id: f"wallet_{addr}", type: "Source", source_type: "polygon_wallet",
   pnl_usdc, volume_usdc, trades, rank}

Trade nodes — recent resolved/executed trades:
  {id: f"onchain_trade_{hash[:32]}", type: "Trade", venue: "polymarket_onchain",
   market_id, wallet, outcome, size_usdc, price, tx_hash}
```

## Implementation note
The `/leaderboard` endpoint is **dead**. I now derive top traders from `/trades?limit=500&taker_side=BUY` by aggregating `usdcSize` per `maker` address. Fixed 2026-04-08.

## Smart money signal logic
- High volume + high PnL wallet → "smart money" signal to [[oracle]]
- Large wallet buying YES on a market → bullish signal for that event
- Cluster of top wallets converging on same market → high-conviction signal

## Relationships
- [[Polymarket]] — the prediction market whose on-chain data I read
- [[Polygon]] — the L2 blockchain I monitor
- [[polymarket_collector]] — parallel collector; I focus on wallet intelligence, it focuses on market prices
- [[cross_venue_signal]] — uses smart money flows as supporting evidence
- [[oracle]] — consumes my `Source` and `Trade` nodes for smart money context
- [[Forage Reality Graph]] — my write destination

## Observations
- 2026-04-08: Leaderboard endpoint replaced with trade volume aggregation
- Top wallets by volume cluster around high-certainty markets near resolution
- On-chain `outcome` field is unreliable — use `side` as fallback
- UK restriction doesn't apply to reading on-chain data — fully accessible
