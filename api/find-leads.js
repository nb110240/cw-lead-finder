// OpenAI via direct REST
async function chatComplete(apiKey, system, user) {
  var res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: 'o4-mini',
      messages: [
        { role: 'developer', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    var err = await res.text();
    throw new Error('OpenAI ' + res.status + ': ' + err.slice(0, 200));
  }
  var data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// Apollo
var APOLLO_TIMEOUT = 8000;

async function findContact(domain) {
  var key = process.env.APOLLO_API_KEY;
  if (!key) return null;
  try {
    var r = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      signal: AbortSignal.timeout(APOLLO_TIMEOUT),
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({
        q_organization_domains: domain, page: 1, per_page: 5,
        person_seniorities: ['owner','founder','c_suite','partner','vp','director','manager'],
      }),
    });
    if (!r.ok) return null;
    var d = await r.json();
    var p = (d.people || [])[0];
    if (!p) return null;
    return {
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      title: p.title || null, email: p.email || null, linkedin: p.linkedin_url || null,
    };
  } catch (e) { return null; }
}

async function enrichOrg(domain) {
  var key = process.env.APOLLO_API_KEY;
  if (!key) return null;
  try {
    var r = await fetch(
      'https://api.apollo.io/v1/organizations/enrich?domain=' + encodeURIComponent(domain),
      { headers: { 'X-Api-Key': key }, signal: AbortSignal.timeout(APOLLO_TIMEOUT) }
    );
    if (!r.ok) return null;
    var d = await r.json();
    return d.organization || null;
  } catch (e) { return null; }
}

// SerpAPI — supports both google and google_news engines
async function serpSearch(key, query, engine) {
  engine = engine || 'google';
  var params = new URLSearchParams({ engine: engine, q: query, api_key: key, num: '15' });
  // Google News uses 'gl' and 'hl' instead of 'num' for some params
  try {
    var r = await fetch('https://serpapi.com/search.json?' + params, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.error('[serpapi]', engine, r.status); return []; }
    var d = await r.json();
    // Google News returns news_results, regular Google returns organic_results
    var items = d.organic_results || d.news_results || [];
    return items.map(function(item) {
      return {
        title: item.title || '',
        snippet: item.snippet || item.description || '',
        link: item.link || '',
      };
    });
  } catch (e) { console.error('[serpapi]', engine, e.message); return []; }
}

// Build industry-aware search queries
function buildSearchQueries(industry, location, triggers) {
  var ind = industry.toLowerCase();
  var queries = [];

  // Query 1: Funding + growth (universal)
  queries.push({ q: industry + ' company ' + location + ' funding raised 2025 2026', engine: 'google' });

  // Query 2: Industry-specific trigger patterns
  if (ind.includes('defense') || ind.includes('military') || ind.includes('aerospace')) {
    queries.push({ q: industry + ' ' + location + ' contract awarded expansion 2025 2026', engine: 'google' });
    queries.push({ q: 'defense technology startup ' + location, engine: 'google_news' });
  } else if (ind.includes('biotech') || ind.includes('pharma') || ind.includes('life science')) {
    queries.push({ q: industry + ' ' + location + ' series funding clinical trial 2025 2026', engine: 'google' });
    queries.push({ q: 'biotech startup funding ' + location, engine: 'google_news' });
  } else if (ind.includes('saas') || ind.includes('software') || ind.includes('tech')) {
    queries.push({ q: industry + ' ' + location + ' hiring growing headcount 2025 2026', engine: 'google' });
    queries.push({ q: 'tech startup funding ' + location, engine: 'google_news' });
  } else if (ind.includes('ai') || ind.includes('machine learning') || ind.includes('artificial intelligence')) {
    queries.push({ q: 'AI company ' + location + ' funding raised growing 2025 2026', engine: 'google' });
    queries.push({ q: 'artificial intelligence startup ' + location, engine: 'google_news' });
  } else {
    // Generic fallback for any other industry
    queries.push({ q: industry + ' ' + location + ' expansion hiring growing 2025 2026', engine: 'google' });
    queries.push({ q: industry + ' company ' + location, engine: 'google_news' });
  }

  // Query 3/4: Trigger-specific or broad company list
  if (triggers) {
    queries.push({ q: industry + ' ' + location + ' ' + triggers, engine: 'google' });
  } else {
    queries.push({ q: industry + ' companies ' + location + ' new office lease space expansion', engine: 'google' });
  }

  return queries;
}

// Rate limit
var rateHits = new Map();
function isLimited(ip) {
  var now = Date.now();
  var h = (rateHits.get(ip) || []).filter(function(t) { return now - t < 600000; });
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

  var ip = req.headers['x-forwarded-for'] || 'unknown';
  if (isLimited(ip)) return res.status(429).json({ error: 'Rate limited. Try again in a few minutes.' });

  var openaiKey = process.env.OPENAI_API_KEY;
  var serpKey = process.env.SERPAPI_API_KEY;
  if (!openaiKey || !serpKey) {
    console.error('[find-leads] Missing env:', { openai: !!openaiKey, serp: !!serpKey });
    return res.status(500).json({ error: 'Service unavailable' });
  }

  var b = req.body || {};
  var industry = String(b.industry || '').slice(0, 200).trim();
  var location = String(b.location || 'San Diego, CA').slice(0, 200).trim();
  var companySize = String(b.companySize || 'Any').slice(0, 50).trim();
  var triggers = String(b.triggers || '').slice(0, 500).trim();
  var count = Math.max(1, Math.min(parseInt(b.count) || 8, 12));

  if (!industry) return res.status(400).json({ error: 'Industry is required' });

  try {
    console.log('[find-leads] Start:', industry, location, count);

    // Step 1: Industry-aware multi-query search (all parallel)
    var queries = buildSearchQueries(industry, location, triggers);
    console.log('[find-leads] Running', queries.length, 'searches');

    var searchResults = await Promise.all(
      queries.map(function(q) { return serpSearch(serpKey, q.q, q.engine); })
    );

    // Flatten and deduplicate by URL
    var seen = new Set();
    var results = [];
    for (var i = 0; i < searchResults.length; i++) {
      for (var j = 0; j < searchResults[i].length; j++) {
        var r = searchResults[i][j];
        if (r.link && !seen.has(r.link)) {
          seen.add(r.link);
          results.push(r);
        }
      }
    }
    console.log('[find-leads] Total unique results:', results.length);

    if (!results.length) {
      return res.json({ ok: true, leads: [], market_context: 'No results found. Try broadening your search.', generated_at: new Date().toISOString() });
    }

    // Step 2: Extract companies — smarter prompt
    var txt = results.map(function(r, i) { return '[' + (i+1) + '] ' + r.title + '\n' + r.snippet + '\nURL: ' + r.link; }).join('\n\n');

    var ext = await chatComplete(openaiKey,
      'You are an expert at identifying companies from search results. Return ONLY valid JSON, no markdown fences. Be thorough -- extract every company that could be a real tenant lead.',
      'I need to find ' + industry + ' companies in or near ' + location + ' that show signs of growth, expansion, or space needs. Company size target: ' + companySize + ' employees.\n\nSEARCH RESULTS:\n' + txt + '\n\nReturn: { "companies": [{ "name": "Company Name", "domain": "company.com", "news_snippet": "the specific news/event that makes them relevant -- be detailed", "source_url": "the URL where this was found" }] }\n\nRules:\n- Only include actual ' + industry + ' companies (not news sites, directories, recruiters, or real estate firms)\n- Include the domain WITHOUT https:// prefix\n- If you cannot determine the domain, make your best guess based on the company name (e.g. "Acme Corp" -> "acmecorp.com")\n- Include the specific news snippet that makes them a potential tenant lead (funding, hiring, contract win, expansion, new leadership, etc.)\n- Extract up to ' + Math.min(count + 4, 16) + ' companies to give us a strong pool\n- Deduplicate by company name\n- Prioritize companies with concrete growth signals over general mentions'
    );

    var em = ext.match(/\{[\s\S]*\}/);
    if (!em) { console.error('[find-leads] Extract fail:', ext.slice(0, 300)); return res.status(500).json({ error: 'Failed to extract companies' }); }
    var companies = (JSON.parse(em[0]).companies || []).slice(0, Math.min(count + 4, 16));
    console.log('[find-leads] Companies extracted:', companies.length);
    if (!companies.length) return res.json({ ok: true, leads: [], market_context: 'No matching companies found.', generated_at: new Date().toISOString() });

    // Step 3: Apollo enrichment (all parallel) — enrich more than we need, then trim
    var contactPromises = companies.map(function(c) { return c.domain ? findContact(c.domain) : Promise.resolve(null); });
    var orgPromises = companies.map(function(c) { return c.domain ? enrichOrg(c.domain) : Promise.resolve(null); });
    var enrichResults = await Promise.all([
      Promise.allSettled(contactPromises),
      Promise.allSettled(orgPromises),
    ]);
    var contactArr = enrichResults[0];
    var orgArr = enrichResults[1];
    console.log('[find-leads] Apollo done');

    var enriched = companies.map(function(c, i) {
      var contact = contactArr[i].status === 'fulfilled' ? contactArr[i].value : null;
      var org = orgArr[i].status === 'fulfilled' ? orgArr[i].value : null;
      return {
        name: c.name, domain: c.domain, news_snippet: c.news_snippet, source_url: c.source_url,
        contact: contact,
        org: org ? {
          headcount: org.estimated_num_employees,
          industry: org.industry,
          city: org.city,
          state: org.state,
          founded_year: org.founded_year,
          short_description: (org.short_description || '').slice(0, 200),
        } : null,
      };
    });

    // Step 4: Score — with richer context and ask for final count
    var ctx = enriched.map(function(l, i) {
      var orgLine = l.org
        ? 'Headcount: ' + (l.org.headcount||'unknown') + ' | Industry: ' + (l.org.industry||'unknown') + ' | Founded: ' + (l.org.founded_year||'unknown') + ' | Location: ' + (l.org.city||'unknown') + ', ' + (l.org.state||'') + (l.org.short_description ? '\nAbout: ' + l.org.short_description : '')
        : 'No Apollo data';
      var contactLine = l.contact
        ? 'Contact: ' + l.contact.name + ' -- ' + l.contact.title + ' (' + (l.contact.email||'no email') + ')' + (l.contact.linkedin ? ' | LinkedIn: ' + l.contact.linkedin : '')
        : 'No contact found';
      return '[' + (i+1) + '] ' + l.name + ' (' + l.domain + ')\nNews: ' + l.news_snippet + '\nSource: ' + l.source_url + '\n' + orgLine + '\n' + contactLine;
    }).join('\n\n');

    var scored = await chatComplete(openaiKey,
      'You are a commercial real estate lead scoring system for a tenant representation team. You identify companies that are likely to need office, lab, industrial, or flex space soon. Return ONLY valid JSON, no markdown fences. Use ONLY the data provided -- never invent headcounts, contacts, or facts not present in the data.',
      'Score and rank these ' + industry + ' companies in ' + location + ' for a CRE tenant rep team.\nTarget company size: ' + companySize + '.\nReturn the top ' + count + ' strongest leads.\n\nVERIFIED COMPANY DATA:\n' + ctx + '\n\nFor each of the top ' + count + ' companies return:\n{\n  "company": "name",\n  "domain": "domain.com",\n  "industry": "specific sub-industry",\n  "size": "headcount number from Apollo, or \'unverified\' if not available",\n  "location": "city, state from Apollo data or news",\n  "trigger": "the SPECIFIC news event or signal -- quote details like dollar amounts, dates, names from the source data",\n  "trigger_type": "funding|hiring|expansion|lease|leadership|market_shift",\n  "source_url": "the URL from the source data",\n  "priority": "high|medium|low based on how likely they need space soon",\n  "contact": {"name":"from Apollo","title":"from Apollo","email":"from Apollo or null","linkedin":"from Apollo or null"} or null if no contact data,\n  "outreach_angle": "A natural, specific 1-2 sentence broker outreach message referencing their specific trigger event. Write like a real broker, not a template.",\n  "data_quality": "verified if Apollo returned headcount+industry, partial if some data, unverified if no Apollo data"\n}\n\nAlso return:\n"market_context": "2-3 sentences about the ' + industry + ' market in ' + location + ' based on the patterns you see in the data. Include specific details like funding totals, number of companies growing, or market trends."\n\nReturn: { "leads": [...], "market_context": "..." }\n\nRanking criteria: Companies with larger funding rounds, faster hiring, confirmed expansion plans, or near-term lease expirations should rank highest. Prioritize companies where we have verified contact data.'
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
      sources_used: ['Google Search (SerpAPI)', 'Google News (SerpAPI)', 'Apollo.io (contacts + org data)'],
      generated_at: new Date().toISOString(),
      disclaimer: 'Built by Torrey Labs for C&W. Verify details before outreach.',
    });
  } catch (err) {
    console.error('[find-leads] Error:', err && err.message);
    return res.status(500).json({ error: 'Lead generation failed. Please try again.' });
  }
};
