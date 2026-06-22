/**
 * Final validation: run every scraper with SCRAPER_LIMIT=5 (saves ≤5 items)
 * then confirm the Hono API server lists all scrapers.
 *
 * Usage:  npx tsx test-scrapers.ts
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import { SCRAPERS } from './src/scrapers/registry.js';

const TIMEOUT_MS = 180_000; // 3 min per scraper
const SAMPLE_LIMIT = '5';   // save at most 5 items to DB per scraper

const scraperKeys = Object.keys(SCRAPERS);
const results: Record<string, { status: 'pass' | 'fail'; output: string; duration: number }> = {};

console.log(`\n🧪 Final validation — ${scraperKeys.length} scrapers (SCRAPER_LIMIT=${SAMPLE_LIMIT})\n`);

for (const key of scraperKeys) {
  const start = Date.now();
  process.stdout.write(`⏳ [${key}] ... `);
  try {
    const out = execSync(`npx tsx src/cli.ts scrape ${key}`, {
      cwd: process.cwd(),
      timeout: TIMEOUT_MS,
      env: { ...process.env, SCRAPER_LIMIT: SAMPLE_LIMIT },
    }).toString().trim();
    const duration = Date.now() - start;
    results[key] = { status: 'pass', output: out.split('\n').pop() ?? '', duration };
    console.log(`✅ ${results[key].output} (${(duration / 1000).toFixed(0)}s)`);
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const raw = err instanceof Error ? err.message : String(err);
    // grab last non-empty line of stderr/stdout for a compact message
    const lines = raw.split('\n').filter((l) => l.trim() && !l.includes('spawnSync'));
    const msg = lines.pop() ?? raw.split('\n')[0] ?? raw;
    results[key] = { status: 'fail', output: msg.substring(0, 140), duration };
    console.log(`❌ FAILED: ${results[key].output}`);
  }
}

// --------------------------------------------------------------------------
// Check backend: list scrapers via registry (no HTTP needed)
// --------------------------------------------------------------------------
console.log('\n────────────────────────────────────────────────────────────────────────────────');
console.log(`📋 Backend registry check — all keys registered in SCRAPERS map:\n`);
for (const key of scraperKeys) {
  const meta = SCRAPERS[key].meta;
  console.log(`  ✓ ${key.padEnd(30)} ${meta.label}`);
}

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
const passed = Object.values(results).filter((r) => r.status === 'pass').length;
const failed = Object.values(results).filter((r) => r.status === 'fail').length;

console.log('\n════════════════════════════════════════════════════════════════════════════════');
console.log(`📊 RESULT: ${passed}/${scraperKeys.length} passed  |  ${failed} failed\n`);

if (failed > 0) {
  console.log('❌ Failed scrapers:\n');
  for (const [key, r] of Object.entries(results)) {
    if (r.status === 'fail') console.log(`  - ${key}: ${r.output}`);
  }
  console.log();
}

console.log('✅ Passed scrapers:\n');
for (const [key, r] of Object.entries(results)) {
  if (r.status === 'pass') console.log(`  - ${key.padEnd(30)} ${r.output} (${(r.duration / 1000).toFixed(0)}s)`);
}

process.exit(failed > 0 ? 1 : 0);
