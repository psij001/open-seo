#!/usr/bin/env node
// Build OpenSEO's cached SERP location list from Google's public geotargets
// file, for deployments that reach DataForSEO through treg.
//
// Why: OpenSEO fills its location picker from DataForSEO's
// /v3/serp/google/locations/<country>, which is ~9.5 MB for the US. treg's
// catalog won't relay an answer over 8 MiB, so the cache never fills.
// DataForSEO's location codes and names are Google Ads geotargets, so the
// same list can be built from Google's CSV and written straight to the cache.
//
// Usage:
//   1. Download the newest CSV zip from
//      https://developers.google.com/google-ads/api/data/geotargets and unzip it.
//   2. node scripts/treg-seed-serp-locations.mjs <geotargets.csv> us [ca ...]
//      writes serp-locations-<iso>.json for each country.
//   3. Put each file in the app's KV namespace (binding KV), with no expiry:
//      pnpm wrangler kv key put --remote --namespace-id <id> \
//        serp-locations:us --path serp-locations-us.json
//
// The app keeps a filled key; refresh it from a newer CSV every few months.

import { readFileSync, writeFileSync } from "node:fs";

// Mirrors INCLUDED_LOCATION_TYPES in src/server/lib/dataforseo/serp-locations.ts.
const INCLUDED_LOCATION_TYPES = new Set([
  "City",
  "County",
  "Municipality",
  "DMA Region",
  "Region",
]);

/** One CSV line into fields; geotargets quotes fields that hold commas. */
function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

// Mirrors formatLocationLabel in src/shared/keyword-locations.ts.
function formatLocationLabel(locationName) {
  return locationName
    .split(",")
    .map((part) => part.trim())
    .join(", ");
}

const [csvPath, ...countries] = process.argv.slice(2);
if (!csvPath || countries.length === 0) {
  console.error(
    "usage: node scripts/treg-seed-serp-locations.mjs <geotargets.csv> <iso> [iso ...]",
  );
  process.exit(1);
}

const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
const header = parseCsvLine(lines[0]);
const col = (name) => {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`geotargets CSV has no "${name}" column`);
  return index;
};
const ID = col("Criteria ID");
const CANONICAL = col("Canonical Name");
const COUNTRY = col("Country Code");
const TYPE = col("Target Type");
const STATUS = col("Status");

for (const iso of countries.map((c) => c.toLowerCase())) {
  const rows = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    if (fields[COUNTRY]?.toLowerCase() !== iso) continue;
    if (fields[STATUS] !== "Active") continue;
    if (!INCLUDED_LOCATION_TYPES.has(fields[TYPE])) continue;
    rows.push({
      locationCode: Number(fields[ID]),
      locationName: fields[CANONICAL],
      displayLabel: formatLocationLabel(fields[CANONICAL]),
      locationType: fields[TYPE],
    });
  }
  const out = `serp-locations-${iso}.json`;
  writeFileSync(out, JSON.stringify(rows));
  console.log(`${out}: ${rows.length} locations`);
}
