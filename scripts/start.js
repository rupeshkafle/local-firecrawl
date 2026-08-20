import { spawn } from 'node:child_process';

function run(cmd, args, name) {
  const proc = spawn(cmd, args, { stdio: 'inherit' });
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
// and will fall back to a scrape-based search path.
const searchPort = process.env.SEARCH_SERVER_PORT || '3003';
const search = run('python3', ['scripts/search_server.py', searchPort], 'search-server');

const server = run('node', ['src/server.js'], 'api-server');

function shutdown() {
  search.kill();
  server.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
