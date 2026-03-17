/**
 * Knowledge Graph Service — src/knowledge-graph.ts
 *
 * FalkorDB-backed graph storage for Forage entities and relationships.
 * All data persists across restarts. Designed for Railway / VPS deployment.
 */

import { createClient, RedisClientType } from 'redis';
import { randomUUID } from 'crypto';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type EntityType = 'company' | 'person' | 'location' | 'industry' | 'technology' | 'product';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  confidence: number;
  call_count: number;
  properties: Record<string, any>;
  sources: string[];
  first_seen: string;
  last_seen: string;
}

export interface Relationship {
  id: string;
  from_id: string;
  to_id: string;
  from_name: string;
  to_name: string;
  relation: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
}

// ─── KNOWLEDGE GRAPH CLASS ─────────────────────────────────────────────────────

class KnowledgeGraph {
  private client: RedisClientType | null = null;
  private ready: boolean = false;

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const url = process.env.FALKORDB_URL || process.env.REDIS_URL || 'redis://localhost:6379';
    console.log('Connecting to FalkorDB at:', url);
    
    try {
      const parsed = new URL(url);
      console.log('URL parsed - Protocol:', parsed.protocol, 'Host:', parsed.hostname, 'Port:', parsed.port);
    } catch (e) {
      console.error('Invalid URL format:', url);
      // Depending on requirements, we might want to throw here instead of continuing
    }
    
    this.client = createClient({ 
      url,
      socket: {
        reconnectStrategy: (retries) => {
          console.log(`Reconnect attempt ${retries}`);
          return Math.min(retries * 50, 500);
        },
        connectTimeout: 10000,
      }
    });
    
    this.client.on('error', (err) => {
      console.error('KV error:', err.message || err);
    });
    
    this.client.on('connect', () => {
      console.log('Redis client connected event');
    });
    
    this.client.on('ready', () => {
      console.log('Redis client ready event');
      this.ready = true;
    });
    
    this.client.on('end', () => {
      console.log('Redis client disconnected');
      this.ready = false;
    });

    try {
      await this.client.connect();
      console.log('FalkorDB connected successfully');
      const ping = await this.client.ping();
      console.log('Ping result:', ping);
    } catch (err: any) {
      console.error('Failed to connect to FalkorDB:', err.message || err);
      throw err;
    }

    await this.ensureIndexes();
    console.log('Knowledge Graph initialized');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.ready = false;
      this.client = null;
    }
  }

  isHealthy(): boolean {
    return this.ready && (this.client?.isReady ?? false);
  }

  // ─── INDEXES ──────────────────────────────────────────────────────────────────

  private async ensureIndexes(): Promise<void> {
    // Placeholder for index creation logic
    console.log('Indexes ensured');
  }

  // ─── ENTITY OPERATIONS ───────────────────────────────────────────────────────

  async upsertEntity(
    name: string,
    type: EntityType,
    properties: Record<string, any> = {},
    source: string,
    confidence: number = 0.8
  ): Promise<Entity> {
    this.assertInitialized();

    const id = this.entityId(name, type);
    const now = new Date().toISOString();

    const exists = await this.client!.hGetAll(`entity:${id}`);
    const isNew = Object.keys(exists).length === 0;

    const entity: Entity = {
      id,
      name,
      type,
      confidence: isNew ? confidence : Math.max(parseFloat(exists.confidence || '0'), confidence),
      call_count: isNew ? 1 : parseInt(exists.call_count || '0', 10) + 1,
      properties: isNew ? properties : { ...JSON.parse(exists.properties || '{}'), ...properties },
      sources: isNew ? [source] : Array.from(new Set([...JSON.parse(exists.sources || '[]'), source])),
      first_seen: isNew ? now : exists.first_seen || now,
      last_seen: now,
    };

    const multi = this.client!.multi();
    
    multi.hSet(`entity:${id}`, {
      name: entity.name,
      type: entity.type,
      confidence: entity.confidence.toString(),
      call_count: entity.call_count.toString(),
      properties: JSON.stringify(entity.properties),
      sources: JSON.stringify(entity.sources),
      first_seen: entity.first_seen,
      last_seen: entity.last_seen,
    });

    multi.sAdd(`index:type:${type}`, id);
    multi.sAdd(`index:name:${name.toLowerCase()}`, id);

    await multi.exec();

    console.log(`Upserted ${type}: ${name} (calls: ${entity.call_count})`);
    return entity;
  }

  async findEntity(name: string, type?: EntityType): Promise<Entity[]> {
    this.assertInitialized();

    const nameIds = await this.client!.sMembers(`index:name:${name.toLowerCase()}`);
    let ids = new Set(nameIds);

    if (type) {
      const typeIds = await this.client!.sMembers(`index:type:${type}`);
      const typeSet = new Set(typeIds);
      ids = new Set([...ids].filter(id => typeSet.has(id)));
    }

    if (ids.size === 0) return [];

    const multi = this.client!.multi();
    for (const id of ids) {
      multi.hGetAll(`entity:${id}`);
    }
    
    const results = await multi.exec() as Record<string, string>[];
    
    const entities: Entity[] = [];
    const idArray = Array.from(ids);
    
    for (let i = 0; i < results.length; i++) {
      const data = results[i];
      if (data && Object.keys(data).length > 0) {
        entities.push(this.hydrateEntity(idArray[i], data));
      }
    }

    return entities.sort((a, b) => b.confidence - a.confidence);
  }

  async enrich(identifier: string): Promise<{ entity: Entity | null; related: Record<string, Entity[]>; confidence: number }> {
    this.assertInitialized();

    let entities = await this.findEntity(identifier);
    
    if (entities.length === 0 && identifier.includes('.')) {
      const domain = identifier.toLowerCase().replace(/^www\./, '').split('/')[0];
      entities = await this.findEntity(domain);
    }

    if (entities.length === 0) {
      return { entity: null, related: {}, confidence: 0 };
    }

    const main = entities[0];
    const related: Record<string, Entity[]> = {};

    const [relIdsFrom, relIdsTo] = await Promise.all([
      this.client!.sMembers(`rel:from:${main.id}`),
      this.client!.sMembers(`rel:to:${main.id}`)
    ]);
    
    const allRelIds = Array.from(new Set([...relIdsFrom, ...relIdsTo]));

    if (allRelIds.length > 0) {
      const relMulti = this.client!.multi();
      for (const relId of allRelIds) {
        relMulti.hGetAll(`relationship:${relId}`);
      }
      const relResults = await relMulti.exec() as Record<string, string>[];
      
      const entityIdsToFetch = new Set<string>();
      const validRelations: Array<{otherId: string, relation: string}> = [];
      
      for (const relData of relResults) {
        if (!relData || Object.keys(relData).length === 0) continue;
        
        const isFrom = relData.from_id === main.id;
        const otherId = isFrom ? relData.to_id : relData.from_id;
        
        entityIdsToFetch.add(otherId);
        validRelations.push({ otherId, relation: relData.relation });
      }
      
      if (entityIdsToFetch.size > 0) {
        const entityMulti = this.client!.multi();
        const entityIdsArray = Array.from(entityIdsToFetch);
        for (const id of entityIdsArray) {
          entityMulti.hGetAll(`entity:${id}`);
        }
        
        const entityResults = await entityMulti.exec() as Record<string, string>[];
        const entityMap = new Map<string, Entity>();
        
        for (let i = 0; i < entityResults.length; i++) {
          const data = entityResults[i];
          if (data && Object.keys(data).length > 0) {
            entityMap.set(entityIdsArray[i], this.hydrateEntity(entityIdsArray[i], data));
          }
        }
        
        for (const {otherId, relation} of validRelations) {
          const otherEntity = entityMap.get(otherId);
          if (otherEntity) {
            if (!related[relation]) related[relation] = [];
            related[relation].push(otherEntity);
          }
        }
      }
    }

    const relCount = allRelIds.length;
    const confidence = Math.min(0.3 + (relCount * 0.1), 1.0);

    return { entity: main, related, confidence };
  }

  async findConnections(from: string, to: string, maxHops: number = 3): Promise<{ hops: number; path: Entity[]; edges: Relationship[] } | null> {
    this.assertInitialized();

    const fromEntities = await this.findEntity(from);
    if (fromEntities.length === 0) return null;
    
    const targetEntities = await this.findEntity(to);
    if (targetEntities.length === 0) return null;
    const targetId = targetEntities[0].id;

    const startId = fromEntities[0].id;
    
    // Simple BFS
    const queue: Array<{ id: string; hops: number; path: string[]; edges: string[] }> = [];
    const visited = new Set<string>();

    queue.push({ id: startId, hops: 0, path: [startId], edges: [] });
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.id === targetId) {
        return this.hydratePathAndEdges(current.path, current.edges, current.hops);
      }

      if (current.hops >= maxHops) continue;

      const neighbors = await this.client!.sMembers(`rel:from:${current.id}`);
      
      if (neighbors.length > 0) {
        const multi = this.client!.multi();
        for (const relId of neighbors) {
          multi.hGetAll(`relationship:${relId}`);
        }
        
        const relResults = await multi.exec() as Record<string, string>[];
        
        for (let i = 0; i < relResults.length; i++) {
          const relData = relResults[i];
          if (!relData || Object.keys(relData).length === 0) continue;
          
          const nextId = relData.to_id;
          const relId = neighbors[i];
          
          if (!visited.has(nextId)) {
            visited.add(nextId);
            queue.push({
              id: nextId,
              hops: current.hops + 1,
              path: [...current.path, nextId],
              edges: [...current.edges, relId]
            });
          }
        }
      }
    }

    return null;
  }
  
  private async hydratePathAndEdges(pathIds: string[], edgeIds: string[], hops: number) {
    const path: Entity[] = [];
    const edges: Relationship[] = [];
    
    if (pathIds.length > 0) {
      const pathMulti = this.client!.multi();
      for (const id of pathIds) {
        pathMulti.hGetAll(`entity:${id}`);
      }
      const pathResults = await pathMulti.exec() as Record<string, string>[];
      for (let i = 0; i < pathResults.length; i++) {
        const data = pathResults[i];
        if (data && Object.keys(data).length > 0) {
          path.push(this.hydrateEntity(pathIds[i], data));
        }
      }
    }

    if (edgeIds.length > 0) {
      const edgeMulti = this.client!.multi();
      for (const edgeId of edgeIds) {
        edgeMulti.hGetAll(`relationship:${edgeId}`);
      }
      const edgeResults = await edgeMulti.exec() as Record<string, string>[];
      for (let i = 0; i < edgeResults.length; i++) {
        const data = edgeResults[i];
        if (data && Object.keys(data).length > 0) {
          edges.push(this.hydrateRelationship(edgeIds[i], data));
        }
      }
    }

    return { hops, path, edges };
  }

  async findByIndustryAndLocation(industry: string, location?: string): Promise<Entity[]> {
    this.assertInitialized();

    const industryEntities = await this.findEntity(industry, 'industry');
    if (industryEntities.length === 0) return [];

    const results: Entity[] = [];
    const locationLower = location?.toLowerCase();
    
    for (const ind of industryEntities) {
      const relIds = await this.client!.sMembers(`rel:from:${ind.id}`);
      
      if (relIds.length === 0) continue;
      
      const multi = this.client!.multi();
      for (const relId of relIds) {
        multi.hGetAll(`relationship:${relId}`);
      }
      
      const relResults = await multi.exec() as Record<string, string>[];
      const validCompanyIds = new Set<string>();
      
      for (const relData of relResults) {
        if (!relData || Object.keys(relData).length === 0) continue;
        if (relData.relation === 'industry' || relData.relation === 'operates_in') {
          validCompanyIds.add(relData.to_id);
        }
      }
      
      if (validCompanyIds.size > 0) {
        const companyIdsArray = Array.from(validCompanyIds);
        const companyMulti = this.client!.multi();
        
        for (const id of companyIdsArray) {
          companyMulti.hGetAll(`entity:${id}`);
        }
        
        const companyResults = await companyMulti.exec() as Record<string, string>[];
        
        for (let i = 0; i < companyResults.length; i++) {
          const companyData = companyResults[i];
          if (companyData && Object.keys(companyData).length > 0) {
            const company = this.hydrateEntity(companyIdsArray[i], companyData);
            
            if (locationLower) {
              const props = company.properties;
              const companyLoc = String(props.location || props.city || props.country || '').toLowerCase();
              if (companyLoc.includes(locationLower)) {
                results.push(company);
              }
            } else {
              results.push(company);
            }
          }
        }
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  async addRelationship(
    from: Entity,
    to: Entity,
    relation: string,
    confidence: number = 0.8
  ): Promise<Relationship> {
    this.assertInitialized();

    const id = `${from.id}-${relation}-${to.id}`;
    const now = new Date().toISOString();

    const exists = await this.client!.hGetAll(`relationship:${id}`);
    const isNew = Object.keys(exists).length === 0;

    const rel: Relationship = {
      id,
      from_id: from.id,
      to_id: to.id,
      from_name: from.name,
      to_name: to.name,
      relation,
      confidence: isNew ? confidence : Math.max(parseFloat(exists.confidence || '0'), confidence),
      first_seen: isNew ? now : exists.first_seen || now,
      last_seen: now,
    };

    const multi = this.client!.multi();

    multi.hSet(`relationship:${id}`, {
      from_id: rel.from_id,
      to_id: rel.to_id,
      from_name: rel.from_name,
      to_name: rel.to_name,
      relation: rel.relation,
      confidence: rel.confidence.toString(),
      first_seen: rel.first_seen,
      last_seen: rel.last_seen,
    });

    multi.sAdd(`rel:from:${from.id}`, id);
    multi.sAdd(`rel:to:${to.id}`, id);
    multi.sAdd(`rel:type:${relation}`, id);

    await multi.exec();

    console.log(`Relationship: ${from.name} ${relation} ${to.name}`);
    return rel;
  }

  async ingest(toolName: string, result: any): Promise<void> {
    if (!this.client) {
      console.error('Cannot ingest — KnowledgeGraph not initialized');
      return;
    }

    console.log(`Ingesting from ${toolName}...`);

    try {
      const entities = this.extractEntities(toolName, result);
      
      const savedEntities: Entity[] = [];
      // In a real high-throughput system, we might want to parallelize this
      // but sequential is safer for now to avoid overwhelming Redis
      for (const e of entities) {
        const saved = await this.upsertEntity(e.name, e.type, e.properties, toolName, e.confidence);
        savedEntities.push(saved);
      }

      for (let i = 0; i < savedEntities.length; i++) {
        for (let j = i + 1; j < savedEntities.length; j++) {
          const a = savedEntities[i];
          const b = savedEntities[j];
          
          let relation = 'related_to';
          if (a.type === 'company' && b.type === 'person') relation = 'employs';
          else if (a.type === 'person' && b.type === 'company') relation = 'works_at';
          else if (a.type === 'company' && b.type === 'industry') relation = 'operates_in';
          else if (a.type === 'company' && b.type === 'technology') relation = 'uses';
          else if (a.type === 'company' && b.type === 'location') relation = 'located_in';

          await this.addRelationship(a, b, relation);
        }
      }

      console.log(`Ingested ${entities.length} entities from ${toolName}`);
    } catch (err: any) {
      console.error('Ingest error:', err.message || err);
      throw err;
    }
  }

  private extractEntities(toolName: string, result: any): Array<{ name: string; type: EntityType; confidence: number; properties: Record<string, any> }> {
    const entities: Array<{ name: string; type: EntityType; confidence: number; properties: Record<string, any> }> = [];

    if (!result) return entities;

    if (toolName === 'find_leads' || toolName === 'get_company_info') {
      if (result.company || result.name) {
        const company = result.company || result;
        entities.push({
          name: company.name || company.company || 'Unknown',
          type: 'company',
          confidence: 0.9,
          properties: {
            domain: company.domain || result.domain,
            industry: company.industry,
            size: company.size || company.employees,
            location: company.location || company.city,
            description: company.description,
            ...company
          }
        });
      }
    }

    if (toolName === 'find_emails') {
      if (Array.isArray(result.emails)) {
        for (const email of result.emails) {
          if (email.name || email.person) {
            entities.push({
              name: email.name || email.person,
              type: 'person',
              confidence: 0.8,
              properties: {
                email: email.email,
                title: email.title || email.position,
                source: email.source
              }
            });
          }
        }
      }
      if (result.domain) {
        entities.push({
          name: result.domain,
          type: 'company',
          confidence: 0.7,
          properties: { domain: result.domain }
        });
      }
    }

    if (toolName === 'get_company_info' && Array.isArray(result.technologies)) {
      for (const tech of result.technologies) {
        entities.push({
          name: typeof tech === 'string' ? tech : tech.name,
          type: 'technology',
          confidence: 0.7,
          properties: typeof tech === 'object' ? tech : {}
        });
      }
    }

    const industries = this.extractIndustries(result);
    for (const ind of industries) {
      entities.push({
        name: ind,
        type: 'industry',
        confidence: 0.6,
        properties: {}
      });
    }

    return entities;
  }

  private extractIndustries(result: any): string[] {
    const industries: string[] = [];
    const text = JSON.stringify(result).toLowerCase();
    
    const commonIndustries = [
      'software', 'saas', 'fintech', 'healthcare', 'biotech', 'ecommerce',
      'retail', 'manufacturing', 'consulting', 'marketing', 'education',
      'real estate', 'construction', 'transportation', 'energy', 'media'
    ];

    for (const ind of commonIndustries) {
      if (text.includes(ind)) industries.push(ind);
    }

    return Array.from(new Set(industries));
  }

  async getStats(): Promise<{
    total_nodes: number;
    total_edges: number;
    nodes_by_type: Record<string, number>;
    last_updated: string;
  }> {
    this.assertInitialized();

    // WARNING: KEYS command is slow and blocks Redis in production
    // For a real production system, maintain counters using INCR/DECR instead
    const keys = await this.client!.keys('entity:*');
    const relKeys = await this.client!.keys('relationship:*');

    const nodesByType: Record<string, number> = {};
    
    if (keys.length > 0) {
      // Use multi for batch fetching
      // Note: If keys.length is very large, this should be chunked
      const chunkSize = 1000;
      for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        const multi = this.client!.multi();
        for (const key of chunk) {
          multi.hGet(key, 'type');
        }
        const types = await multi.exec() as string[];
        for (const type of types) {
          if (type) {
            nodesByType[type] = (nodesByType[type] || 0) + 1;
          }
        }
      }
    }

    return {
      total_nodes: keys.length,
      total_edges: relKeys.length,
      nodes_by_type: nodesByType,
      last_updated: new Date().toISOString(),
    };
  }

  private assertInitialized(): void {
    if (!this.client) {
      throw new Error('KnowledgeGraph not initialized. Call init() first.');
    }
  }

  private entityId(name: string, type: EntityType): string {
    return `${type}:${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  }

  private hydrateEntity(id: string, data: Record<string, string>): Entity {
    return {
      id,
      name: data.name || 'Unknown',
      type: (data.type as EntityType) || 'company',
      confidence: parseFloat(data.confidence || '0'),
      call_count: parseInt(data.call_count || '0', 10),
      properties: this.safeParseJSON(data.properties, {}),
      sources: this.safeParseJSON(data.sources, []),
      first_seen: data.first_seen || new Date().toISOString(),
      last_seen: data.last_seen || new Date().toISOString(),
    };
  }

  private hydrateRelationship(id: string, data: Record<string, string>): Relationship {
    return {
      id,
      from_id: data.from_id || '',
      to_id: data.to_id || '',
      from_name: data.from_name || '',
      to_name: data.to_name || '',
      relation: data.relation || 'related_to',
      confidence: parseFloat(data.confidence || '0'),
      first_seen: data.first_seen || new Date().toISOString(),
      last_seen: data.last_seen || new Date().toISOString(),
    };
  }

  private safeParseJSON<T>(jsonStr: string | undefined, fallback: T): T {
    if (!jsonStr) return fallback;
    try {
      return JSON.parse(jsonStr) as T;
    } catch (e) {
      return fallback;
    }
  }
}

export const knowledgeGraph = new KnowledgeGraph();
