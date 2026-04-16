// OpenAI via direct REST
async function chatComplete(apiKey, system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Apollo
const APOLLO_TIMEOUT = 8000;

async function findContact(domain) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      signal: AbortSignal.timeout(APOLLO_TIMEOUT),
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({
        q_organization_domains: domain, page: 1, per_page: 5,
        person_seniorities: ['owner','founder','c_suite','partner','vp','director','manager'],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const p = (d.people || [])[0];
    if (!p) return null;
    return {
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      title: p.title || null, email: p.email || null, linkedin: p.linkedin_url || null,
    };
  } catch (e) { return null; }
}

async function enrichOrg(domain) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { headers: { 'X-Api-Key': key }, signal: AbortSignal.timeout(APOLLO_TIMEOUT) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.organization || null;
  } catch (e) { return null; }
}

// SerpAPI
async function serpSearch(key, query) {
  const params = new URLSearchParams({ engine: 'google', q: query, api_key: key, num: '10' });
  try {
    const r = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.error('[serpapi]', r.status); return []; }
    const d = await r.json();
    return (d.organic_results || []).map(function(r) { return { title: r.title || '', snippet: r.snippet || '', link: r.link || '' }; });
  } catch (e) { console.error('[serpapi]', e.message); return []; }
}

// Rate limit
const rateHits = new Map();
function isLimited(ip) {
  const now = Date.now();
  const h = (rateHits.get(ip) || []).filter(function(t) { return now - t < 600000; });
  if (h.length >= 5) return true;
  h.push(now);
  rateHits.set(ip, h);
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (isLimited(ip)) return res.status(429).json({ error: 'Rate limited. Try again in a few minutes.' });

  const openaiKey = process.env.OPENAI_API_KEY;
  const serpKey = process.env.SERPAPI_API_KEY;
  if (!openaiKey || !serpKey) {
    console.error('[find-leads] Missing env:', { openai: !!openaiKey, serp: !!serpKey });
    return res.status(500).json({ error: 'Service unavailable' });
  }

  const b = req.body || {};
  const industry = String(b.industry || '').slice(0, 200).trim();
  const location = String(b.location || 'San Diego, CA').slice(0, 200).trim();
  const companySize = String(b.companySize || 'Any').slice(0, 50).trim();
  const triggers = String(b.triggers || '').slice(0, 500).trim();
  const count = Math.max(1, Math.min(parseInt(b.count) || 8, 12));

  if (!industry) return res.status(400).json({ error: 'Industry is required' });

  try {
    console.log('[find-leads] Start:', industry, location, count);

    // Step 1: SerpAPI
    var searchResults = await Promise.all([
      serpSearch(serpKey, industry + ' company ' + location + ' funding expansion hiring 2025 2026'),
      serpSearch(serpKey, triggers ? (industry + ' ' + location + ' ' + triggers) : (industry + ' startup ' + location + ' funding raised growing')),
    ]);
    var seen = new Set();
    var results = searchResults[0].concat(searchResults[1]).filter(function(r) {
      if (seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    });
    console.log('[find-leads] Results:', results.length);

    if (!results.length) {
      return res.json({ ok: true, leads: [], market_context: 'No results found. Try broadening your search.', generated_at: new Date().toISOString() });
    }

    // Step 2: Extract companies
    var txt = results.map(function(r, i) { return '[' + (i+1) + '] ' + r.title + '\n' + r.snippet + '\nURL: ' + r.link; }).join('\n\n');

    var ext = await chatComplete(openaiKey,
      'You extract company names and website domains from search results. Return ONLY valid JSON, no markdown fences.',
      'Extract unique ' + industry + ' companies from these search results in or near ' + location + '. Size target: ' + companySize + '.\n\nSEARCH RESULTS:\n' + txt + '\n\nReturn: { "companies": [{ "name": "Name", "domain": "domain.com", "news_snippet": "relevant context", "source_url": "URL" }] }\n\nRules: Only actual ' + industry + ' businesses. Domain without https://. Max ' + count + ' companies. Deduplicate.'
    );

    var em = ext.match(/\{[\s\S]*\}/);
    if (!em) { console.error('[find-leads] Extract fail:', ext.slice(0, 300)); return res.status(500).json({ error: 'Failed to extract companies' }); }
    var companies = (JSON.parse(em[0]).companies || []).slice(0, count);
    console.log('[find-leads] Companies:', companies.length);
    if (!companies.length) return res.json({ ok: true, leads: [], market_context: 'No matching companies found.', generated_at: new Date().toISOString() });

    // Step 3: Apollo (all parallel)
    var contactPromises = companies.map(function(c) { return c.domain ? findContact(c.domain) : Promise.resolve(null); });
    var orgPromises = companies.map(function(c) { return c.domain ? enrichOrg(c.domain) : Promise.resolve(null); });
    var enrichResults = await Promise.all([
      Promise.allSettled(contactPromises),
      Promise.allSettled(orgPromises),
    ]);
    var contacts = enrichResults[0];
    var orgs = enrichResults[1];
    console.log('[find-leads] Apollo done');

    var enriched = companies.map(function(c, i) {
      var contact = contacts[i].status === 'fulfilled' ? contacts[i].value : null;
      var org = orgs[i].status === 'fulfilled' ? orgs[i].value : null;
      return {
        name: c.name, domain: c.domain, news_snippet: c.news_snippet, source_url: c.source_url,
        contact: contact,
        org: org ? { headcount: org.estimated_num_employees, industry: org.industry, city: org.city, state: org.state, founded_year: org.founded_year } : null,
      };
    });

    // Step 4: Score
    var ctx = enriched.map(function(l, i) {
      var orgLine = l.org ? ('Headcount: ' + (l.org.headcount||'unknown') + ' | Industry: ' + (l.org.industry||'unknown') + ' | Location: ' + (l.org.city||'unknown') + ', ' + (l.org.state||'')) : 'No Apollo data';
      var contactLine = l.contact ? ('Contact: ' + l.contact.name + ' -- ' + l.contact.title + ' (' + (l.contact.email||'no email') + ')') : 'No contact';
      return '[' + (i+1) + '] ' + l.name + ' (' + l.domain + ')\nNews: ' + l.news_snippet + '\nSource: ' + l.source_url + '\n' + orgLine + '\n' + contactLine;
    }).join('\n\n');

    var scored = await chatComplete(openaiKey,
      'You are a commercial real estate lead scoring system. Return ONLY valid JSON, no markdown fences. Use ONLY provided data -- never invent facts.',
      'Score these ' + industry + ' companies in ' + location + ' for a CRE tenant rep team. Size: ' + companySize + '.\n\nDATA:\n' + ctx + '\n\nPer company: { "company":"name", "domain":"d.com", "industry":"sub", "size":"from Apollo or unverified", "location":"city, state", "trigger":"specific event from source", "trigger_type":"funding|hiring|expansion|lease|leadership|market_shift", "source_url":"url", "priority":"high|medium|low", "contact":{"name":"","title":"","email":"","linkedin":""} or null, "outreach_angle":"1 sentence", "data_quality":"verified|partial|unverified" }\n\nReturn: { "leads": [...], "market_context": "1-2 sentences" }\n\nCRITICAL: unverified if no Apollo headcount. null contact if none found. Facts only.'
    );

    var sm = scored.match(/\{[\s\S]*\}/);
    if (!sm) { console.error('[find-leads] Score fail:', scored.slice(0, 300)); return res.status(500).json({ error: 'Failed to score leads' }); }
    var result = JSON.parse(sm[0]);
    console.log('[find-leads] Done:', result.leads ? result.leads.length : 0);

    return res.json({
      ok: true,
      criteria: { industry: industry, location: location, companySize: companySize, triggers: triggers },
      leads: result.leads || [],
      market_context: result.market_context || '',
      sources_used: ['Google News (SerpAPI)', 'Apollo.io (contacts + org data)'],
      generated_at: new Date().toISOString(),
      disclaimer: 'Built by Torrey Labs for C&W. Verify details before outreach.',
    });
  } catch (err) {
    console.error('[find-leads] Error:', err && err.message);
    return res.status(500).json({ error: 'Lead generation failed. Please try again.' });
  }
};
