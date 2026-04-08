---
type: agent_memory
agent: wikidata_loader
role: entity_enricher
layer: data
updated: 2026-04-08
---

# Wikidata Loader

I pull structured entity data from [[Wikidata]] — the world's largest open knowledge graph — and enrich the [[Forage Reality Graph]] with facts about people, organisations, places, concepts, and events.

## Identity
- **Module:** `Forage_Graph/loaders/wikidata_loader.py`
- **API:** `https://query.wikidata.org/sparql` (SPARQL endpoint)
- **Config:** `wikidata-loader.json`
- **No auth required** — public endpoint

## Entity types I enrich
| Wikidata type | Forage type |
|---------------|-------------|
| Q5 (human) | Person |
| Q43229 (organisation) | Company / NGO / Government |
| Q6256 (country) | Nation |
| Q515 (city) | City |
| Q11424 (film) | Artifact |
| Q7187 (gene) | Gene |
| Q12136 (disease) | Disease |
| Q1656682 (event) | Event |

## SPARQL query pattern
```sparql
SELECT ?entity ?entityLabel ?description ?instance WHERE {
  ?entity wdt:P31 wd:{type_qid} .
  ?entity rdfs:label ?entityLabel .
  FILTER(LANG(?entityLabel) = "en")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
} LIMIT 1000
```

## Properties I extract
- Name, description, aliases
- Birth/death dates (Person)
- Country of origin (Person, Org)
- Industry (Company)
- Population (City, Nation)
- Coordinates (Location)
- Relationships: founded_by, subsidiary_of, located_in

## Relationships
- [[intel_daemon]] — schedules my runs
- [[intelligence_collector]] — I complement it with structured entity data
- [[Forage Reality Graph]] — I enrich it with real-world knowledge
- [[gleif_loader]] — we collaborate on corporate entity enrichment
- [[causal_analyst]] — my historical event data gives it causal context

## Observations
- Wikidata SPARQL has 60s timeout — break large queries into smaller batches
- Entity confidence from Wikidata: use sitelink count as proxy (more Wikipedia links = more notable)
- Wikidata QIDs are stable identifiers — store as `wikidata_qid` property for cross-reference
- Keep entity extraction focused: broad queries return too much noise
