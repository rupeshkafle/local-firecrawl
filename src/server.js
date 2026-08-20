import express from 'express';
import cors from 'cors';
import dns from 'node:dns';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const dnsLookup = dns.promises.lookup;

const SEARCH_BACKEND_URL = (process.env.SEARCH_BACKEND_URL || '').trim();
const PORT = process.env.PORT || 3002;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_REQUESTS || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 25000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const API_KEY = (process.env.API_KEY || '').trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
const DEFAULT_PROXY = (process.env.PROXY_URL || '').trim();
const RESPECT_ROBOTS = process.env.RESPECT_ROBOTS !== 'false';

let queue = [];
let running = 0;
let browser;
let browserLaunching = null;
const fetchCache = new Map();
const robotsCache = new Map();
const webhookSubscriptions = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// Lazily launch (or relaunch) the shared Playwright browser instance.
// Boot no longer crashes the whole process if Chromium isn't installed yet -
// /health and other non-scrape endpoints keep working, and we retry launch
// on the next request that actually needs a page.
async function ensureBrowser() {
  if (browser) return browser;
  if (browserLaunching) return browserLaunching;
  browserLaunching = chromium
    .launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] })
    .then((b) => {
      browser = b;
      browserLaunching = null;
      return b;
    })
    .catch((err) => {
      browserLaunching = null;
      throw err;
    });
  return browserLaunching;
}

function checkApiKey(req, res) {
  if (!API_KEY) return true;
  const authHeader = req.headers['authorization'] || '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  const key = (bearerMatch ? bearerMatch[1].trim() : null) || req.headers['x-api-key'] || req.query?.api_key;
  if (key !== API_KEY) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function checkRobots(url) {
  if (!RESPECT_ROBOTS) return true;
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.origin}/robots.txt`;
    const cached = robotsCache.get(parsed.origin);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.allowed;
    }

    const page = await (await ensureBrowser()).newPage();
    try {
      const res = await page.goto(robotsUrl, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
      if (!res || !res.ok()) {
        robotsCache.set(parsed.origin, { allowed: true, ts: Date.now() });
        return true;
      }
      const text = await page.content();
      const disallowed = text.split('\n').filter(line => line.toLowerCase().startsWith('disallow:'));
      const path = parsed.pathname;
      const blocked = disallowed.some(line => {
        const rule = line.split(':')[1]?.trim();
        if (!rule || rule === '/') return true;
        return path.startsWith(rule);
      });
      robotsCache.set(parsed.origin, { allowed: !blocked, ts: Date.now() });
      return !blocked;
    } finally {
      try { await page.close(); } catch {}
    }
  } catch {
    return true;
  }
}

function extractMetadata(html, url) {
  const $ = cheerio.load(html);
  const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || '';
  const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  const author = $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || '';
  const date = $('meta[name="date"]').attr('content') || $('meta[property="article:published_time"]').attr('content') || '';
  const sitename = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;
  const canonical = $('link[rel="canonical"]').attr('href') || url;
  const images = Array.from($('img[src]')).map(el => $(el).attr('src')).filter(src => src && !src.startsWith('data:')).slice(0, 20);
  const links = Array.from($('a[href]')).map(el => $(el).attr('href')).filter(href => href && !href.startsWith('javascript:')).slice(0, 50);
  return { title, description, author, date, sitename, canonical, images, links };
}

function htmlToMarkdown(html, url) {
  const $ = cheerio.load(html);
  $('script,style,nav,header,footer,iframe,svg').remove();
  const title = $('title').text().trim();
  const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  const markdown = [];
  if (title) markdown.push(`# ${title}`);
  if (description) markdown.push(`\n${description}\n`);
  if (bodyText) markdown.push(`\n${bodyText.slice(0, 12000)}`);

  return { data: { markdown: markdown.join('\n'), html, url } };
}

async function searchOne(query) {
  if (SEARCH_BACKEND_URL) {
    try {
      const base = SEARCH_BACKEND_URL.replace(/\/$/, '');
      const searchUrl = `${base}/v2/search`;
      const res = await fetch(searchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: 10 }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Search backend responded with status ${res.status}: ${text.slice(0, 120)}`);
      }
      const data = await res.json();
      return data;
    } catch (err) {
      console.error('Search backend error:', err?.message || err);
      return { data: { query, web: [] } };
    }
  }

  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('srlimit', '10');
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'LocalFirecrawl/1.0 (https://example.com; mailto:user@example.com)' },
  });
  const data = await res.json();
  const results = (data?.query?.search || []).map((item) => ({
    title: item.title || '',
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title || '')}`,
    description: (item.snippet || '').replace(/<[^>]+>/g, ''),
  }));
  return { data: { query, web: results } };
}

// --- SSRF guard helpers -----------------------------------------------------

function isPrivateIPv4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return true;               // 0.0.0.0/8
  if (a === 127) return true;             // 127.0.0.0/8 loopback
  if (a === 10) return true;              // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (not all of 172.x)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 - link-local + cloud metadata (169.254.169.254)
  return false;
}

function isPrivateIPv6(ip) {
  const lower = String(ip).toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 address, e.g. ::ffff:127.0.0.1
    const mapped = lower.split(':').pop();
    return isPrivateIPv4(mapped);
  }
  return false;
}

// Resolves the hostname and blocks the request if either the literal
// hostname or anything it resolves to (DNS rebinding) is a private,
// loopback, link-local, or cloud-metadata address. Fails closed.
async function isScrapeUrlAllowed(input) {
  const url = typeof input === 'string' ? input : input.url;
  let parsed;
  try { parsed = new URL(url); } catch { return {allowed: false, url, reason: 'Invalid URL'}; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return {allowed: false, url, reason: 'Non-HTTP URL blocked'};
  const host = parsed.hostname;
  if (!host) return {allowed: false, url, reason: 'Missing host'};

  const lowerHost = host.toLowerCase();
  if (
    lowerHost === 'localhost' ||
    lowerHost.endsWith('.local') ||
    lowerHost.endsWith('.internal') ||
    isPrivateIPv4(host) ||
    isPrivateIPv6(host)
  ) {
    return {allowed: false, url, reason: 'Private/internal host blocked'};
  }

  const port = parsed.port;
  if (port && !['80', '443', ''].includes(port)) return {allowed: false, url, reason: 'Non-standard port blocked'};

  try {
    const { address } = await dnsLookup(host);
    if (isPrivateIPv4(address) || isPrivateIPv6(address)) {
      return {allowed: false, url, reason: 'Host resolves to a private/internal address'};
    }
  } catch (err) {
    return {allowed: false, url, reason: 'DNS resolution failed'};
  }

  return {allowed: true, url};
}

async function fetchPage(url, format = 'markdown') {
  const cacheKey = `${url}:${format}`;
  const cached = fetchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  const page = await (await ensureBrowser()).newPage();
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), NAV_TIMEOUT_MS + 1000);
    const html = await page.content();
    const contentType = await page.evaluate(() => document.contentType || '').catch(() => '');

    if (contentType === 'application/pdf' || url.toLowerCase().endsWith('.pdf')) {
      const bytes = await page.evaluate(async () => {
        const res = await fetch(location.href);
        const buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      });

      let text = '';
      let parser;
      try {
        const pdfBuffer = Buffer.from(bytes);
        parser = new PDFParse({ data: pdfBuffer });
        const result = await parser.getText();
        text = (result?.text || '').slice(0, 12000);
      } catch (err) {
        console.error('PDF parse error:', err?.message || err);
        text = '';
      } finally {
        if (parser) {
          try { await parser.destroy(); } catch {}
        }
      }

      const result = {
        success: true,
        url,
        status_code: 200,
        fetch_method: 'playwright-pdf',
        metadata: { title: '', description: '', author: '', date: '', sitename: new URL(url).hostname, canonical: url, images: [], links: [] },
        content: format === 'text' ? text : `# PDF Document\n\n${text}`,
        stats: { content_length: text.length, word_count: text.split(/\s+/).filter(Boolean).length, format },
        is_pdf: true,
      };
      fetchCache.set(cacheKey, { value: result, ts: Date.now() });
      return result;
    }

    const metadata = extractMetadata(html, url);
    const markdown = htmlToMarkdown(html, url).data.markdown;
    const text = cheerio.load(html)('body').text().replace(/\s+/g, ' ').trim();

    let content;
    if (format === 'html') content = html;
    else if (format === 'text') content = text;
    else content = markdown;

    const result = {
      success: true,
      url,
      status_code: 200,
      fetch_method: 'playwright',
      metadata,
      content,
      stats: {
        content_length: content.length,
        word_count: content.split(/\s+/).filter(Boolean).length,
        format,
      },
    };

    fetchCache.set(cacheKey, { value: result, ts: Date.now() });
    return result;
  } finally {
    try { await page.close(); } catch {}
  }
}

async function scrapeOne(input) {
  const check = await isScrapeUrlAllowed(input);
  if (!check.allowed) return {data: {markdown: '', html: '', url: check.url, error: `Scrape blocked: ${check.reason}`}};
  const url = check.url;
  const page = await (await ensureBrowser()).newPage();
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), NAV_TIMEOUT_MS + 1000);
    const html = await page.content();
    return htmlToMarkdown(html, url);
  } finally {
    try { await page.close(); } catch {}
  }
}

async function enqueueCrawl({ url, maxPages = 10, allowExternal = false, webhookUrl }) {
  const base = new URL(url).origin;
  const job = {
    id: crypto.randomUUID(),
    url,
    maxPages,
    allowExternal,
    webhookUrl,
    visited: new Set(),
    queued: new Set([url]),
    results: [],
    status: 'queued',
    errors: [],
  };
  queue.push(job);
  runQueue();
  return { id: job.id };
}

async function processCrawl(job) {
  while (job.queued.size > 0 && job.results.length < job.maxPages) {
    const current = job.queued.values().next().value;
    job.queued.delete(current);
    if (job.visited.has(current)) continue;
    job.visited.add(current);
    try {
      const res = await scrapeOne(current);
      job.results.push(res.data);
      const $ = cheerio.load(res.data.html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        let next;
        try { next = new URL(href, current).href; } catch {}
        if (!next) return;
        if (!job.allowExternal && !next.startsWith(job.url)) return;
        if (job.visited.has(next) || job.queued.has(next)) return;
        job.queued.add(next);
      });
    } catch (err) {
      job.errors.push({ url: current, error: String(err?.message || err) });
    }
  }
  job.status = 'completed';

  if (job.webhookUrl) {
    try {
      await fetch(job.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
        body: JSON.stringify({ job_id: job.id, status: job.status, pages: job.results.length, errors: job.errors.length }),
      });
    } catch {}
  }

  return job;
}

async function runQueue() {
  while (queue.some(j => j.status === 'running' || j.status === 'queued') && running < MAX_CONCURRENT) {
    const job = queue.find(j => j.status === 'queued');
    if (!job) break;
    job.status = 'running';
    running += 1;
    processCrawl(job)
      .catch(() => {})
      .finally(() => {
        running -= 1;
        runQueue();
      });
  }
}

function createScrapeHandler(req, res) {
  const input = req.body?.url || req.body?.sources?.[0]?.url;
  if (!input) return res.status(400).json({ success: false, error: 'url is required' });

  scrapeOne(input)
    .then((result) => {
      res.json({ success: true, data: result.data });
    })
    .catch((err) => {
      res.status(500).json({ success: false, error: String(err?.message || err) });
    });
}

async function createCrawlHandler(req, res) {
  const url = req.body?.url;
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const resultPromise = enqueueCrawl({
    url,
    maxPages: Number(req.body?.limit || req.body?.maxPages || 10),
    allowExternal: Boolean(req.body?.allowExternal),
    webhookUrl: req.body?.webhookUrl,
  });

  const result = await resultPromise;
  res.json({ success: true, data: { id: result.id, url } });
}

app.get('/health', (req, res) => res.json({ success: true }));

app.post('/v1/scrape', (req, res) => {
  if (!checkApiKey(req, res)) return;
  createScrapeHandler(req, res);
});
app.post('/v2/scrape', (req, res) => {
  if (!checkApiKey(req, res)) return;
  createScrapeHandler(req, res);
});

function createSearchHandler(req, res) {
  const query = req.body?.query || req.query?.query;
  if (!query) return res.status(400).json({ success: false, error: 'query is required' });
  searchOne(query).then((result) => res.json({ success: true, data: result.data }));
}

app.post('/v1/search', createSearchHandler);
app.post('/v2/search', createSearchHandler);

app.post('/v1/crawl', createCrawlHandler);
app.get('/v1/crawl/:id', (req, res) => {
  const job = queue.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'job not found' });
  res.json({
    success: true,
    data: {
      id: job.id,
      status: job.status,
      pages: job.results.length,
      maxPages: job.maxPages,
      errors: job.errors,
      data: job.results,
    },
  });
});

app.post('/fetch', async (req, res) => {
  const url = req.body?.url;
  const format = (req.body?.format || 'markdown').toLowerCase();
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const check = await isScrapeUrlAllowed(url);
  if (!check.allowed) return res.status(400).json({ success: false, error: `Scrape blocked: ${check.reason}`, url });

  try {
    const result = await fetchPage(url, format);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: String(err?.message || err), url });
  }
});

app.get('/fetch', async (req, res) => {
  const url = req.query.url;
  const format = (req.query.format || 'markdown').toLowerCase();
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const check = await isScrapeUrlAllowed(url);
  if (!check.allowed) return res.status(400).json({ success: false, error: `Scrape blocked: ${check.reason}`, url });

  fetchPage(url, format)
    .then((result) => res.json(result))
    .catch((err) => res.status(500).json({ success: false, error: String(err?.message || err), url }));
});

app.post('/search-and-fetch', async (req, res) => {
  const query = req.body?.query;
  const numResults = Number(req.body?.num_results || 3);
  const format = (req.body?.format || 'markdown').toLowerCase();
  if (!query) return res.status(400).json({ success: false, error: 'query is required' });

  try {
    const searchResult = await searchOne(query);
    const results = (searchResult.data.web || []).slice(0, numResults);
    const fetched = await Promise.allSettled(results.map((item) => fetchPage(item.url, format)));
    const finalResults = fetched.map((item, idx) => ({
      search_result: results[idx],
      fetch_status: item.status === 'fulfilled' ? 'success' : 'failed',
      fetched_content: item.status === 'fulfilled' ? item.value : null,
      error: item.status === 'rejected' ? String(item.reason?.message || item.reason) : null,
    }));

    res.json({
      success: true,
      query,
      num_results_requested: numResults,
      num_results_found: results.length,
      successful_fetches: finalResults.filter((r) => r.fetch_status === 'success').length,
      failed_fetches: finalResults.filter((r) => r.fetch_status === 'failed').length,
      fetch_options: { format },
      results: finalResults,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.post('/v1/map', async (req, res) => {
  const url = req.body?.url;
  const maxPages = Number(req.body?.limit || req.body?.maxPages || 50);
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const check = await isScrapeUrlAllowed(url);
  if (!check.allowed) return res.status(400).json({ success: false, error: `Scrape blocked: ${check.reason}`, url });

  try {
    const page = await (await ensureBrowser()).newPage();
    const visited = new Set();
    const queued = new Set([url]);
    const links = [];

    try {
      await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), NAV_TIMEOUT_MS + 1000);
      const html = await page.content();
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        let next;
        try { next = new URL(href, url).href; } catch {}
        if (next && next.startsWith(new URL(url).origin)) {
          queued.add(next);
        }
      });
    } finally {
      try { await page.close(); } catch {}
    }

    const results = Array.from(queued).slice(0, maxPages);
    res.json({ success: true, data: { url, links: results, total: results.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.post('/v1/batch-scrape', async (req, res) => {
  const urls = req.body?.urls || req.body?.sources?.map(s => s.url).filter(Boolean) || [];
  if (!urls.length) return res.status(400).json({ success: false, error: 'urls is required' });

  const results = await Promise.allSettled(urls.slice(0, 10).map(u => fetchPage(u, 'markdown')));
  const completed = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  res.json({
    success: true,
    data: {
      total: urls.length,
      completed,
      failed,
      results: results.map((r, idx) => ({
        url: urls[idx],
        status: r.status === 'fulfilled' ? 'completed' : 'failed',
        data: r.status === 'fulfilled' ? r.value : null,
        error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
      })),
    },
  });
});

app.post('/webhooks/subscribe', (req, res) => {
  const event = req.body?.event;
  const url = req.body?.url;
  if (!event || !url) return res.status(400).json({ success: false, error: 'event and url are required' });
  if (!WEBHOOK_SECRET) return res.status(400).json({ success: false, error: 'WEBHOOK_SECRET not configured' });

  const subs = webhookSubscriptions.get(event) || [];
  if (subs.includes(url)) return res.status(200).json({ success: true, message: 'Already subscribed' });
  subs.push(url);
  webhookSubscriptions.set(event, subs);
  res.json({ success: true, message: 'Subscribed', event, url });
});

app.get('/admin/:key/queues', (req, res) => {
  if (req.params.key !== process.env.BULL_AUTH_KEY) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    success: true,
    data: queue.map((job) => ({ id: job.id, status: job.status, pages: job.results.length, errors: job.errors.length })),
  });
});

app.listen(PORT, async () => {
  console.log(`Local Firecrawl compatible API starting on port ${PORT}`);
  try {
    await ensureBrowser();
    console.log('Playwright browser ready');
  } catch (err) {
    console.error('Failed to start Playwright browser at boot (will retry lazily on first scrape request):', err?.message || err);
    console.error('Run: npx playwright install chromium');
  }
});
