---
type: agent_memory
agent: cross_venue_signal
role: divergence_detector
layer: signal
updated: 2026-04-08
---

# Cross Venue Signal Detector

I find price disagreements between [[Polymarket]] and [[Kalshi]] on the same real-world event and translate them into directional signals for IG spread bet execution. I am the bridge between prediction market intelligence and financial market action.

## Identity
- **Module:** `trading_games/cross_venue_signal.py`
- **Class:** `CrossVenueSignalDetector`
- **Config:** `DIVERGENCE_THRESHOLD=0.04` (4 cents), `BOND_THRESHOLD=0.97`
- **Output:** `DivergenceSignal` objects → `.to_market_dict()` for IG agent

## Two signal types I produce

### 1. Divergence Signal
```
PM_price vs Kalshi_price on same event, gap > 4%
→ PM > Kalshi: global crowd more bullish → trade IG instrument in bullish direction
→ PM < Kalshi: US professionals more bullish → trade IG in opposite direction
confidence = min(0.85, 0.5 + abs(gap) * 4)
```

### 2. Bond Signal
```
PM_price > 0.97 (near-certain) + topic matches IG instrument
→ market consensus → ride the near-certainty on correlated IG instrument
confidence = price * 0.85 (scaled back — PM alone, no Kalshi confirmation)
```

## Topic → IG instrument mapping
| Keywords | IG Category | Direction when PM higher |
|----------|-------------|--------------------------|
| fed rate, fomc, rate cut | indices/sp500 | BUY |
| rate hike, hawkish | indices/sp500 | SELL |
| bitcoin, btc, crypto | indices/nasdaq | BUY |
| trump, election, republican | forex/gbpusd | SELL |
| ukraine, russia, nato | commodities/oil | BUY |
| gold, safe haven | commodities/gold | BUY |
| recession, gdp slowdown | indices/ftse | SELL |

## Market matching (fuzzy)
```python
# Matches PM ↔ Kalshi if they share ≥3 words of length ≥4
words1 & words2 >= 3
```

## What I push to graph
```python
# Polymarket market nodes (top 50)
# Kalshi market nodes (top 50)  
# DivergenceSignal nodes: {type: "Signal", pm_price, kalshi_price, divergence, ig_epic, direction, confidence}
POST /ingest/bulk {"nodes": [...], "source": "cross_venue_signal"}
```

## Relationships
- [[polymarket_collector]] — source of PM market prices
- [[kalshi_collector]] — source of Kalshi prices
- [[oracle]] — consumes my Signal nodes for synthesis
- [[ig_executor]] — executes on IG based on my signal output
- [[Forage Reality Graph]] — write destination for all market nodes + signals

## Observations
- 2026-04-08: Graph push confirmed working after `/ingest/bulk` `nodes` key fix
- Fuzzy matching is loose — 3-word overlap can match unrelated markets. Watch for false positives on generic political language.
- Settlement divergence is the highest-quality signal: Kalshi resolved + Polymarket still trading → near-zero-risk arb window
- Best signal quality: FOMC/rate decisions where Kalshi (US professionals) and PM (global crypto crowd) diverge
