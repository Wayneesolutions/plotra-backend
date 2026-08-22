// scripts/importLeadsFromCsv.js
//
// One-off CSV -> leads importer. Usage:
//   node scripts/importLeadsFromCsv.js <path-to-csv> <tenant-id> [source]
//
// CSV is expected in the "title,phone,emails,website,category,address,
// review_rating,review_count" shape (e.g. Google-Maps-scrape exports) —
// only title/phone/emails are mapped, everything else is dropped since
// the leads table has no columns for it. Rows with no phone are skipped
// (leads.phone is how the rest of the app — WhatsApp matching, WayneRing
// calling — looks a lead up).
const fs = require('fs');
const path = require('path');
const knexConfig = require('../knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { normalizePhone } = require('../src/utils/phone');

// Minimal RFC4180-ish parser: handles quoted fields with embedded commas,
// which this CSV shape needs for its `address` column.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row); }
  return rows;
}

async function main() {
  const [, , csvPath, tenantId, source] = process.argv;
  if (!csvPath || !tenantId) {
    console.error('Usage: node scripts/importLeadsFromCsv.js <path-to-csv> <tenant-id> [source]');
    process.exit(1);
  }

  const tenant = await knex('tenants').where({ id: tenantId }).first();
  if (!tenant) {
    console.error(`No tenant found with id ${tenantId} — leads.tenant_id is a required FK, aborting.`);
    process.exit(1);
  }

  const text = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const [header, ...dataRows] = parseCsv(text);
  const col = (name) => header.indexOf(name);
  const titleIdx = col('title');
  const phoneIdx = col('phone');
  const emailIdx = col('emails');

  const toInsert = [];
  const skipped = [];
  for (const r of dataRows) {
    const name = r[titleIdx]?.trim() || null;
    const rawPhone = r[phoneIdx]?.trim();
    const email = r[emailIdx]?.trim() || null;

    if (!rawPhone) { skipped.push(name || '(unnamed row)'); continue; }

    toInsert.push({
      tenant_id: tenantId,
      name,
      phone: normalizePhone(rawPhone),
      email,
      source: source || 'csv_import',
      status: 'new',
    });
  }

  if (!toInsert.length) {
    console.log('Nothing to insert (no rows with a phone number).');
    process.exit(0);
  }

  // phone isn't unique-constrained on leads, so guard against re-running
  // this script twice against the same tenant by skipping phones that
  // already exist for it.
  const existingPhones = new Set(
    (await knex('leads').where({ tenant_id: tenantId }).whereIn('phone', toInsert.map((l) => l.phone)).select('phone'))
      .map((r) => r.phone)
  );
  const fresh = toInsert.filter((l) => !existingPhones.has(l.phone));
  const dupes = toInsert.filter((l) => existingPhones.has(l.phone));

  if (fresh.length) await knex('leads').insert(fresh);

  console.log(`Inserted ${fresh.length} lead(s).`);
  if (dupes.length) console.log(`Skipped ${dupes.length} already-existing phone(s): ${dupes.map((l) => l.name).join(', ')}`);
  if (skipped.length) console.log(`Skipped ${skipped.length} row(s) with no phone: ${skipped.join(', ')}`);

  await knex.destroy();
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
