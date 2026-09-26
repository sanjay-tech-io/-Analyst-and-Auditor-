// Web search via Tavily /search. Logged automatically.
import { withLogging } from '../utils/logger.js';
import { tavilyPost } from './tavily.js';

/**
 * @param {string} query
 * @param {{ maxResults?: number, depth?: 'basic' | 'advanced' }} opts
 * @returns {Promise<Array<{ title: string, url: string, content: string, score: number }>>}
 */
async function search(query, { maxResults = 5, depth = 'basic' } = {}) {
  const data = await tavilyPost('/search', { query, max_results: maxResults, search_depth: depth });
  return data.results.map(({ title, url, content, score }) => ({ title, url, content, score }));
}

export const webSearch = withLogging('tool', 'webSearch', search);
