#!/usr/bin/env node
/**
 * RVSpot — Unclaimed Park Import Script
 * scripts/import-parks.js
 *
 * Reads outreach-leads.csv and creates unclaimed park records in Supabase
 * for parks not already registered.
 *
 * Usage:
 *   node scripts/import-parks.js [--csv path/to/file.csv] [--dry-run] [--limit 100]
 *
 * Required env vars (in .dev.vars or shell):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Expected CSV columns (case-insensitive):
 *   name, city, state, phone, website
 *   (additional columns are ignored)
 *
 * Priority order (most popular RV states first):
 *   Florida, Texas, California, Arizona, Colorado,
 *   Tennessee, North Carolina, Oregon
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STATE_PRIORITY = [
  'florida','texas','california','arizona','colorado',
  'tennessee','north carolina','oregon',
];

// Parse CLI args
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const csvFlag  = args.indexOf('--csv');
const limFlag  = args.indexOf('--limit');
const CSV_PATH = csvFlag >= 0 ? args[csvFlag + 1] : path.join(__dirname, '..', 'outreach-leads.csv');
const LIMIT    = limFlag >= 0 ? parseInt(args[limFlag + 1]) || 100 : 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Slugify: "Pineview Lake RV Resort, TX" → "pineview-lake-rv-resort-tx" */
function slugify(name, state) {
  const base = `${name} ${state}`
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return base;
}

/** Normalize state name to lowercase for priority sorting */
function normState(s) { return (s || '').toLowerCase().trim(); }

/** Simple CSV parser (handles quoted fields) */
function parseCSV(raw) {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const rows   = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV split respecting double-quoted fields
    const cells = [];
    let inQuote = false, cell = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { cells.push(cell.trim()); cell = ''; continue; }
      cell += ch;
    }
    cells.push(cell.trim());

    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

/** Supabase REST call with service role key */
async function sbFetch(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey:         SUPABASE_SERVICE_ROLE_KEY,
      Authorization:  `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  RVSpot — Unclaimed Park Import');
  console.log('═══════════════════════════════════════');
  if (DRY_RUN) console.log('  ⚠️  DRY RUN — no data will be written\n');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
    console.error('    Set them in .dev.vars or export before running.');
    process.exit(1);
  }

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`❌  CSV not found: ${CSV_PATH}`);
    console.error(`    Create outreach-leads.csv with columns: name,city,state,phone,website`);
    process.exit(1);
  }

  // ── Read CSV ────────────────────────────────────────────────────────────────
  const raw  = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(raw);
  console.log(`📄  Read ${rows.length} rows from ${CSV_PATH}`);

  if (!rows.length) { console.log('No rows to process.'); return; }

  // ── Sort by state priority ──────────────────────────────────────────────────
  const priorityMap = Object.fromEntries(STATE_PRIORITY.map((s, i) => [s, i]));
  rows.sort((a, b) => {
    const ai = priorityMap[normState(a.state)] ?? 999;
    const bi = priorityMap[normState(b.state)] ?? 999;
    return ai - bi;
  });

  // ── Fetch existing slugs ────────────────────────────────────────────────────
  console.log('🔍  Fetching existing park slugs…');
  const { data: existing } = await sbFetch('GET', '/rest/v1/parks?select=slug&limit=10000', null);
  const existingSlugs = new Set((Array.isArray(existing) ? existing : []).map(p => p.slug));
  console.log(`    Found ${existingSlugs.size} existing parks in DB.\n`);

  // ── Import loop ─────────────────────────────────────────────────────────────
  let imported = 0, skipped = 0, errors = 0;
  const toImport = rows.slice(0, LIMIT);

  for (const row of toImport) {
    const name    = (row.name    || '').trim();
    const city    = (row.city    || '').trim();
    const state   = (row.state   || '').trim();
    const phone   = (row.phone   || '').trim() || null;
    const website = (row.website || '').trim() || null;

    if (!name || !state) {
      console.log(`  ⏭  Skipping row — missing name or state: "${name}", "${state}"`);
      skipped++;
      continue;
    }

    const slug = slugify(name, state);

    if (existingSlugs.has(slug)) {
      console.log(`  ⏭  Skip (exists): ${slug}`);
      skipped++;
      continue;
    }

    const record = {
      name,
      slug,
      city:           city  || null,
      state,
      phone,
      website,
      is_claimed:     false,
      listing_status: 'unclaimed',
      data_source:    'directory',
      is_active:      true,
      plan:           'free',
      // Stripe Connect defaults
      stripe_connect_status: 'not_started',
    };

    if (DRY_RUN) {
      console.log(`  🔵  [DRY RUN] Would insert: ${name} — ${city}, ${state} → slug: ${slug}`);
      imported++;
      existingSlugs.add(slug); // prevent dupe slugs within this run
      continue;
    }

    const { ok, data: result } = await sbFetch('POST', '/rest/v1/parks', record);

    if (ok) {
      console.log(`  ✅  Imported: ${name} — ${city}, ${state}`);
      imported++;
      existingSlugs.add(slug);
    } else {
      console.log(`  ❌  Error inserting "${name}":`, JSON.stringify(result).slice(0, 120));
      errors++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log(`  ✅  Imported : ${imported}`);
  console.log(`  ⏭  Skipped  : ${skipped}`);
  console.log(`  ❌  Errors   : ${errors}`);
  if (DRY_RUN) console.log('  ⚠️  DRY RUN — nothing was written to Supabase.');
  console.log('═══════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
