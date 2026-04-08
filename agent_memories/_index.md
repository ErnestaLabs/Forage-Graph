---
type: index
updated: 2026-04-08
---

# Forage Agent Memory Vault

This vault is the shared cognitive layer of the Forage organism. Each agent reads its own node on startup, writes observations back during runtime, and the [[Forage Reality Graph]] syncs both directions.

**Bidirectional sync rule:** Every observation written here should also be pushed to the graph via `/ingest/bulk` or `/signal`. Every graph node of type `AIAgent` should have a corresponding memory file here.

## Agents

| File | Role | Layer |
|------|------|-------|
| [[claude]] | Dev assistant, architect, builder | Infrastructure |
| [[oracle]] | Meta-intelligence, revelation engine | Strategy |
| [[oracle_team]] | 3-analyst synthesis pod | Strategy |
| [[graph_oracle]] | Graph query interface | Data |
| [[narrative_synthesizer]] | Story builder from graph chains | Intelligence |
| [[signal_monitor]] | Time-series anomaly detection | Intelligence |
| [[causal_analyst]] | Causal chain tracer | Intelligence |
| [[intelligence_collector]] | Raw intel ingestion | Data |
| [[polymarket_collector]] | Polymarket market snapshots | Data |
| [[kalshi_collector]] | Kalshi price feed | Data |
| [[onchain_collector]] | Polygon on-chain smart money | Data |
| [[cross_venue_signal]] | Cross-venue divergence detector | Signal |
| [[intel_collector]] | Global entity intelligence | Data |
| [[intel_daemon]] | Always-on background feeder | Data |
| [[wikidata_loader]] | Wikidata entity enrichment | Data |
| [[gleif_loader]] | GLEIF legal entity data | Data |

## Graph sync endpoints
- Push: `POST /ingest/bulk` with `{"nodes": [...], "source": "agent_memory"}`
- Pull: `POST /query` with `{"type": "AIAgent", "limit": 50}`
- Signal: `POST /signal` with `{"entity": "<agent_name>", "metric": "<metric>", "value": <n>}`

## Memory format
Each file uses [[WikiLinks]] for entity references.
Agents append to `## Observations` during runtime.
Do NOT delete entries — strike through stale ones instead.
