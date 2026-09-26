// Minimal Tavily REST client using Node's built-in fetch (no SDK dependency).
const BASE_URL = 'https://api.tavily.com';

export async function tavilyPost(path, body, { timeoutMs = 30_000 } = {}) {
  if (!process.env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is not set');
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tavily ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
