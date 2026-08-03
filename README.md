# Local Firecrawl

A lightweight, self-hosted Firecrawl-compatible API for scraping, searching, and crawling web pages. Built for environments where the official Firecrawl stack is too heavy or unavailable.

## Why

The official Firecrawl self-hosted setup requires Playwright browser containers, Postgres, Redis, and RabbitMQ. This project replaces that stack with a small Node.js server plus Playwright Chromium, while keeping the same HTTP API shape for scrape, search, and crawl.

## Features

- `/v1/scrape` and `/v2/scrape` — return `markdown`, `html`, and `url`
- `/v1/search` and `/v2/search` — search-backed web results in Firecrawl format
- `/v1/crawl` + `/v1/crawl/:id` — basic queued crawl with polling
- `/health` — liveness check
- Lightweight memory footprint; no database or message queue required
- Works with `firecrawl-py` and Hermes web tools via `FIRECRAWL_API_URL`

## Requirements

- Node.js >= 18
- Playwright Chromium
- ~400MB RAM for browser runtime

## Setup

```bash
git clone https://github.com/rupeshkafle/local-firecrawl.git
cd local-firecrawl
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | Server port |
| `MAX_CONCURRENT_REQUESTS` | `3` | Max parallel scrape requests |
| `REQUEST_TIMEOUT_MS` | `45000` | HTTP request timeout |
| `NAV_TIMEOUT_MS` | `25000` | Browser navigation timeout |

## Usage

### Scrape

```bash
curl -X POST http://localhost:3002/v2/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

### Search

```bash
curl -X POST http://localhost:3002/v2/search \
  -H "Content-Type: application/json" \
  -d '{"query":"python web scraping","limit":5}'
```

### Crawl

```bash
curl -X POST http://localhost:3002/v1/crawl \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","limit":10}'
```

## Hermes Integration

Set these in your Hermes environment:

```
FIRECRAWL_API_URL=http://127.0.0.1:3002
FIRECRAWL_API_KEY=
```

After restarting Hermes, `web_search` and `web_extract` will route through the local server.

## Notes

- Search uses Wikipedia JSON search as the backend; results are mapped to Firecrawl's response shape.
- Crawl jobs are in-memory only and are lost on restart.
- This project prioritizes low-resource operation over full Firecrawl feature parity.

## License

MIT
