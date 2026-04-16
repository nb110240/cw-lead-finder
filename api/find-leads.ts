import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';
import { findContactByDomain, enrichOrganization } from '../lib/apollo';

// Rate limit: in-memory (resets on cold start — fine for a demo)
const rateLimitMap = new Map<string, number[]>();
const RATE_WINDOW_MS = 600_000; // 10 min
const RATE_LIMIT = 5;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return false;
}

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] as string) || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limited. Try again in a few minutes.' });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const serpApiKey = process.env.SERPAPI_API_KEY;
  if (!openaiKey || !serpApiKey) {
    return res.status(500).json({ error: 'Service unavailable' });
  }

  const {
    industry: rawIndustry = '',
    location: rawLocation = 'San Diego, CA',
    companySize: rawSize = 'Any',
    triggers: rawTriggers = '',
    count: rawCount = 8,
  } = req.body || {};

  const industry = String(rawIndustry).slice(0, 200).trim();
  const location = String(rawLocation).slice(0, 200).trim();
  const companySize = String(rawSize).slice(0, 50).trim();
  const triggers = String(rawTriggers).slice(0, 500).trim();
  const count = Math.max(1, Math.min(parseInt(String(rawCount)) || 8, 12));

  if (!industry) {
    return res.status(400).json({ error: 'Industry is required' });
  }

  const openai = new OpenAI({ apiKey: openaiKey });

  try {
    // ── Step 1: Two targeted SerpAPI searches in parallel ──
    const searches = [
      `${industry} company ${location} funding expansion hiring 2025 2026`,
      triggers
        ? `${industry} ${location} ${triggers}`
        : `${industry} startup ${location} funding raised growing`,
    ];

    const searchResults = await Promise.all(
      searches.map(q => serpApiSearch(serpApiKey, q, 10))
    );

    // Deduplicate by URL
    const seen = new Set<string>();
    const allResults = searchResults.flat().filter(r => {
      if (seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    });

    // ── Step 2: Extract company names + domains from search results ──
    const resultsText = allResults
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
      .join('\n\n');

    const extractResp = await openai.chat.completions.create({
      model: 'o4-mini',
      messages: [
        {
          role: 'developer',
          content: 'You extract company names and website domains from search results. Return ONLY valid JSON, no markdown fences.',
        },
        {
          role: 'user',
          content: `Extract unique ${industry} companies from these search results that are located in or near ${location}. Company size target: ${companySize} employees.

SEARCH RESULTS:
${resultsText}

Return JSON: { "companies": [{ "name": "Company Name", "domain": "company.com", "news_snippet": "the relevant news/context from the search result", "source_url": "the URL where this was found" }] }

Rules:
- Only include companies that are actual ${industry} businesses (not news sites, directories, or recruiters)
- Include the domain WITHOUT https:// prefix
- Include the specific news snippet that makes them relevant
- Max ${Math.min(count, 12)} companies
- Deduplicate by company name`,
        },
      ],
    });

    const extractText = extractResp.choices[0]?.message?.content || '';
    const extractMatch = extractText.match(/\{[\s\S]*\}/);
    if (!extractMatch) {
      return res.status(500).json({ error: 'Failed to extract companies from search results' });
    }

    const extracted = JSON.parse(extractMatch[0]);
    const companies: Array<{
      name: string;
      domain: string;
      news_snippet: string;
      source_url: string;
    }> = extracted.companies || [];

    if (companies.length === 0) {
      return res.json({
        ok: true,
        leads: [],
        market_context: 'No matching companies found. Try broadening the industry or location.',
        generated_at: new Date().toISOString(),
      });
    }

    // ── Step 3: Enrich ALL companies in parallel via Apollo ──
    const companySlice = companies.slice(0, Math.min(count, 12));

    const [contactResults, orgResults] = await Promise.all([
      Promise.allSettled(
        companySlice.map(co =>
          co.domain ? findContactByDomain(co.domain) : Promise.resolve(null)
        )
      ),
      Promise.allSettled(
        companySlice.map(co =>
          co.domain ? enrichOrganization(co.domain) : Promise.resolve(null)
        )
      ),
    ]);

    const enrichedLeads = companySlice.map((co, i) => {
      const contact =
        contactResults[i].status === 'fulfilled' ? contactResults[i].value : null;
      const orgData =
        orgResults[i].status === 'fulfilled' ? orgResults[i].value : null;

      return {
        name: co.name,
        domain: co.domain,
        news_snippet: co.news_snippet,
        source_url: co.source_url,
        contact: contact
          ? {
              name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
              title: contact.title,
              email: contact.email,
              linkedin: contact.linkedin_url,
            }
          : null,
        org: orgData
          ? {
              headcount: (orgData as any).estimated_num_employees || null,
              industry: (orgData as any).industry || null,
              city: (orgData as any).city || null,
              state: (orgData as any).state || null,
              founded_year: (orgData as any).founded_year || null,
              linkedin_url: (orgData as any).linkedin_url || null,
            }
          : null,
      };
    });

    // ── Step 4: Score and generate outreach angles ──
    const leadsContext = enrichedLeads
      .map(
        (l, i) =>
          `[${i + 1}] ${l.name} (${l.domain})
News: ${l.news_snippet}
Source: ${l.source_url}
${l.org ? `Headcount: ${l.org.headcount || 'unknown'} | Industry: ${l.org.industry || 'unknown'} | Founded: ${l.org.founded_year || 'unknown'} | Location: ${l.org.city || 'unknown'}, ${l.org.state || ''}` : 'No Apollo data'}
${l.contact ? `Contact: ${l.contact.name} -- ${l.contact.title} (${l.contact.email || 'no email'})` : 'No contact found'}`
      )
      .join('\n\n');

    const scoreResp = await openai.chat.completions.create({
      model: 'o4-mini',
      messages: [
        {
          role: 'developer',
          content: 'You are a commercial real estate lead scoring system. Score and format leads for a tenant representation team. Return ONLY valid JSON, no markdown fences. Use ONLY the data provided -- do not invent headcounts, contacts, or facts.',
        },
        {
          role: 'user',
          content: `Score these ${industry} companies in ${location} for a CRE tenant rep team. Target company size: ${companySize}.

VERIFIED COMPANY DATA:
${leadsContext}

For each company return:
{
  "company": "name",
  "domain": "domain.com",
  "industry": "specific sub-industry",
  "size": "headcount from Apollo data, or 'unverified' if unknown",
  "location": "city, state from Apollo or news",
  "trigger": "the specific news/event that makes them a lead -- quote from the source",
  "trigger_type": "funding|hiring|expansion|lease|leadership|market_shift",
  "source_url": "the URL where the trigger was found",
  "priority": "high|medium|low",
  "contact": { "name": "from Apollo", "title": "from Apollo", "email": "from Apollo or null", "linkedin": "from Apollo or null" },
  "outreach_angle": "1-sentence suggested approach",
  "data_quality": "verified|partial|unverified" -- based on how much Apollo/news data we have
}

Also return: { "market_context": "1-2 sentences about this ICP in this market based on the news results" }

Return: { "leads": [...], "market_context": "..." }

CRITICAL: If Apollo didn't return a headcount, say "unverified" not a made-up number. If no contact was found, set contact to null. Only include facts from the provided data.`,
        },
      ],
    });

    const scoreText = scoreResp.choices[0]?.message?.content || '';
    const scoreMatch = scoreText.match(/\{[\s\S]*\}/);
    if (!scoreMatch) {
      return res.status(500).json({ error: 'Failed to score leads' });
    }

    const result = JSON.parse(scoreMatch[0]);

    return res.json({
      ok: true,
      criteria: { industry, location, companySize, triggers },
      ...result,
      sources_used: [
        'Google News (SerpAPI)',
        'Apollo.io (contacts + org data)',
      ],
      generated_at: new Date().toISOString(),
      disclaimer:
        'Lead data sourced from Google News, Apollo.io, and company websites. Built by Torrey Labs for C&W. Verify details before outreach.',
    });
  } catch (err: any) {
    console.error('[find-leads]', err?.message);
    return res.status(500).json({ error: 'Lead generation failed. Please try again.' });
  }
}

/**
 * Search Google via SerpAPI.
 */
async function serpApiSearch(
  apiKey: string,
  query: string,
  num: number
): Promise<Array<{ title: string; snippet: string; link: string }>> {
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: apiKey,
    num: String(num),
  });

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.organic_results || []).map((r: any) => ({
      title: r.title || '',
      snippet: r.snippet || '',
      link: r.link || '',
    }));
  } catch {
    return [];
  }
}
