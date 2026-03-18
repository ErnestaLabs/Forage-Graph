/**
 * Forage Graph API — src/server.ts
 *
 * Standalone Express server. Runs on Railway / any VPS.
 * The Apify actor POSTs to this after every tool call (fire and forget).
 * All graph data lives here — never on Apify infrastructure.
 *
 * Endpoints:
 *   POST /ingest              — receive tool output, extract entities, merge into graph
 *   POST /query               — find entities by name
 *   POST /enrich              — everything the graph knows about a domain/company
 *   POST /connections         — find relationship path between two entities
 *   POST /claim               — add a claim/provenance assertion
 *   GET  /claims/:entityName  — get all claims for an entity
 *   POST /regime              — set regime label on entity
 *   POST /signal              — add time-series signal data
 *   GET  /signals/:entityName — get signals for entity
 *   POST /causal_parents     — what drives this entity upstream
 *   POST /causal_children    — what this entity drives downstream
 *   POST /causal_path        — highest causal-weight path between entities
 *   POST /simulate           — propagate shock/boost/remove through graph
 *   GET  /stats              — graph size and coverage
 *   GET  /health             — liveness check
 *
 * Auth: Bearer token via GRAPH_API_SECRET env var.
 * All write endpoints require auth. /health is open.
 */

import express, { Request, Response, NextFunction } from 'express';
import { knowledgeGraph } from './knowledge-graph.js';

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.GRAPH_API_SECRET;

if (!SECRET) {
  console.error('GRAPH_API_SECRET env var is required');
  process.exit(1);
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Auth — all routes except /health require Bearer token
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') { next(); return; }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.use(requireAuth);

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  const healthy = await knowledgeGraph.isHealthy();
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    graph: healthy ? 'connected' : 'disconnected',
    ts: new Date().toISOString(),
  });
});

// ─── INGEST ───────────────────────────────────────────────────────────────────
// Called by Apify actor after every tool response — fire and forget on caller side.
// Returns 202 immediately, processes async.
//
// Body: { tool_name: string, result: any }

app.post('/ingest', (req: Request, res: Response) => {
  const { tool_name, result } = req.body;

  if (!tool_name || result === undefined) {
    res.status(400).json({ error: 'tool_name and result are required' });
    return;
  }

  // Respond immediately — never make the caller wait
  res.status(202).json({ accepted: true });

  // Process async, completely silent on errors
  knowledgeGraph.ingest(tool_name, result).catch(() => {});
});

// ─── QUERY ────────────────────────────────────────────────────────────────────
// Find entities by name, optionally filtered by type.
//
// Body: { name: string, type?: EntityType, min_confidence?: number }

app.post('/query', async (req: Request, res: Response) => {
  try {
    const { name, type, min_confidence = 0.0 } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }

    const entities = await knowledgeGraph.findEntity(name, type);
    const filtered = entities.filter(e => e.confidence >= min_confidence);

    res.json({
      query: name,
      type: type || 'any',
      count: filtered.length,
      entities: filtered.slice(0, 50).map(e => ({
        id: e.id,
        name: e.name,
        type: e.type,
        confidence: e.confidence,
        call_count: e.call_count,
        properties: e.properties,
        sources: e.sources,
        first_seen: e.first_seen,
        last_seen: e.last_seen,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ENRICH ───────────────────────────────────────────────────────────────────
// Everything the graph knows about a company or domain — entity + all relationships.
//
// Body: { identifier: string }

app.post('/enrich', async (req: Request, res: Response) => {
  try {
    const { identifier } = req.body;
    if (!identifier) { res.status(400).json({ error: 'identifier is required' }); return; }

    const result = await knowledgeGraph.enrich(identifier);

    if (!result.entity) {
      res.json({
        identifier,
        found: false,
        message: 'Not yet in graph. Feed data through find_leads, find_emails, or get_company_info first.',
      });
      return;
    }

    res.json({
      identifier,
      found: true,
      entity: {
        id: result.entity.id,
        name: result.entity.name,
        type: result.entity.type,
        confidence: result.entity.confidence,
        call_count: result.entity.call_count,
        first_seen: result.entity.first_seen,
        last_seen: result.entity.last_seen,
        properties: result.entity.properties,
        sources: result.entity.sources,
      },
      relationships: Object.fromEntries(
        Object.entries(result.related).map(([relation, nodes]) => [
          relation,
          nodes.map(n => ({ name: n.name, type: n.type, confidence: n.confidence })),
        ])
      ),
      confidence: result.confidence,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONNECTIONS ──────────────────────────────────────────────────────────────
// Find relationship path between two entities.
//
// Body: { from: string, to: string, max_hops?: number }

app.post('/connections', async (req: Request, res: Response) => {
  try {
    const { from, to, max_hops = 3 } = req.body;
    if (!from || !to) { res.status(400).json({ error: 'from and to are required' }); return; }

    const hops = Math.min(Math.max(1, max_hops), 5);
    const result = await knowledgeGraph.findConnections(from, to, hops);

    if (!result) {
      res.json({
        from, to,
        connected: false,
        message: `No connection found within ${hops} hops. One or both entities may not yet be in the graph.`,
      });
      return;
    }

    res.json({
      from, to,
      connected: true,
      hops: result.hops,
      path: result.path.map(n => ({ name: n.name, type: n.type })),
      relationships: result.edges.map(e => ({
        from: e.from_name,
        relation: e.relation,
        to: e.to_name,
        confidence: e.confidence,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── INDUSTRY + LOCATION SEARCH ───────────────────────────────────────────────
// Find companies by industry and optional location — answered from graph, no live API.
//
// Body: { industry: string, location?: string, min_confidence?: number }

app.post('/search', async (req: Request, res: Response) => {
  try {
    const { industry, location, min_confidence = 0.0 } = req.body;
    if (!industry) { res.status(400).json({ error: 'industry is required' }); return; }

    const companies = await knowledgeGraph.findByIndustryAndLocation(industry, location);
    const filtered = companies.filter(c => c.confidence >= min_confidence);

    res.json({
      industry,
      location: location || null,
      count: filtered.length,
      companies: filtered.slice(0, 100).map(c => ({
        name: c.name,
        confidence: c.confidence,
        call_count: c.call_count,
        properties: c.properties,
        last_seen: c.last_seen,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATS ────────────────────────────────────────────────────────────────────

app.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await knowledgeGraph.getStats();
    res.json({
      total_entities: stats.total_nodes,
      total_relationships: stats.total_edges,
      entities_by_type: stats.nodes_by_type,
      last_updated: stats.last_updated,
      status: stats.total_nodes > 0 ? 'active' : 'empty — grows with every Forage tool call',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLAIMS ───────────────────────────────────────────────────────────────────
// Add a provenance claim for an entity.
//
// Body: { entity: string, relation: string, target: string, assertion: string, source_url?: string, confidence?: number }

app.post('/claim', async (req: Request, res: Response) => {
  try {
    const { entity, relation, target, assertion, source_url, confidence = 0.8 } = req.body;
    if (!entity || !relation || !target || !assertion) {
      res.status(400).json({ error: 'entity, relation, target, and assertion are required' });
      return;
    }

    const claim = await knowledgeGraph.addClaim({
      entity,
      relation,
      target,
      assertion,
      source_url,
      confidence,
    });

    res.status(201).json({ success: true, claim });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get all claims for an entity.
//
// GET /claims/:entityName

app.get('/claims/:entityName', async (req: Request, res: Response) => {
  try {
    const { entityName } = req.params;
    const claims = await knowledgeGraph.getClaims(entityName);
    res.json({
      entity: entityName,
      count: claims.length,
      claims,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REGIME ─────────────────────────────────────────────────────────────────
// Set regime label on an entity.
//
// Body: { entity: string, regime: 'normal' | 'stressed' | 'pre_tipping' | 'post_event' }

app.post('/regime', async (req: Request, res: Response) => {
  try {
    const { entity, regime } = req.body;
    if (!entity || !regime) {
      res.status(400).json({ error: 'entity and regime are required' });
      return;
    }

    const validRegimes = ['normal', 'stressed', 'pre_tipping', 'post_event'];
    if (!validRegimes.includes(regime)) {
      res.status(400).json({ error: 'regime must be one of: normal, stressed, pre_tipping, post_event' });
      return;
    }

    const success = await knowledgeGraph.setRegime(entity, regime);
    res.json({ entity, regime, updated: success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SIGNALS (TIME-SERIES) ────────────────────────────────────────────────
// Add time-series signal data.
//
// Body: { entity: string, metric: string, value: number, timestamp?: number }

app.post('/signal', async (req: Request, res: Response) => {
  try {
    const { entity, metric, value, timestamp } = req.body;
    if (!entity || !metric || value === undefined) {
      res.status(400).json({ error: 'entity, metric, and value are required' });
      return;
    }

    await knowledgeGraph.addSignal({
      entity,
      metric,
      value,
      timestamp: timestamp || Date.now(),
    });

    res.status(202).json({ accepted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get signals for an entity.
//
// GET /signals/:entityName?metric=xxx&limit=100

app.get('/signals/:entityName', async (req: Request, res: Response) => {
  try {
    const { entityName } = req.params;
    const { metric, limit = '100' } = req.query;
    const signals = await knowledgeGraph.getSignals(
      entityName, 
      metric as string | undefined, 
      parseInt(limit as string)
    );
    res.json({
      entity: entityName,
      metric: metric || null,
      count: signals.length,
      signals,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CAUSAL QUERIES ──────────────────────────────────────────────────────
// Get entities that drive this entity (causal parents).
//
// Body: { entity: string, limit?: number }

app.post('/causal_parents', async (req: Request, res: Response) => {
  try {
    const { entity, limit = 10 } = req.body;
    if (!entity) { res.status(400).json({ error: 'entity is required' }); return; }

    const result = await knowledgeGraph.getCausalParents(entity, limit);
    res.json({ entity, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get entities that this entity drives (causal children).
//
// Body: { entity: string, limit?: number }

app.post('/causal_children', async (req: Request, res: Response) => {
  try {
    const { entity, limit = 10 } = req.body;
    if (!entity) { res.status(400).json({ error: 'entity is required' }); return; }

    const result = await knowledgeGraph.getCausalChildren(entity, limit);
    res.json({ entity, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Find highest causal-weight path between two entities.
//
// Body: { from: string, to: string }

app.post('/causal_path', async (req: Request, res: Response) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) { res.status(400).json({ error: 'from and to are required' }); return; }

    const result = await knowledgeGraph.getCausalPath(from, to);
    if (!result) {
      res.json({ from, to, found: false, message: 'No path found between entities' });
      return;
    }
    res.json({ from, to, found: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SIMULATE ─────────────────────────────────────────────────────────────
// Propagate a shock/boost/remove intervention through the graph.
//
// Body: { entity: string, intervention: 'shock' | 'boost' | 'remove', depth?: number }

app.post('/simulate', async (req: Request, res: Response) => {
  try {
    const { entity, intervention, depth = 3 } = req.body;
    if (!entity || !intervention) {
      res.status(400).json({ error: 'entity and intervention are required' });
      return;
    }

    const validInterventions = ['shock', 'boost', 'remove'];
    if (!validInterventions.includes(intervention)) {
      res.status(400).json({ error: 'intervention must be one of: shock, boost, remove' });
      return;
    }

    const result = await knowledgeGraph.simulate(entity, intervention, depth);
    res.json({ entity, intervention, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

async function start() {
  await knowledgeGraph.init();

  app.listen(PORT, () => {
    console.log(`Forage Graph API running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
