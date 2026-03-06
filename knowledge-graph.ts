/**
 * Forage Knowledge Graph — src/knowledge-graph.ts
 *
 * Storage: FalkorDB (Redis-compatible graph DB).
 * Swap KnowledgeStore internals for any graph DB without touching anything else.
 *
 * Rules unchanged from original architecture:
 * - Non-blocking: graph writes fire after response is sent, never add latency
 * - Privacy: PII hashed before storage, raw values never stored
 * - Passive accumulation: grows silently with every tool call
 * - Confidence increases with corroboration across users
 */

import { createClient } from 'redis';
import { createHash } from 'crypto';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type EntityType =
  | 'Company'
  | 'Person'
  | 'Location'
  | 'Technology'
  | 'Industry'
  | 'Domain'
  | 'JobTitle'
  | 'EmailPattern';

export type RelationType =
  | 'works_at'
  | 'located_in'
  | 'competitor_of'
  | 'uses_technology'
  | 'operates_in'
  | 'has_email_pattern'
  | 'has_domain'
  | 'reports_to'
  | 'founded_by'
  | 'investor_in';

export interface GraphNode {
  id: string;
  type: EntityType;
  name: string;
  properties: Record<string, any>;
  sources: string[];
  confidence: number;
  call_count: number;
  first_seen: string;
  last_seen: string;
}

export interface GraphEdge {
  id: string;
  from_id: string;
  to_id: string;
  from_name: string;
  to_name: string;
  relation: RelationType;
  properties: Record<string, any>;
  confidence: number;
  call_count: number;
  first_seen: string;
  last_seen: string;
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  nodes_by_type: Record<string, number>;
  last_updated: string;
}

// ─── STORAGE LAYER ────────────────────────────────────────────────────────────
// Uses FalkorDB via redis client. Swap internals here when scaling.
// FalkorDB speaks Redis protocol — same client, graph-native Cypher queries on top.

class KnowledgeStore {
  private client: ReturnType<typeof createClient> | null = null;
  private graphName = 'forage_v1';

  async init(): Promise<void> {
    const url = process.env.FALKORDB_URL || process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = createClient({ url });
    this.client.on('error', (err) => {
      // Silent — storage errors must never surface to caller
      if (process.env.NODE_ENV !== 'production') console.error('KV error:', err.message);
    });
    await this.client.connect();

    // Create indexes for fast lookups
    await this.ensureIndexes();
  }

  private async ensureIndexes(): Promise<void> {
    if (!this.client) return;
    try {
      // FalkorDB: create indexes on node properties we query by
      await this.graphQuery(
        `CREATE INDEX FOR (n:Entity) ON (n.id)`,
        {}
      ).catch(() => {}); // Ignore if already exists

      await this.graphQuery(
        `CREATE INDEX FOR (n:Entity) ON (n.name_lower)`,
        {}
      ).catch(() => {});

      await this.graphQuery(
        `CREATE INDEX FOR (n:Entity) ON (n.type)`,
        {}
      ).catch(() => {});
    } catch {
      // Indexes are optional — graph still works without them
    }
  }

  // Execute a Cypher query against FalkorDB
  async graphQuery(query: string, params: Record<string, any>): Promise<any[]> {
    if (!this.client) return [];
    try {
      // FalkorDB uses GRAPH.QUERY command
      const paramStr = Object.entries(params)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');

      const fullQuery = paramStr ? query : query;
      const result = await (this.client as any).sendCommand([
        'GRAPH.QUERY',
        this.graphName,
        query,
        '--params',
        JSON.stringify(params),
        '--compact',
      ]);
      return this.parseGraphResult(result);
    } catch (err: any) {
      // Fallback: try without params flag (older FalkorDB versions)
      try {
        let q = query;
        for (const [k, v] of Object.entries(params)) {
          q = q.replace(new RegExp(`\\$${k}`, 'g'), JSON.stringify(v));
        }
        const result = await (this.client as any).sendCommand([
          'GRAPH.QUERY',
          this.graphName,
          q,
        ]);
        return this.parseGraphResult(result);
      } catch {
        return [];
      }
    }
  }

  private parseGraphResult(raw: any): any[] {
    if (!raw || !Array.isArray(raw)) return [];
    // FalkorDB compact format: [header, data, stats]
    const data = raw[1];
    if (!data || !Array.isArray(data)) return [];
    return data;
  }

  async getNode(id: string): Promise<GraphNode | null> {
    const rows = await this.graphQuery(
      `MATCH (n:Entity {id: $id}) RETURN n`,
      { id }
    );
    if (!rows.length) return null;
    return this.rowToNode(rows[0][0]);
  }

  async setNode(node: GraphNode): Promise<void> {
    const props = this.flattenForCypher(node);
    await this.graphQuery(
      `MERGE (n:Entity {id: $id})
       SET n += $props
       SET n.name_lower = $name_lower`,
      {
        id: node.id,
        props,
        name_lower: node.name.toLowerCase(),
      }
    );
  }

  async getEdge(id: string): Promise<GraphEdge | null> {
    const rows = await this.graphQuery(
      `MATCH ()-[e:RELATES {id: $id}]->() RETURN e`,
      { id }
    );
    if (!rows.length) return null;
    return this.rowToEdge(rows[0][0]);
  }

  async setEdge(edge: GraphEdge): Promise<void> {
    const props = this.flattenForCypher(edge);
    await this.graphQuery(
      `MATCH (a:Entity {id: $from_id}), (b:Entity {id: $to_id})
       MERGE (a)-[e:RELATES {id: $edge_id}]->(b)
       SET e += $props`,
      {
        from_id: edge.from_id,
        to_id: edge.to_id,
        edge_id: edge.id,
        props,
      }
    );
  }

  async findNodesByName(nameLower: string, type?: string): Promise<GraphNode[]> {
    const query = type
      ? `MATCH (n:Entity) WHERE n.name_lower CONTAINS $name AND n.type = $type RETURN n ORDER BY n.confidence DESC LIMIT 20`
      : `MATCH (n:Entity) WHERE n.name_lower CONTAINS $name RETURN n ORDER BY n.confidence DESC LIMIT 20`;

    const params: any = { name: nameLower };
    if (type) params.type = type;

    const rows = await this.graphQuery(query, params);
    return rows.map(r => this.rowToNode(r[0])).filter(Boolean) as GraphNode[];
  }

  async getOutboundEdges(nodeId: string, relation?: string): Promise<GraphEdge[]> {
    const query = relation
      ? `MATCH (a:Entity {id: $id})-[e:RELATES]->(b:Entity) WHERE e.relation = $relation RETURN e ORDER BY e.confidence DESC`
      : `MATCH (a:Entity {id: $id})-[e:RELATES]->(b:Entity) RETURN e ORDER BY e.confidence DESC`;

    const params: any = { id: nodeId };
    if (relation) params.relation = relation;

    const rows = await this.graphQuery(query, params);
    return rows.map(r => this.rowToEdge(r[0])).filter(Boolean) as GraphEdge[];
  }

  async getInboundEdges(nodeId: string, relation?: string): Promise<GraphEdge[]> {
    const query = relation
      ? `MATCH (a:Entity)-[e:RELATES]->(b:Entity {id: $id}) WHERE e.relation = $relation RETURN e ORDER BY e.confidence DESC`
      : `MATCH (a:Entity)-[e:RELATES]->(b:Entity {id: $id}) RETURN e ORDER BY e.confidence DESC`;

    const params: any = { id: nodeId };
    if (relation) params.relation = relation;

    const rows = await this.graphQuery(query, params);
    return rows.map(r => this.rowToEdge(r[0])).filter(Boolean) as GraphEdge[];
  }

  async getStats(): Promise<GraphStats> {
    try {
      const nodeCount = await this.graphQuery(`MATCH (n:Entity) RETURN count(n)`, {});
      const edgeCount = await this.graphQuery(`MATCH ()-[e:RELATES]->() RETURN count(e)`, {});
      const byType = await this.graphQuery(
        `MATCH (n:Entity) RETURN n.type, count(n) ORDER BY count(n) DESC`,
        {}
      );

      const nodes_by_type: Record<string, number> = {};
      for (const row of byType) {
        if (row[0] && row[1]) nodes_by_type[row[0]] = parseInt(row[1]);
      }

      return {
        total_nodes: parseInt(nodeCount[0]?.[0] || '0'),
        total_edges: parseInt(edgeCount[0]?.[0] || '0'),
        nodes_by_type,
        last_updated: new Date().toISOString(),
      };
    } catch {
      return { total_nodes: 0, total_edges: 0, nodes_by_type: {}, last_updated: new Date().toISOString() };
    }
  }

  async findPath(fromId: string, toIds: string[], maxHops: number): Promise<{
    path: string[];
    edges: string[];
  } | null> {
    // FalkorDB native shortest path
    try {
      for (const toId of toIds) {
        const rows = await this.graphQuery(
          `MATCH p = shortestPath((a:Entity {id: $from})-[*..${maxHops}]->(b:Entity {id: $to}))
           RETURN [node in nodes(p) | node.id] as node_ids,
                  [rel in relationships(p) | rel.id] as edge_ids`,
          { from: fromId, to: toId }
        );
        if (rows.length && rows[0][0]) {
          return { path: rows[0][0], edges: rows[0][1] || [] };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  // Serialize a GraphNode/GraphEdge to flat Cypher-safe properties
  private flattenForCypher(obj: any): Record<string, any> {
    const flat: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object' && !Array.isArray(v)) {
        // Stringify nested objects — Cypher doesn't support nested maps
        flat[k] = JSON.stringify(v);
      } else if (Array.isArray(v)) {
        flat[k] = JSON.stringify(v);
      } else {
        flat[k] = v;
      }
    }
    return flat;
  }

  private rowToNode(raw: any): GraphNode | null {
    if (!raw) return null;
    const props = raw.properties || raw;
    try {
      return {
        id: props.id,
        type: props.type,
        name: props.name,
        properties: this.parseJsonField(props.properties),
        sources: this.parseJsonField(props.sources) || [],
        confidence: parseFloat(props.confidence) || 0.75,
        call_count: parseInt(props.call_count) || 1,
        first_seen: props.first_seen || new Date().toISOString(),
        last_seen: props.last_seen || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private rowToEdge(raw: any): GraphEdge | null {
    if (!raw) return null;
    const props = raw.properties || raw;
    try {
      return {
        id: props.id,
        from_id: props.from_id,
        to_id: props.to_id,
        from_name: props.from_name,
        to_name: props.to_name,
        relation: props.relation,
        properties: this.parseJsonField(props.properties),
        confidence: parseFloat(props.confidence) || 0.8,
        call_count: parseInt(props.call_count) || 1,
        first_seen: props.first_seen || new Date().toISOString(),
        last_seen: props.last_seen || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private parseJsonField(val: any): any {
    if (!val) return {};
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return {}; }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }
}

// ─── ENTITY EXTRACTORS ────────────────────────────────────────────────────────

function extractFromLeads(leads: any[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const lead of leads) {
    if (!lead) continue;

    const companyName = lead.company || lead.organization;
    if (companyName) {
      const companyNode = buildNode('Company', companyName, {
        website: lead.website || lead.companyWebsite || null,
        size: lead.company_size || lead.companySize || null,
        industry: lead.industry || null,
      }, 'forage/find-leads');
      nodes.push(companyNode);

      if (lead.industry) {
        const industryNode = buildNode('Industry', lead.industry, {}, 'forage/find-leads');
        nodes.push(industryNode);
        edges.push(buildEdge(companyNode, industryNode, 'operates_in', 'forage/find-leads'));
      }

      if (lead.location || lead.city || lead.country) {
        const loc = lead.location || [lead.city, lead.country].filter(Boolean).join(', ');
        const locationNode = buildNode('Location', loc, {}, 'forage/find-leads');
        nodes.push(locationNode);
        edges.push(buildEdge(companyNode, locationNode, 'located_in', 'forage/find-leads'));
      }

      const personName = lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
      if (personName && personName.length > 1) {
        const personNode = buildNode('Person', hashPII(personName), {
          title: lead.title || lead.jobTitle || null,
          seniority: lead.seniority || null,
          department: lead.department || null,
        }, 'forage/find-leads', 0.7);
        nodes.push(personNode);
        edges.push(buildEdge(personNode, companyNode, 'works_at', 'forage/find-leads'));

        const title = lead.title || lead.jobTitle;
        if (title) {
          const titleNode = buildNode('JobTitle', normaliseTitle(title), {}, 'forage/find-leads');
          nodes.push(titleNode);
          edges.push(buildEdge(personNode, titleNode, 'works_at', 'forage/find-leads'));
        }
      }

      const domain = extractDomain(lead.website || lead.companyWebsite || lead.email);
      if (domain) {
        const domainNode = buildNode('Domain', domain, {}, 'forage/find-leads');
        nodes.push(domainNode);
        edges.push(buildEdge(companyNode, domainNode, 'has_domain', 'forage/find-leads'));
      }
    }
  }

  return { nodes, edges };
}

function extractFromEmails(data: {
  domain: string;
  organization: string;
  pattern: string;
  emails: any[];
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (!data.domain) return { nodes, edges };

  const domainNode = buildNode('Domain', data.domain, {}, 'forage/find-emails');
  nodes.push(domainNode);

  if (data.organization) {
    const companyNode = buildNode('Company', data.organization, { domain: data.domain }, 'forage/find-emails', 0.9);
    nodes.push(companyNode);
    edges.push(buildEdge(companyNode, domainNode, 'has_domain', 'forage/find-emails'));

    if (data.pattern) {
      const patternNode = buildNode('EmailPattern', data.pattern, { domain: data.domain }, 'forage/find-emails', 0.95);
      nodes.push(patternNode);
      edges.push(buildEdge(companyNode, patternNode, 'has_email_pattern', 'forage/find-emails'));
    }
  }

  for (const email of (data.emails || [])) {
    if (!email.position) continue;
    const titleNode = buildNode('JobTitle', normaliseTitle(email.position), {
      department: email.department || null,
      seniority: email.seniority || null,
    }, 'forage/find-emails');
    nodes.push(titleNode);
  }

  return { nodes, edges };
}

function extractFromCompanyInfo(data: {
  domain: string;
  website?: any;
  email_intelligence?: any;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (!data.domain) return { nodes, edges };

  const domainNode = buildNode('Domain', data.domain, {}, 'forage/get-company-info');
  nodes.push(domainNode);

  const org = data.email_intelligence?.organization;
  if (org) {
    const companyNode = buildNode('Company', org, {
      domain: data.domain,
      title: data.website?.title || null,
      description: data.website?.description || null,
    }, 'forage/get-company-info', 0.9);
    nodes.push(companyNode);
    edges.push(buildEdge(companyNode, domainNode, 'has_domain', 'forage/get-company-info'));

    const socials = data.website?.social_links || {};
    for (const [platform, url] of Object.entries(socials)) {
      if (url) {
        const techNode = buildNode('Technology', platform, { url: String(url) }, 'forage/get-company-info');
        nodes.push(techNode);
        edges.push(buildEdge(companyNode, techNode, 'uses_technology', 'forage/get-company-info'));
      }
    }
  }

  return { nodes, edges };
}

function extractFromLocalLeads(data: {
  keyword: string;
  location: string;
  leads: any[];
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (!data.location) return { nodes, edges };

  const locationNode = buildNode('Location', data.location, {}, 'forage/find-local-leads');
  nodes.push(locationNode);
  const industryNode = buildNode('Industry', data.keyword, {}, 'forage/find-local-leads');
  nodes.push(industryNode);

  for (const lead of (data.leads || [])) {
    if (!lead.name) continue;
    const companyNode = buildNode('Company', lead.name, {
      address: lead.address || null,
      phone: lead.phone ? hashPII(lead.phone) : null,
      website: lead.website || null,
      rating: lead.rating || null,
    }, 'forage/find-local-leads', 0.95);
    nodes.push(companyNode);
    edges.push(buildEdge(companyNode, locationNode, 'located_in', 'forage/find-local-leads'));
    edges.push(buildEdge(companyNode, industryNode, 'operates_in', 'forage/find-local-leads'));

    if (lead.website) {
      const domain = extractDomain(lead.website);
      if (domain) {
        const domainNode = buildNode('Domain', domain, {}, 'forage/find-local-leads');
        nodes.push(domainNode);
        edges.push(buildEdge(companyNode, domainNode, 'has_domain', 'forage/find-local-leads'));
      }
    }
  }

  return { nodes, edges };
}

function extractFromWebSearch(data: {
  query: string;
  results: Array<{ title: string; link: string; snippet: string }>;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const result of (data.results || [])) {
    const domain = extractDomain(result.link);
    if (!domain) continue;
    nodes.push(buildNode('Domain', domain, {
      title: result.title || null,
      snippet: result.snippet?.substring(0, 200) || null,
    }, 'forage/search-web'));
  }

  return { nodes, edges };
}

// ─── KNOWLEDGE GRAPH ──────────────────────────────────────────────────────────

export class KnowledgeGraph {
  private db: KnowledgeStore;
  private ready = false;

  constructor() {
    this.db = new KnowledgeStore();
  }

  async init(): Promise<void> {
    try {
      await this.db.init();
      this.ready = true;
      console.log('Knowledge graph initialised');
    } catch (err: any) {
      console.error('Knowledge graph init failed:', err.message);
      this.ready = false;
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.ready && await this.db.isHealthy();
  }

  // Fire and forget — called after every tool response
  async ingest(toolName: string, result: any): Promise<void> {
    if (!this.ready) return;
    try {
      const { nodes, edges } = this.extract(toolName, result);
      if (nodes.length === 0 && edges.length === 0) return;
      await this.merge(nodes, edges);
    } catch {
      // Silent always
    }
  }

  private extract(toolName: string, result: any): { nodes: GraphNode[]; edges: GraphEdge[] } {
    switch (toolName) {
      case 'find_leads':       return extractFromLeads(result?.leads || []);
      case 'find_emails':      return extractFromEmails(result || {});
      case 'get_company_info': return extractFromCompanyInfo(result || {});
      case 'find_local_leads': return extractFromLocalLeads(result || {});
      case 'search_web':       return extractFromWebSearch(result || {});
      default:                 return { nodes: [], edges: [] };
    }
  }

  private async merge(newNodes: GraphNode[], newEdges: GraphEdge[]): Promise<void> {
    const now = new Date().toISOString();

    // Deduplicate within batch
    const nodeMap = new Map<string, GraphNode>();
    for (const node of newNodes) {
      if (nodeMap.has(node.id)) {
        nodeMap.set(node.id, mergeNodeProperties(nodeMap.get(node.id)!, node));
      } else {
        nodeMap.set(node.id, node);
      }
    }

    for (const node of nodeMap.values()) {
      const existing = await this.db.getNode(node.id);
      if (existing) {
        const merged = mergeNodeProperties(existing, node);
        merged.last_seen = now;
        merged.call_count = (existing.call_count || 1) + 1;
        merged.confidence = Math.min(0.99, existing.confidence + 0.03);
        await this.db.setNode(merged);
      } else {
        await this.db.setNode({ ...node, first_seen: now, last_seen: now });
      }
    }

    const edgeMap = new Map<string, GraphEdge>();
    for (const edge of newEdges) edgeMap.set(edge.id, edge);

    for (const edge of edgeMap.values()) {
      const existing = await this.db.getEdge(edge.id);
      if (existing) {
        existing.call_count = (existing.call_count || 1) + 1;
        existing.confidence = Math.min(0.99, existing.confidence + 0.05);
        existing.last_seen = now;
        await this.db.setEdge(existing);
      } else {
        await this.db.setEdge({ ...edge, first_seen: now, last_seen: now });
      }
    }
  }

  // ── QUERIES ───────────────────────────────────────────────────────────────

  async findEntity(name: string, type?: EntityType): Promise<GraphNode[]> {
    if (!this.ready) return [];
    const nodes = await this.db.findNodesByName(name.toLowerCase(), type);
    return nodes.sort((a, b) => {
      const aExact = a.name.toLowerCase() === name.toLowerCase() ? 1 : 0;
      const bExact = b.name.toLowerCase() === name.toLowerCase() ? 1 : 0;
      return (bExact - aExact) || (b.confidence - a.confidence);
    });
  }

  async getNeighbours(nodeId: string, relation?: RelationType): Promise<{
    node: GraphNode;
    edge: GraphEdge;
    neighbour: GraphNode;
  }[]> {
    if (!this.ready) return [];
    const edges = await this.db.getOutboundEdges(nodeId, relation);
    const results = [];

    for (const edge of edges) {
      const [node, neighbour] = await Promise.all([
        this.db.getNode(edge.from_id),
        this.db.getNode(edge.to_id),
      ]);
      if (node && neighbour) results.push({ node, edge, neighbour });
    }

    return results.sort((a, b) => b.edge.confidence - a.edge.confidence);
  }

  async findConnections(fromName: string, toName: string, maxHops = 3): Promise<{
    path: GraphNode[];
    edges: GraphEdge[];
    hops: number;
  } | null> {
    if (!this.ready) return null;

    const fromNodes = await this.findEntity(fromName);
    const toNodes = await this.findEntity(toName);
    if (!fromNodes.length || !toNodes.length) return null;

    const result = await this.db.findPath(
      fromNodes[0].id,
      toNodes.map(n => n.id),
      maxHops
    );
    if (!result) return null;

    const pathNodes = await Promise.all(result.path.map(id => this.db.getNode(id)));
    const pathEdges = await Promise.all(result.edges.map(id => this.db.getEdge(id)));

    return {
      path: pathNodes.filter(Boolean) as GraphNode[],
      edges: pathEdges.filter(Boolean) as GraphEdge[],
      hops: result.path.length - 1,
    };
  }

  async enrich(identifier: string): Promise<{
    entity: GraphNode | null;
    related: Record<string, GraphNode[]>;
    confidence: number;
  }> {
    if (!this.ready) return { entity: null, related: {}, confidence: 0 };

    let candidates = await this.findEntity(identifier, 'Domain');
    if (!candidates.length) candidates = await this.findEntity(identifier, 'Company');
    if (!candidates.length) candidates = await this.findEntity(identifier);
    if (!candidates.length) return { entity: null, related: {}, confidence: 0 };

    const entity = candidates[0];
    const neighbours = await this.getNeighbours(entity.id);

    const related: Record<string, GraphNode[]> = {};
    for (const { edge, neighbour } of neighbours) {
      const key = edge.relation;
      if (!related[key]) related[key] = [];
      related[key].push(neighbour);
    }

    return { entity, related, confidence: entity.confidence };
  }

  async findByIndustryAndLocation(industry: string, location?: string): Promise<GraphNode[]> {
    if (!this.ready) return [];

    const industryNodes = await this.findEntity(industry, 'Industry');
    if (!industryNodes.length) return [];

    const inEdges = await this.db.getInboundEdges(industryNodes[0].id, 'operates_in');
    const companies: GraphNode[] = [];

    for (const edge of inEdges) {
      const company = await this.db.getNode(edge.from_id);
      if (!company || company.type !== 'Company') continue;

      if (location) {
        const neighbours = await this.getNeighbours(company.id, 'located_in');
        const inLocation = neighbours.some(n =>
          n.neighbour.name.toLowerCase().includes(location.toLowerCase())
        );
        if (!inLocation) continue;
      }

      companies.push(company);
    }

    return companies.sort((a, b) => b.confidence - a.confidence);
  }

  async getStats(): Promise<GraphStats> {
    return this.db.getStats();
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildNode(
  type: EntityType,
  name: string,
  properties: Record<string, any>,
  source: string,
  confidence = 0.75
): GraphNode {
  const cleanName = name.trim();
  return {
    id: nodeId(type, cleanName),
    type,
    name: cleanName,
    properties: cleanProperties(properties),
    sources: [source],
    confidence,
    call_count: 1,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
}

function buildEdge(
  from: GraphNode,
  to: GraphNode,
  relation: RelationType,
  source: string,
  confidence = 0.8
): GraphEdge {
  return {
    id: edgeId(from.id, relation, to.id),
    from_id: from.id,
    to_id: to.id,
    from_name: from.name,
    to_name: to.name,
    relation,
    properties: { source },
    confidence,
    call_count: 1,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
}

function mergeNodeProperties(existing: GraphNode, incoming: GraphNode): GraphNode {
  const mergedSources = [...new Set([...existing.sources, ...incoming.sources])];
  const mergedProps: Record<string, any> = { ...existing.properties };
  for (const [k, v] of Object.entries(incoming.properties)) {
    if (v !== null && v !== undefined && v !== '') {
      if (mergedProps[k] === null || mergedProps[k] === undefined) {
        mergedProps[k] = v;
      }
    }
  }
  return { ...existing, properties: mergedProps, sources: mergedSources };
}

function nodeId(type: string, name: string): string {
  return createHash('sha256')
    .update(`${type}:${name.toLowerCase().trim()}`)
    .digest('hex')
    .substring(0, 16);
}

function edgeId(fromId: string, relation: string, toId: string): string {
  return createHash('sha256')
    .update(`${fromId}:${relation}:${toId}`)
    .digest('hex')
    .substring(0, 16);
}

function hashPII(value: string): string {
  return 'pii:' + createHash('sha256').update(value.toLowerCase().trim()).digest('hex').substring(0, 12);
}

function extractDomain(input: string): string | null {
  if (!input) return null;
  try {
    const s = input.includes('://') ? input : `https://${input}`;
    const host = new URL(s).hostname.replace(/^www\./, '');
    if (host.includes('.') && host.length > 3) return host;
  } catch {}
  const match = input.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})(?:\/|$)/);
  return match ? match[1] : null;
}

function normaliseTitle(title: string): string {
  return title
    .replace(/\b(senior|sr|junior|jr|lead|principal|associate|staff|vp of|head of|director of|chief)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function cleanProperties(props: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && v !== undefined && v !== '') clean[k] = v;
  }
  return clean;
}

export const knowledgeGraph = new KnowledgeGraph();
