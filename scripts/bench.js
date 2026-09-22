#!/usr/bin/env node
/**
 * Load test / benchmark.
 *
 * Usage (from host, stack running via docker compose):
 *   node scripts/bench.js [total_items] [--no-seed]
 *
 * Examples:
 *   node scripts/bench.js 1000
 *   node scripts/bench.js 300000
 *
 * Measures: total time, pages/sec, chunk stats. Worker CPU/RAM can be
 * observed with `docker stats` while the bench runs.
 */

const API = process.env.API_URL || 'http://localhost:3000';
const total = parseInt(process.argv[2] || '10000', 10);
const noSeed = process.argv.includes('--no-seed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`${opts?.method || 'GET'} ${path} -> ${res.status} ${body.error || ''}`);
  }
  return res.json();
}

async function main() {
  console.log(`bench: ${total.toLocaleString()} bulletins against ${API}`);

  if (!noSeed) {
    process.stdout.write('seeding… ');
    let t0 = Date.now();
    await api('/admin/items', { method: 'DELETE' });
    const { inserted } = await api('/admin/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: total }),
    });
    console.log(`${inserted.toLocaleString()} bulletins in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const { id } = await api('/exports', { method: 'POST' });
  console.log(`export created: ${id}`);

  const t0 = Date.now();
  let last = -1;
  let exp;
  for (;;) {
    exp = await api(`/exports/${id}`);
    if (exp.processed !== last) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = elapsed > 0 ? (exp.processed / elapsed).toFixed(0) : '0';
      process.stdout.write(
        `\r${exp.status}  ${exp.processed.toLocaleString()}/${exp.total.toLocaleString()} bulletins` +
        `  ${exp.progress}%  chunks ${exp.completed_chunks}/${exp.total_chunks}` +
        `  ${rate} bulletins/s   `
      );
      last = exp.processed;
    }
    if (exp.status === 'completed') break;
    if (exp.status === 'failed') {
      console.log(`\nFAILED: ${exp.error}`);
      process.exit(1);
    }
    await sleep(1000);
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\n\ndone in ${elapsed.toFixed(1)}s — ${(exp.total / elapsed).toFixed(0)} bulletins/s`);
  console.log(`download: ${API}/exports/${id}/download`);
}

main().catch((err) => {
  console.error('bench failed:', err.message);
  process.exit(1);
});
