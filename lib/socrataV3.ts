const DATASET_ID = "qjqv-zrwt";
const V3_BASE_URL = `https://data.ny.gov/api/v3/views/${DATASET_ID}/query.json`;
const SOQL_BASE_URL = `https://data.ny.gov/resource/${DATASET_ID}.json`;

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token =
    process.env.SOCRATA_APP_TOKEN || process.env.NEXT_PUBLIC_SOCRATA_APP_TOKEN || "";
  if (token) {
    headers["X-App-Token"] = token;
  }
  return headers;
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    headers,
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(text || res.statusText), { status: res.status });
  }

  return res.json();
}

export async function socrataQuery<T>(query: string): Promise<T> {
  const headers = buildHeaders();
  const v3Url = `${V3_BASE_URL}?query=${encodeURIComponent(query)}`;

  try {
    return (await fetchJson(v3Url, headers)) as T;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as any).status : 0;
    const hasToken = Boolean(headers["X-App-Token"]);
    if (status && status !== 401 && status !== 403) {
      throw new Error(`Socrata request failed (${status}): ${(error as Error).message}`);
    }

    if (status && (status === 401 || status === 403) && !hasToken) {
      const soqlUrl = `${SOQL_BASE_URL}?$query=${encodeURIComponent(query)}`;
      try {
        return (await fetchJson(soqlUrl, headers)) as T;
      } catch (fallbackError) {
        const fallbackStatus =
          typeof fallbackError === "object" && fallbackError && "status" in fallbackError
            ? (fallbackError as any).status
            : 0;
        throw new Error(
          `Socrata request failed (${status}) without an app token and fallback query failed (${fallbackStatus}): ${(
            fallbackError as Error
          ).message}`,
        );
      }
    }

    throw new Error(`Socrata request failed (${status || "unknown"}): ${(error as Error).message}`);
  }
}

export async function fetchSocrataMetadata<T>(): Promise<T> {
  const headers = buildHeaders();
  const url = `https://data.ny.gov/api/views/${DATASET_ID}.json`;
  return fetchJson(url, headers);
}
