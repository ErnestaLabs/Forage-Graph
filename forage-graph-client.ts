/**
 * forage-graph-client.ts
 * 
 * Drop this into the Forage MCP actor (web-intelligence-mcp).
 * Import graphClient, call graphClient.ingest() after every tool response.
 * 
 * Also provides typed wrappers for Forage tools with Scrapling fallback.
 * When FORAGE_API_KEY is absent, routes to local Scrapling bridge on :8001.
 */

import { createHash } from 'crypto';

const GRAPH_API_URL = process.env.GRAPH_API_URL || 'https://forage-graph-production.up.railway.app';
const GRAPH_API_SECRET = process.env.GRAPH_API_SECRET;
const FORAGE_API_KEY = process.env.FORAGE_API_KEY;
const SCRAPLING_URL = process.env.SCRAPLING_URL || 'http://localhost:8001';

// ─── COST TRACKING [cost-001] ─────────────────────────────────────────────────
// Tracks cumulative cost per session, warns at $1 threshold

interface CostTracker {
  total: number;
  warnings: number;
  sessionStart: string;
}

const costTracker: CostTracker = {
  total: 0,
  warnings: 0,
  sessionStart: new Date().toISOString()
};

function trackCost(toolName: string, cost: number): void {
  costTracker.total += cost;
  
  // Warn at $1, then every additional $1
  if (costTracker.total >= 1.0 && costTracker.warnings === 0) {
    console.warn(`[COST] Warning: Session cost has reached $1.00`);
    costTracker.warnings = 1;
  } else if (costTracker.total >= costTracker.warnings + 1.0 && costTracker.warnings > 0) {
    console.warn(`[COST] Warning: Session cost has reached $${Math.floor(costTracker.total)}.00`);
    costTracker.warnings++;
  }
}

export function getCostTracker(): CostTracker {
  return { ...costTracker };
}

// ─── TYPED WRAPPERS FOR FORAGE TOOLS [tool-wrap-001] ─────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  timestamp?: string;
}

export interface PageData {
  url: string;
  title: string;
  content: string;
  textContent?: string;
  error?: string;
}

export interface StructuredData<T> {
  url: string;
  data: T;
  error?: string;
}

/**
 * search_web — Real-time web search
 * Uses Forage API if key present, falls back to Scrapling
 */
export async function searchWeb(query: string, maxResults: number = 10): Promise<SearchResult[]> {
  trackCost('search_web', 0.03);
  
  if (FORAGE_API_KEY) {
    // Use Forage API
    try {
      const response = await fetch('https://api.forage.com/v1/search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FORAGE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, num_results: maxResults })
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.results || [];
      }
    } catch (e) {
      console.error('[search_web] Forage API error:', e);
    }
  }
  
  // Fallback to Scrapling
  try {
    const response = await fetch(`${SCRAPLING_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults })
    });
    
    if (response.ok) {
      const data = await response.json();
      return data.results || [];
    }
  } catch (e) {
    console.error('[search_web] Scrapling fallback error:', e);
  }
  
  return [];
}

/**
 * scrape_page — Extract clean text from URL
 * Uses Scrapling as primary (free), Forage as optional enhancement
 */
export async function scrapePage(url: string, schema?: Record<string, string>): Promise<PageData> {
  trackCost('scrape_page', 0.07);
  
  // Primary: Scrapling (free)
  try {
    const response = await fetch(`${SCRAPLING_URL}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, schema })
    });
    
    if (response.ok) {
      const data = await response.json();
      return {
        url: data.url || url,
        title: data.title || '',
        content: data.content || data.text || '',
        textContent: data.text_content || data.content
      };
    }
  } catch (e) {
    console.error('[scrape_page] Scrapling error:', e);
  }
  
  // Fallback: Forage API if key present
  if (FORAGE_API_KEY) {
    try {
      const response = await fetch('https://api.forage.com/v1/scrape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FORAGE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url, schema })
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          url: data.url || url,
          title: data.title || '',
          content: data.content || data.text || ''
        };
      }
    } catch (e) {
      console.error('[scrape_page] Forage fallback error:', e);
    }
  }
  
  return {
    url,
    title: '',
    content: '',
    error: 'All scraping methods failed'
  };
}

/**
 * extract_structured — Extract structured data from URL per schema
 */
export async function extractStructured<T>(url: string, schema: Record<string, string>): Promise<StructuredData<T>> {
  trackCost('extract_structured', 0.10);
  
  try {
    // Use Scrapling with schema
    const response = await fetch(`${SCRAPLING_URL}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, schema })
    });
    
    if (response.ok) {
      const data = await response.json();
      return { url, data: data.data as T };
    }
  } catch (e) {
    console.error('[extract_structured] error:', e);
  }
  
  return { url, data: {} as T, error: 'Extraction failed' };
}

/**
 * screenshot_page — Capture screenshot of URL
 */
export async function screenshotPage(url: string): Promise<{ url: string; screenshot: string; error?: string }> {
  trackCost('screenshot_page', 0.15);
  
  try {
    const response = await fetch(`${SCRAPLING_URL}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    
    if (response.ok) {
      const data = await response.json();
      return { url, screenshot: data.screenshot || data.base64 || '' };
    }
  } catch (e) {
    console.error('[screenshot_page] error:', e);
  }
  
  return { url, screenshot: '', error: 'Screenshot failed' };
}

// ─── GRAPH INGEST CLIENT [graph-001] ─────────────────────────────────────────
// Fire-and-forget graph ingestion after each tool call

export const graphClient = {
  /**
   * Ingest tool result into graph — fire and forget
   */
  ingest(toolName: string, result: any): void {
    if (!GRAPH_API_URL || !GRAPH_API_SECRET) {
      // Silently skip if no graph configured
      return;
    }

    fetch(`${GRAPH_API_URL}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GRAPH_API_SECRET}`,
      },
      body: JSON.stringify({ 
        tool_name: toolName, 
        result,
        cost: costTracker.total
      }),
    }).catch(() => {}); // Never throws, never adds latency
  },

  /**
   * Ingest perception edge — for cross-cultural perception data
   */
  ingestPerception(
    fromName: string,
    fromType: string,
    toName: string,
    toType: string,
    relation: string,
    attributes: Record<string, any>,
    source: string,
    confidence: number = 0.5
  ): void {
    if (!GRAPH_API_URL || !GRAPH_API_SECRET) return;

    fetch(`${GRAPH_API_URL}/ingest/perception`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GRAPH_API_SECRET}`,
      },
      body: JSON.stringify({
        from_name: fromName,
        from_type: fromType,
        to_name: toName,
        to_type: toType,
        relation,
        attributes,
        source,
        confidence
      }),
    }).catch(() => {});
  }
};

/**
 * ─── WHERE TO ADD THE ONE-LINER IN EACH HANDLER ──────────────────────────────
 *
 * handleSearchWeb      → graphClient.ingest('search_web',       { query, results });
 * handleScrapePage     → graphClient.ingest('scrape_page',      { url, content: text });
 * handleGetCompanyInfo → graphClient.ingest('get_company_info', { domain, website, email_intelligence });
 * handleFindEmails     → graphClient.ingest('find_emails',      { domain, organization, pattern, emails });
 * handleFindLocalLeads → graphClient.ingest('find_local_leads', { keyword, location, leads });
 * handleFindLeads      → graphClient.ingest('find_leads',        { leads: formattedLeads });
 *
 * For perception edges (cultural_analyst, brand_strategist agents):
 *   graphClient.ingestPerception('Russia', 'Nation', 'Italian luxury', 'Brand', 
 *                                 'PERCEIVES', { aspiration: 0.8, trust: 0.3 }, 'gdelt', 0.7);
 *
 * Add AFTER the response object is built, BEFORE the return statement.
 * No await. No try/catch needed. One line per handler.
 */

// ─── HASH FOR ENTITY IDs [id-001] ─────────────────────────────────────────────

export function hashEntity(name: string, type: string): string {
  return createHash('sha256')
    .update(`${name}:${type}`)
    .digest('hex')
    .substring(0, 16);
}