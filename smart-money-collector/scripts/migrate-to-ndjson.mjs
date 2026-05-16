#!/usr/bin/env node
// One-off: convert each symbol's history_full.json into daily NDJSON shards + index.json.
//
// Usage (run from smart-money-collector/):
//   node scripts/migrate-to-ndjson.mjs
//
// Idempotent before deploying the new worker — safe to re-run while old worker is live
// (it still writes history_full.json). DO NOT re-run after deploying the NDJSON-writing
// worker, because history_full.json becomes stale and would overwrite fresher day shards.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = "smart-money-data";
const SYMBOLS = ["RIVERUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"];

function r2Get(key) {
	const r = spawnSync(
		"npx",
		[
			"wrangler",
			"r2",
			"object",
			"get",
			`${BUCKET}/${key}`,
			"--remote",
			"--pipe",
		],
		{ encoding: "utf8", maxBuffer: 200 * 1024 * 1024 },
	);
	if (r.status !== 0) {
		throw new Error(`r2 get ${key} failed:\n${r.stderr}`);
	}
	return r.stdout;
}

function r2Put(key, body, contentType) {
	const dir = mkdtempSync(join(tmpdir(), "r2put-"));
	const tmpFile = join(dir, "body");
	writeFileSync(tmpFile, body);
	try {
		const r = spawnSync(
			"npx",
			[
				"wrangler",
				"r2",
				"object",
				"put",
				`${BUCKET}/${key}`,
				`--file=${tmpFile}`,
				`--content-type=${contentType}`,
				"--remote",
			],
			{ encoding: "utf8" },
		);
		if (r.status !== 0) {
			throw new Error(`r2 put ${key} failed:\n${r.stderr}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function dateOf(timestamp) {
	// "2026-05-14 22:31" -> "2026-05-14"  (already Taipei time)
	return String(timestamp).slice(0, 10);
}

let totalRows = 0;
let totalDays = 0;

for (const sym of SYMBOLS) {
	console.log(`\n=== ${sym} ===`);
	const raw = r2Get(`${sym}/history_full.json`);
	const rows = JSON.parse(raw);
	if (!Array.isArray(rows)) {
		throw new Error(`${sym}/history_full.json is not an array`);
	}
	console.log(`  rows in history_full.json: ${rows.length}`);

	const byDate = new Map();
	for (const row of rows) {
		const d = dateOf(row.timestamp);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
			console.warn(`  skip row with bad timestamp: ${row.timestamp}`);
			continue;
		}
		if (!byDate.has(d)) byDate.set(d, []);
		byDate.get(d).push(row);
	}

	const dates = [...byDate.keys()].sort();
	for (const d of dates) {
		const dayRows = byDate.get(d);
		// preserve original order within the day
		const body = dayRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
		r2Put(`${sym}/days/${d}.ndjson`, body, "application/x-ndjson");
		console.log(`  wrote days/${d}.ndjson (${dayRows.length} rows)`);
	}

	r2Put(
		`${sym}/days/index.json`,
		JSON.stringify(dates),
		"application/json",
	);
	console.log(`  wrote days/index.json (${dates.length} dates)`);

	totalRows += rows.length;
	totalDays += dates.length;
}

console.log(`\nDone. Migrated ${totalRows} rows across ${totalDays} day-shards.`);
console.log(
	"Old history_full.json objects are kept as fallback — clean up later once new architecture is verified.",
);
