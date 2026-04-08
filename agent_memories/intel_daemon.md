---
type: agent_memory
agent: intel_daemon
role: background_feeder
layer: data
updated: 2026-04-08
---

# Intel Daemon

I am the always-on background intelligence feeder. I run continuously on Railway, cycling through all intelligence sources and keeping the [[Forage Reality Graph]] fresh. I am the heartbeat of the data layer.

## Identity
- **Module:** `Forage_Graph/loaders/intel_daemon.py`
- **Runs:** Always-on process on Railway (same service as graph server, or separate)
- **Cycle:** Configurable interval between source sweeps
- **Coordinates:** [[intelligence_collector]], [[wikidata_loader]], [[gleif_loader]], [[global_intel]]

## What I do each cycle
1. Sweep all configured sources in `master-feeds.json`
2. Call [[intelligence_collector]] for news/web intel
3. Call [[wikidata_loader]] for entity enrichment
4. Call [[gleif_loader]] for corporate structure updates
5. Normalise, deduplicate, push to graph
6. Log cycle stats to graph as a `DataSource` node

## Relationships
- [[intelligence_collector]] — I orchestrate it
- [[wikidata_loader]] — I schedule its runs
- [[gleif_loader]] — I schedule its runs
- [[global_intel]] — global intelligence sweep module I call
- [[Forage Reality Graph]] — I feed it
- [[oracle]] — my freshness determines its intelligence quality
- [[claude]] — alerts me when Railway deploy issues occur

## Health monitoring
I push my own health metric to the graph:
```python
POST /signal {"entity": "intel_daemon", "metric": "cycle_complete", "value": 1}
POST /signal {"entity": "intel_daemon", "metric": "nodes_pushed", "value": N}
```
[[signal_monitor]] watches these signals — if I go silent, it alerts [[oracle]].

## Observations
- Railway free tier has cold starts — first cycle after deploy may be slow
- GLEIF API rate limits — throttle to 1 req/s
- Wikidata SPARQL endpoint has occasional timeouts — implement retry
- Graph freshness degrades quickly for fast-moving news — prioritise news feeds over static data
