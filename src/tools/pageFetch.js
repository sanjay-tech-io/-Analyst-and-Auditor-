// Page text extraction. Tavily /extract first (handles JS-heavy pages, returns clean text);
// if Tavily can't extract it, a direct fetch with HTML stripped. Logged automatically.
import { withLogging } from '../utils/logger.js';
import { tavilyPost } from './tavily.js';

const TIMEOUT_MS = 20_000;

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function viaTavily(url) {
  const data = await tavilyPost('/extract', { urls: [url] }, { timeoutMs: TIMEOUT_MS });
  const page = data.results?.[0];
  if (!page?.raw_content) throw new Error(data.failed_results?.[0]?.error || 'no content extracted');
  return page.raw_content;
}

async function viaDirect(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (analyst-auditor research bot)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/html|text/.test(type)) throw new Error(`unsupported content-type ${type}`);
  const text = htmlToText(await res.text());
  if (!text) throw new Error('empty page');
  return text;
}

/**
 * @param {string} url
 * @returns {Promise<{ url: string, content: string, via: 'tavily' | 'direct' }>}
 * Throws with both failure reasons if neither route works.
 */
async function fetchPage(url) {
  try {
    return { url, content: await viaTavily(url), via: 'tavily' };
  } catch (tavilyErr) {
    try {
      return { url, content: await viaDirect(url), via: 'direct' };
    } catch (directErr) {
      throw new Error(`unreachable: tavily: ${tavilyErr.message}; direct: ${directErr.message}`);
    }
  }
}

export const pageFetch = withLogging('tool', 'pageFetch', fetchPage, {
  // Full page text is large; log length + preview, the caller still gets everything.
  summarize: (r) => ({ url: r.url, via: r.via, length: r.content.length, preview: r.content.slice(0, 300) }),
});
