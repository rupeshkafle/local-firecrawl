import { spawn } from 'node:child_process';

function run(cmd, args, name, extraEnv = {}) {
  const proc = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  proc.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
  });
  proc.on('error', (err) => {
    console.warn(`[${name}] failed to start (continuing without it): ${err.message}`);
  });
  return proc;
}

// Start the Python DDGS-backed search backend. Non-fatal if python3/ddgs
// isn't installed - the Node API server can still serve scrape/crawl/map
// and will fall back to a Wikipedia-based search path if this never comes up.
const searchPort = process.env.SEARCH_SERVER_PORT || '3003';
const search = run('python3', ['scripts/search_server.py', searchPort], 'search-server');

// Point the Node API server at the search backend we just launched, unless
// the user already set SEARCH_BACKEND_URL explicitly (e.g. to point at a
// remote/production search service instead).
const searchBackendUrl = process.env.SEARCH_BACKEND_URL || `http://127.0.0.1:${searchPort}`;
const server = run('node', ['src/server.js'], 'api-server', { SEARCH_BACKEND_URL: searchBackendUrl });

function shutdown() {
  search.kill();
  server.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
