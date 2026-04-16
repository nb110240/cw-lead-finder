// ── OpenAI helper (direct REST to avoid SDK bundling issues) ──

async function chatComplete(
  apiKey: string,
  system: string,
  user: string
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'o4-mini',
      messages: [
        { role: 'developer', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Apollo helpers ──

const APOLLO_TIMEOUT_MS = 8000;

type ApolloContact = {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
};

async function findContactByDomain(domain: string): Promise<ApolloContact | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        q_organization_domains: domain,
        page: 1,
        per_page: 5,
        person_seniorities: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'director', 'manager'],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const people: Record<string, unknown>[] = data.people || [];
    if (people.length === 0) return null;

    const person = people[0];
    return {
      first_name: (person.first_name as string) || null,
      last_name: (person.last_name as string) || null,
      title: (person.title as string) || null,
      email: (person.email as string) || null,
      linkedin_url: (person.linkedin_url as string) || null,
    };
  } catch {
    return null;
  }
}

async function enrichOrganization(domain: string): Promise<Record<string, any> | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      {
        headers: { 'X-Api-Key': apiKey },
        signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.organization || null;
  } catch {
    return null;
  }
}

// ── Rate limiting ──

const rateLimitMap = new Map<string, number[]>();
const RATE_WINDOW_MS = 600_000;
const RATE_LIMIT = 5;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return false;
}

// ── Main handler ──

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
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
    console.error('[find-leads] Missing env vars:', { openai: !!openaiKey, serp: !!serpApiKey });
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

  try {
    // ── Step 1: Two targeted SerpAPI searches in parallel ──
    console.log('[find-leads] Starting:', { industry, location, companySize, count });

    const searches = [
      `${industry} company ${location} funding expansion hiring 2025 2026`,
      triggers
        ? `${industry} ${location} ${triggers}`
        : `${industry} startup ${location} funding raised growing`,
    ];

    const searchResults = await Promise.all(
      searches.map(q => serpApiSearch(serpApiKey, q, 10))
    );

    const seen = new Set<string>();
    const allResults = searchResults.flat().filter(r => {
      if (seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    });

    console.log('[find-leads] Search results:', allResults.length);

    if (allResults.length === 0) {
      return res.json({
        ok: true,
        leads: [],
        market_context: 'No matching results found. Try broadening the industry or location.',
        generated_at: new Date().toISOString(),
      });
    }

    // ── Step 2: Extract company names + domains ──
    const resultsText = allResults
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
      .join('\n\n');

    const extractText = await chatComplete(
      openaiKey,
      'You extract company names and website domains from search results. Return ONLY valid JSON, no markdown fences.',
      `Extract unique ${industry} companies from these search results that are located in or near ${location}. Company size target: ${companySize} employees.

SEARCH RESULTS:
${resultsText}

Return JSON: { "companies": [{ "name": "Company Name", "domain": "company.com", "news_snippet": "the relevant news/context from the search result", "source_url": "the URL where this was found" }] }

Rules:
- Only include companies that are actual ${industry} businesses (not news sites, directories, or recruiters)
- Include the domain WITHOUT https:// prefix
- Include the specific news snippet that makes them relevant
- Max ${Math.min(count, 12)} companies
- Deduplicate by company name`
    );

    const extractMatch = extractText.match(/\{[\s\S]*\}/);
    if (!extractMatch) {
      console.error('[find-leads] Extract failed. Raw:', extractText.slice(0, 500));
      return res.status(500).json({ error: 'Failed to extract companies from search results' });
    }

    const extracted = JSON.parse(extractMatch[0]);
    const companies: Array<{
      name: string;
      domain: string;
      news_snippet: string;
      source_url: string;
    }> = extracted.companies || [];

    console.log('[find-leads] Companies extracted:', companies.length);

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

    console.log('[find-leads] Apollo done');

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

    const scoreText = await chatComplete(
      openaiKey,
      'You are a commercial real estate lead scoring system. Score and format leads for a tenant representation team. Return ONLY valid JSON, no markdown fences. Use ONLY the data provided -- do not invent headcounts, contacts, or facts.',
      `Score these ${industry} companies in ${location} for a CRE tenant rep team. Target company size: ${companySize}.

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

CRITICAL: If Apollo didn't return a headcount, say "unverified" not a made-up number. If no contact was found, set contact to null. Only include facts from the provided data.`
    );

    const scoreMatch = scoreText.match(/\{[\s\S]*\}/);
    if (!scoreMatch) {
      console.error('[find-leads] Score failed. Raw:', scoreText.slice(0, 500));
      return res.status(500).json({ error: 'Failed to score leads' });
    }

    const result = JSON.parse(scoreMatch[0]);
    console.log('[find-leads] Done. Leads:', result.leads?.length || 0);

    return res.json({
      ok: true,
      criteria: { industry, location, companySize, triggers },
      ...result,
      sources_used: ['Google News (SerpAPI)', 'Apollo.io (contacts + org data)'],
      generated_at: new Date().toISOString(),
      disclaimer:
        'Lead data sourced from Google News, Apollo.io, and company websites. Built by Torrey Labs for C&W. Verify details before outreach.',
    });
  } catch (err: any) {
    console.error('[find-leads] Error:', err?.message);
    return res.status(500).json({ error: 'Lead generation failed. Please try again.' });
  }
}

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
    if (!res.ok) {
      console.error('[serpapi] HTTP', res.status);
      return [];
    }
    const data = await res.json();
    return (data.organic_results || []).map((r: any) => ({
      title: r.title || '',
      snippet: r.snippet || '',
      link: r.link || '',
    }));
  } catch (err: any) {
    console.error('[serpapi] Error:', err?.message);
    return [];
  }
}
