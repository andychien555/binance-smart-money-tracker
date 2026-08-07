#!/usr/bin/env node
// One-off: rename tape_large_buy/tape_large_sell -> tape_medium_buy/tape_medium_sell
// in every existing R2 day shard.
//
// Why: from the first commit until the fix, collectSymbol computed the two
// "large" split fields from mediumTrades (>= $10k) while tape_large_count
// counted largeTrades (>= $50k). The stored NUMBERS were always a correct
// medium buy/sell split — only the field name was wrong — so renaming recovers
// them losslessly. The true large split cannot be reconstructed (the raw
// aggTrades were never stored), so it simply starts at the deploy.
//
// Usage (run from smart-money-collector/):
//   node scripts/rename-tape-large-to-medium.mjs --dry-run   # report only
//   node scripts/rename-tape-large-to-medium.mjs             # apply
//   node scripts/rename-tape-large-to-medium.mjs BEATUSDT    # limit to symbols
//
// RUN THIS AFTER DEPLOYING THE FIXED WORKER, not before: rows the new worker
// writes already carry tape_medium_buy and are skipped, so nothing collected
// between the migration and the deploy can slip through as un-renamed.
//
// Idempotent — a row that already has tape_medium_buy is left untouched, so
// re-running is safe and cheap (shards with nothing to do are never re-put).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = "smart-money-data";
const ALL_SYMBOLS = [
	"RIVERUSDT",
	"BTCUSDT",
	"ETHUSDT",
	"SOLUSDT",
	"LITUSDT",
	"LABUSDT",
	"BEATUSDT",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const picked = args.filter((a) => !a.startsWith("--"));
const symbols = picked.length ? picked : ALL_SYMBOLS;

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
		{
			encoding: "utf8",
			maxBuffer: 200 * 1024 * 1024,
		},
	);
	if (r.status !== 0) return null; // missing shard/index — caller decides
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
		if (r.status !== 0) throw new Error(`r2 put ${key} failed:\n${r.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Returns the rewritten row, or null when the row needs no change. Key order is
// preserved so the shards stay diff-friendly.
function renameRow(row) {
	// Written by the fixed worker: tape_large_* is genuinely large, and the
	// medium split is already present under its own name.
	if ("tape_medium_buy" in row || "tape_medium_sell" in row) return null;
	if (!("tape_large_buy" in row) && !("tape_large_sell" in row)) return null;

	const out = {};
	for (const [k, v] of Object.entries(row)) {
		if (k === "tape_large_buy") out.tape_medium_buy = v;
		else if (k === "tape_large_sell") out.tape_medium_sell = v;
		else out[k] = v;
	}
	return out;
}

let totalShards = 0;
let changedShards = 0;
let changedRows = 0;
let skippedRows = 0;

for (const sym of symbols) {
	const idxRaw = r2Get(`${sym}/days/index.json`);
	if (!idxRaw) {
		console.log(`\n=== ${sym} === (no days/index.json — skipping)`);
		continue;
	}
	const dates = JSON.parse(idxRaw);
	console.log(`\n=== ${sym} === ${dates.length} day shards`);

	for (const d of dates) {
		const key = `${sym}/days/${d}.ndjson`;
		const raw = r2Get(key);
		if (raw === null) {
			console.warn(`  ${d}: MISSING (listed in index.json but not in R2)`);
			continue;
		}
		totalShards++;

		const lines = raw.split("\n").filter((l) => l.trim());
		let changed = 0;
		const out = lines.map((line) => {
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				console.warn(`  ${d}: unparseable line kept verbatim`);
				return line;
			}
			const renamed = renameRow(row);
			if (!renamed) {
				skippedRows++;
				return line;
			}
			changed++;
			return JSON.stringify(renamed);
		});

		if (!changed) continue;
		changedShards++;
		changedRows += changed;
		console.log(
			`  ${d}: ${changed}/${lines.length} rows renamed${dryRun ? " (dry run)" : ""}`,
		);
		if (!dryRun) {
			r2Put(key, out.join("\n") + "\n", "application/x-ndjson");
		}
	}
}

console.log(
	`\n${dryRun ? "Would rename" : "Renamed"} ${changedRows} rows across ` +
		`${changedShards}/${totalShards} shards. ${skippedRows} rows already correct.`,
);
if (dryRun)
	console.log(
		"Dry run — nothing was written. Re-run without --dry-run to apply.",
	);
