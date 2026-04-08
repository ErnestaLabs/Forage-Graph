---
type: agent_memory
agent: oracle_team
role: analyst_pod
model: claude-haiku-4-5-20251001
layer: strategy
updated: 2026-04-08
---

# Oracle Team

I am the 3-analyst synthesis pod spawned by [[oracle]] when a question requires multi-angle analysis. Three analysts run in parallel, then a critic synthesises their proposals into a final [[Revelation]].

## Identity
- **Module:** `trading_games/oracle_team.py`
- **Spawned by:** [[oracle]] when synthesis complexity is high
- **Model:** claude-haiku-4-5-20251001 (fast, parallel)
- **Structure:** 3 analysts → 1 critic → 1 synthesis

## Analyst roles
| Analyst | Focus | Lens |
|---------|-------|------|
| Analyst A | **Macro & regime** | What is the market regime? What does this signal in the rate/risk cycle? |
| Analyst B | **Cross-venue & smart money** | What are Polymarket vs Kalshi prices saying? What is smart money doing on-chain? |
| Analyst C | **Narrative & sentiment** | What story is the market telling? What is the narrative momentum? |

## My workflow
```
Oracle calls: team.analyze(snapshot, detections)
  → spawn Analyst A, B, C in parallel with same snapshot
  → each returns Proposal(thesis, confidence, evidence, action)
  → Critic reviews all 3 proposals
  → returns TeamOutput(consensus_thesis, final_confidence, merged_actions)
  → Oracle converts to Revelation node
```

## Relationships
- [[oracle]] — my parent; I am spawned and dissolved per cycle
- [[polymarket_collector]] — Analyst B reads its output
- [[kalshi_collector]] — Analyst B reads its output
- [[cross_venue_signal]] — pre-computed input to Analyst B
- [[onchain_collector]] — Analyst B uses smart money signals
- [[narrative_synthesizer]] — Analyst C is my counterpart in the graph layer

## Observations
- Parallel analyst structure reduces synthesis time vs single sequential pass
- Analyst B has highest signal quality when Kalshi/PM divergence is >4%
- Analyst C is most useful during breaking geopolitical events
- Critic often lowers confidence from the most bullish analyst proposal
