import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3002;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_REQUESTS || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 25000);

let queue = [];
let running = 0;
let browser;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
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

function isScrapeUrlAllowed(input) {
  const url = typeof input === 'string' ? input : input.url;
  let parsed;
  try { parsed = new URL(url); } catch { return {allowed: false, url, reason: 'Invalid URL'}; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return {allowed: false, url, reason: 'Non-HTTP URL blocked'};
  const host = parsed.hostname;
  if (!host) return {allowed: false, url, reason: 'Missing host'};
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.') || host.endsWith('.local') || host.endsWith('.internal')) return {allowed: false, url, reason: 'Private/internal host blocked'};
  const port = parsed.port;
  if (port && !['80', '443', ''].includes(port)) return {allowed: false, url, reason: 'Non-standard port blocked'};
  return {allowed: true, url};
}

async function scrapeOne(input) {
  const check = isScrapeUrlAllowed(input);
  if (!check.allowed) return {data: {markdown: '', html: '', url: check.url, error: `Scrape blocked: ${check.reason}`}};
  const url = check.url;
  const page = await browser.newPage();
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), NAV_TIMEOUT_MS + 1000);
    const html = await page.content();
    return htmlToMarkdown(html, url);
  } finally {
    try { await page.close(); } catch {}
  }
}

async function enqueueCrawl({ url, maxPages = 10, allowExternal = false }) {
  const base = new URL(url).origin;
  const job = {
    id: crypto.randomUUID(),
    url,
    maxPages,
    allowExternal,
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
  });

  const result = await resultPromise;
  res.json({ success: true, data: { id: result.id, url } });
}

app.get('/health', (req, res) => res.json({ success: true }));

app.post('/v1/scrape', createScrapeHandler);
app.post('/v2/scrape', createScrapeHandler);

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
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
    console.log('Playwright browser ready');
  } catch (err) {
    console.error('Failed to start Playwright browser:', err?.message || err);
    console.error('Run: npx playwright install chromium');
    process.exit(1);
  }
});
