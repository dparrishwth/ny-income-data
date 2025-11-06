const BASE_URL = "https://data.ny.gov/api/v3/views/4skq-w2i6/query.json";

export async function socrataQuery<T>(query: string): Promise<T> {
  const url = `${BASE_URL}?query=${encodeURIComponent(query)}`;
  const headers: Record<string, string> = {};
  const token = process.env.SOCRATA_APP_TOKEN;
  if (token) {
    headers["X-App-Token"] = token;
  }

  const res = await fetch(url, {
    headers,
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Socrata request failed (${res.status} ${res.statusText}): ${text}`);
  }

  return (await res.json()) as T;
}
