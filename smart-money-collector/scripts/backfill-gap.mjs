#!/usr/bin/env node
// One-off (per incident): rebuild the day shards for a stretch where collection
// was not running, from the Binance endpoints that serve history.
//
// First used for LAB, which was untracked from 2026-09-07 15:00 to 2026-09-12
// 09:30 (Taipei) and came back with a five-day hole in its shards.
//
// What it can and cannot recover. The smart money fields (sm_*, sm30_*) come
// from bapi/.../smart-money/signal, which answers for *now* only: overview and
// details/stats take no time argument and details/list accepts nothing longer
// than timeRange=1h, so there is no history to ask for. depth_* and tape_* are
// snapshots of the book and the tape at the moment of collection, equally gone.
// Those keys are therefore ABSENT from the rows this writes, not zero-filled —
// and the dashboard's series builder turns a missing key into a whitespace
// point rather than a 0.
//
// What it does write: price / price_change_pct / volume_24h (15m klines),
// oi_usdt / oi_coin (openInterestHist), funding_rate (fundingRate),
// global_ls_ratio / top_pos_ls_ratio, taker_* and the btc_* reference block.
// Each is derived the way the live collector derives it at that minute, down to
// reproducing where the live path reads a stale bucket (see the taker note
// below), so the rebuilt stretch lines up with the series on both sides of it.
//
// Retention: the futures/data endpoints keep 30 days, so a gap has to be
// rebuilt within a month of when it happened.
//
// Usage (run from smart-money-collector/):
//   node scripts/backfill-gap.mjs --symbol LABUSDT \
//     --from "2026-09-07 15:00" --to "2026-09-12 09:30" --dry-run
//   node scripts/backfill-gap.mjs --symbol LABUSDT \
//     --from "2026-09-07 15:00" --to "2026-09-12 09:30"
//
// --from is the first MISSING 15-minute slot and --to the last, both Taipei
// wall clock, both inclusive. Idempotent: a slot already present in a shard is
// left exactly as it was, so re-running cannot overwrite real collected rows.
//
// The one race to know about: appending to today's shard is a read-modify-write
// on the same object the cron is appending to. Run it just after a tick lands,
// and check the shard afterwards.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const F = "https://fapi.binance.com";
const BUCKET = "smart-money-data";
const STEP = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
};
const SYMBOL = flag("--symbol");
const FROM = flag("--from");
const TO = flag("--to");
const DRY = args.includes("--dry-run");

if (!SYMBOL || !FROM || !TO) {
	console.error(
		'usage: node scripts/backfill-gap.mjs --symbol LABUSDT --from "YYYY-MM-DD HH:MM" --to "YYYY-MM-DD HH:MM" [--dry-run]',
	);
	process.exit(1);
}

// Taipei wall clock in, UTC epoch ms out.
function parseTaipei(s) {
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
	if (!m) throw new Error(`bad timestamp: ${s} (want "YYYY-MM-DD HH:MM")`);
	const [, y, mo, d, h, mi] = m.map(Number);
	return Date.UTC(y, mo - 1, d, h, mi) - 8 * HOUR;
}

const GAP_START = parseTaipei(FROM);
const GAP_END = parseTaipei(TO);
if (GAP_START % STEP !== 0 || GAP_END % STEP !== 0) {
	throw new Error("--from and --to must land on 15-minute boundaries");
}

const round = (n, digits) => {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
};

const pad = (n) => String(n).padStart(2, "0");
const tsTaipei = (ms) => {
	const t = new Date(ms + 8 * HOUR);
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

async function get(path, params) {
	const url = new URL(F + path);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const resp = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0" },
		signal: AbortSignal.timeout(20000),
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
	return resp.json();
}

// The futures/data endpoints cap a page at 500 rows, so walk the range forward.
async function paged(path, params, from, to, stepMs) {
	const out = [];
	let cursor = from;
	while (cursor <= to) {
		const end = Math.min(cursor + 499 * stepMs, to);
		const page = await get(path, {
			...params,
			startTime: cursor,
			endTime: end,
			limit: 500,
		});
		out.push(...page);
		if (!page.length) break;
		// When the window holds no complete bucket these endpoints ignore
		// startTime and answer with the newest bucket instead, which would pin
		// the cursor in place and spin forever.
		const next = page[page.length - 1].timestamp + stepMs;
		if (!(next > cursor)) break;
		cursor = next;
	}
	const seen = new Map();
	for (const row of out) seen.set(row.timestamp, row);
	return new Map([...seen.entries()].sort((a, b) => a[0] - b[0]));
}

async function klines(symbol, from, to) {
	const byOpen = new Map();
	let cursor = from;
	while (cursor <= to) {
		const page = await get("/fapi/v1/klines", {
			symbol,
			interval: "15m",
			startTime: cursor,
			endTime: to,
			limit: 1500,
		});
		if (!page.length) break;
		for (const k of page) {
			byOpen.set(k[0], { close: parseFloat(k[4]), quoteVol: parseFloat(k[7]) });
		}
		cursor = page[page.length - 1][0] + STEP;
		if (page.length < 1500) break;
	}
	return byOpen;
}

// What a caller at time `t` would have read from an hourly endpoint whose newest
// bucket sits `lagBuckets` hours behind the hour `t` falls in.
function bucketAt(byTs, t, lagBuckets) {
	const hour = Math.floor(t / HOUR) * HOUR;
	return byTs.get(hour - lagBuckets * HOUR) ?? null;
}

function wrangler(cmdArgs) {
	const r = spawnSync("npx", ["wrangler", ...cmdArgs], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (r.status !== 0) {
		throw new Error(`wrangler ${cmdArgs.join(" ")} failed: ${r.stderr}`);
	}
	return r.stdout;
}

function r2Get(key) {
	const r = spawnSync(
		"npx",
		["wrangler", "r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--pipe"],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	// A missing object is a normal answer here (a day that never existed).
	return r.status === 0 ? r.stdout : null;
}

function r2Put(key, body, contentType, tmp) {
	const file = join(tmp, key.replace(/\//g, "_"));
	writeFileSync(file, body);
	wrangler([
		"r2",
		"object",
		"put",
		`${BUCKET}/${key}`,
		`--file=${file}`,
		`--content-type=${contentType}`,
		"--remote",
	]);
}

async function buildRows() {
	const klineFrom = GAP_START - DAY - STEP;
	const [labK, btcK, oi, fundingRaw, globalLs, topLs, taker] = await Promise.all(
		[
			klines(SYMBOL, klineFrom, GAP_END),
			klines("BTCUSDT", klineFrom, GAP_END),
			paged(
				"/futures/data/openInterestHist",
				{ symbol: SYMBOL, period: "15m" },
				GAP_START,
				GAP_END,
				STEP,
			),
			get("/fapi/v1/fundingRate", {
				symbol: SYMBOL,
				startTime: GAP_START - 2 * DAY,
				endTime: GAP_END,
				limit: 1000,
			}),
			paged(
				"/futures/data/globalLongShortAccountRatio",
				{ symbol: SYMBOL, period: "1h" },
				GAP_START - 2 * HOUR,
				GAP_END,
				HOUR,
			),
			paged(
				"/futures/data/topLongShortPositionRatio",
				{ symbol: SYMBOL, period: "1h" },
				GAP_START - 2 * HOUR,
				GAP_END,
				HOUR,
			),
			paged(
				"/futures/data/takerlongshortRatio",
				{ symbol: SYMBOL, period: "1h" },
				GAP_START - 4 * HOUR,
				GAP_END,
				HOUR,
			),
		],
	);

	const funding = fundingRaw
		.map((f) => ({ t: f.fundingTime, rate: parseFloat(f.fundingRate) }))
		.sort((a, b) => a.t - b.t);

	const rows = [];
	const skipped = [];

	for (let t = GAP_START; t <= GAP_END; t += STEP) {
		// The candle that closes at t, and its counterpart a day earlier.
		const cur = labK.get(t - STEP);
		const prev = labK.get(t - STEP - DAY);
		if (!cur || !prev) {
			skipped.push(tsTaipei(t));
			continue;
		}

		const price = cur.close;
		const pct = ((price - prev.close) / prev.close) * 100;

		// The rolling 24h window /fapi/v1/ticker/24hr reports.
		let vol = 0;
		for (let w = t - DAY; w < t; w += STEP) {
			const k = labK.get(w);
			if (k) vol += k.quoteVol;
		}

		const row = {
			timestamp: tsTaipei(t),
			price,
			price_change_pct: round(pct, 3),
			volume_24h: round(vol / 1e6, 2),
		};

		const oiRow = oi.get(t);
		if (oiRow) {
			const coin = parseFloat(oiRow.sumOpenInterest);
			// Notional as coin x price, the way the live path derives it from
			// /fapi/v1/openInterest — not sumOpenInterestValue, which is marked
			// differently and would step out of line with the rest of the series.
			row.oi_usdt = round((coin * price) / 1e6, 2);
			row.oi_coin = round(coin, 2);
		}

		// The live row carries the last settled rate, held flat until the next.
		let fr = null;
		for (const f of funding) {
			if (f.t <= t) fr = f.rate;
			else break;
		}
		if (fr !== null) row.funding_rate = fr * 100;

		// limit=1 on these two answers with the hour in progress.
		const g = bucketAt(globalLs, t, 0);
		if (g) row.global_ls_ratio = parseFloat(g.longShortRatio);
		const tp = bucketAt(topLs, t, 0);
		if (tp) row.top_pos_ls_ratio = parseFloat(tp.longShortRatio);

		// takerlongshortRatio's newest bucket is the last COMPLETED hour, which is
		// what collectSymbol records since the 2026-09-12 fix. Before that it
		// asked for three buckets and read [0] — the oldest, since these endpoints
		// answer oldest first — so rows written earlier carry the bucket three
		// hours behind the current one. LAB's 09-07..09-12 stretch was rebuilt
		// with that three-hour lag to match the rows around it; rebuilding a gap
		// from before the fix now would need `bucketAt(taker, t, 3)` here again.
		const tk = bucketAt(taker, t, 1);
		if (tk) {
			row.taker_buy_sell_ratio = round(parseFloat(tk.buySellRatio), 4);
			row.taker_buy_vol = round((parseFloat(tk.buyVol) * price) / 1e6, 2);
			row.taker_sell_vol = round((parseFloat(tk.sellVol) * price) / 1e6, 2);
		}

		const btcCur = btcK.get(t - STEP);
		const btcPrev = btcK.get(t - STEP - DAY);
		if (btcCur && btcPrev && SYMBOL !== "BTCUSDT") {
			const btcPct = ((btcCur.close - btcPrev.close) / btcPrev.close) * 100;
			row.btc_price = Math.round(btcCur.close);
			row.btc_24h_pct = round(btcPct, 2);
			row.river_vs_btc = round(pct - btcPct, 2);
		}

		// Marks the row as reconstructed: no sm_*, sm30_*, depth_* or tape_*.
		row.backfilled = true;
		rows.push(row);
	}

	if (skipped.length) {
		console.warn(
			`[WARN] ${skipped.length} slots had no kline and were left empty:`,
			skipped.join(", "),
		);
	}
	return rows;
}

const main = async () => {
	const rows = await buildRows();
	console.log(`built ${rows.length} rows for ${SYMBOL}`);

	const byDate = new Map();
	for (const row of rows) {
		const d = row.timestamp.slice(0, 10);
		if (!byDate.has(d)) byDate.set(d, []);
		byDate.get(d).push(row);
	}

	const tmp = mkdtempSync(join(tmpdir(), "backfill-"));
	try {
		const indexKey = `${SYMBOL}/days/index.json`;
		const indexText = r2Get(indexKey);
		const dates = indexText ? JSON.parse(indexText) : [];
		let added = 0;

		for (const [date, newRows] of byDate) {
			const dayKey = `${SYMBOL}/days/${date}.ndjson`;
			const existingText = r2Get(dayKey) ?? "";
			const existing = existingText
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
			const have = new Set(existing.map((r) => r.timestamp));
			const fresh = newRows.filter((r) => !have.has(r.timestamp));
			if (!fresh.length) {
				console.log(`${date}: nothing to add (${existing.length} rows already)`);
				continue;
			}
			const merged = [...existing, ...fresh].sort((a, b) =>
				a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
			);
			added += fresh.length;
			console.log(
				`${date}: +${fresh.length} rows (${existing.length} kept) -> ${merged.length}`,
			);
			if (DRY) continue;
			r2Put(
				dayKey,
				merged.map((r) => JSON.stringify(r)).join("\n") + "\n",
				"application/x-ndjson",
				tmp,
			);
			if (!dates.includes(date)) dates.push(date);
		}

		if (DRY) {
			console.log(`dry run: ${added} rows would be written`);
			return;
		}
		dates.sort();
		r2Put(indexKey, JSON.stringify(dates), "application/json", tmp);
		console.log(`wrote ${added} rows; index now lists ${dates.length} days`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
