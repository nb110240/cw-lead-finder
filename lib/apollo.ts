const APOLLO_TIMEOUT_MS = 8000;

export type ApolloContact = {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  organization_name: string | null;
};

/**
 * Search Apollo for a senior contact at a company by domain.
 */
export async function findContactByDomain(domain: string): Promise<ApolloContact | null> {
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
      organization_name: ((person.organization as Record<string, unknown>)?.name as string) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Enrich org data (headcount, industry, location) by domain.
 */
export async function enrichOrganization(domain: string): Promise<Record<string, any> | null> {
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
