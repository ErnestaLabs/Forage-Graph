---
type: entity
entity_type: Platform
updated: 2026-04-08
---

# Forage Reality Graph

I am the persistent, shared memory of the [[Forage]] organism. Every agent reads from me and writes to me. I am a FalkorDB graph database wrapped by a Node.js/TypeScript Express API, deployed on Railway.

## Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Always 200 — check `graph` field for DB state |
| POST | `/query` | Find entities by name or type |
| POST | `/ingest/bulk` | Bulk write nodes + connections |
| POST | `/ingest` | Single entity ingest |
| POST | `/signal` | Write a metric signal |
| POST | `/enrich` | Full enrichment for an identifier |
| POST | `/connections` | All connections for an entity |
| POST | `/simulate` | Run a what-if scenario |

## Auth
All endpoints require: `Authorization: Bearer $GRAPH_API_SECRET`

## Write format (all agents use this)
```json
POST /ingest/bulk
{
  "nodes": [
    {"id": "unique_id", "type": "EntityType", "name": "...", "source": "agent_name", ...extra_fields}
  ],
  "connections": [
    {"from": "id_a", "to": "id_b", "type": "relation_type", "confidence": 0.8}
  ],
  "source": "agent_name"
}
```
Note: extra fields beyond `{type, name, source, confidence}` are folded into `properties` automatically.

## Query format
```json
POST /query
{"type": "PredictionMarket", "limit": 100}    // type-only listing
{"name": "Federal Reserve", "type": "CentralBank"}  // named lookup
```

## Signal format
```json
POST /signal
{"entity": "oracle", "metric": "cycle_complete", "value": 1, "timestamp": 1712345678000}
```

## Entity type system
200+ EntityTypes, 150+ RelationTypes — see `knowledge-graph.ts`.
Key types: Person, Nation, Event, Concept, PredictionMarket, Signal, Revelation, Narrative, Trade, CausalChain

## Relationships in this file
- [[oracle]] — writes Revelation nodes every 5 minutes
- [[polymarket_collector]] — writes PredictionMarket + OddsSnapshot
- [[kalshi_collector]] — writes PredictionMarket (Kalshi)
- [[onchain_collector]] — writes Source + Trade
- [[cross_venue_signal]] — writes Signal + arbitrage nodes
- [[intel_collector]] — writes Entity + Event from news
- [[wikidata_loader]] — writes Person, Nation, Concept enrichment
- [[gleif_loader]] — writes Corporation + corporate structure
- [[graph_oracle]] — reads everything
- [[narrative_synthesizer]] — reads + writes Narrative
- [[signal_monitor]] — reads TimeSeriesPoint, writes anomaly Signals
- [[causal_analyst]] — reads + writes CausalChain
- [[claude]] — maintains the API and schema

## Current state (2026-04-08)
- Startup: resilient (listen first, DB retry loop)
- Health check: always 200 (degraded when DB reconnecting)
- `/query`: accepts type-only queries, returns `nodes` + `entities` aliases
- `/ingest/bulk`: accepts both `nodes` and `entities` keys, normalises agent flat format
- Limit: configurable up to 500 nodes per FalkorDB query
