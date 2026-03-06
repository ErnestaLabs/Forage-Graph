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
 *   GET  /stats               — graph size and coverage
 *   GET  /health              — liveness check
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
