import {
	type AlertSample,
	WINDOW as ALERT_WINDOW,
	backfill,
	detect,
	formatMessage,
	loadState,
	saveState,
	sendTelegram,
} from "./alerts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36";

type SymbolMeta = {
	symbol: string;
	short: string;
	label: string;
	// Still collected and still served under /data/<short>/…, just left out of
	// the dashboards' symbol bar. Single source of truth for symbol visibility —
	// it rides along in symbols.json so both pages agree from one edit.
	hidden?: boolean;
	onchain?: { chain: string; addr: string };
};

// The only two fields of the BTCUSDT 24hr ticker that a symbol row consumes.
// Fetched once per collection and handed to each batch (see runCollection).
type BtcRef = { lastPrice: string; priceChangePercent: string };

const SYMBOLS_META: SymbolMeta[] = [
	{
		symbol: "RIVERUSDT",
		short: "river",
		label: "RIVER/USDT",
		onchain: {
			chain: "56",
			addr: "0xda7ad9dea9397cffddae2f8a052b82f1484252b3",
		},
	},
	{ symbol: "BTCUSDT", short: "btc", label: "BTC/USDT" },
	{ symbol: "ETHUSDT", short: "eth", label: "ETH/USDT" },
	{ symbol: "SOLUSDT", short: "sol", label: "SOL/USDT" },
	{ symbol: "LITUSDT", short: "lit", label: "LIT/USDT" },
	{ symbol: "LABUSDT", short: "lab", label: "LAB/USDT" },
	{ symbol: "BEATUSDT", short: "beat", label: "BEAT/USDT" },
	{ symbol: "ZECUSDT", short: "zec", label: "ZEC/USDT" },
];

// Cloudflare Workers (Free) caps each invocation at 50 fetch() subrequests AND
// at 10ms CPU. Each symbol costs ~10-11 subrequests, so all symbols in one
// invocation blows the subrequest limit (the tail-end depth/aggTrades fetches
// start failing). Instead the cron fans out into batches, each run as its OWN
// sub-invocation (via a self fetch to /collect?batch=N) so each gets a fresh
// budget of both.
//
// CPU is the binding constraint, not subrequests. Measured: ~3.75ms fixed
// overhead + ~3.25ms per symbol, so 3 symbols/batch lands at ~13.5ms — over the
// 10ms cap. That ran for months on the isolate's tolerance for *occasional*
// overruns, until 2026-08-30 15:15 when Cloudflare started enforcing it and
// every /collect came back exceededCpu (the orchestrator saw HTTP 503 from the
// service binding). One symbol per sub-invocation puts it at ~7ms, inside the
// cap with room for the day shard to grow. Raising this is what broke it.
const SELF_ORIGIN = "https://smart-money-collector.andychien-design.workers.dev";
const BATCH_SIZE = 1; // symbols per sub-invocation (~11 subrequests, ~7ms CPU)

function getBatches(): SymbolMeta[][] {
	const batches: SymbolMeta[][] = [];
	for (let i = 0; i < SYMBOLS_META.length; i += BATCH_SIZE) {
		batches.push(SYMBOLS_META.slice(i, i + BATCH_SIZE));
	}
	return batches;
}

type Env = {
	DATA: R2Bucket;
	PROXY_BASE: string;
	PROXY_TOKEN: string;
	SELF: Fetcher; // self service-binding for batch fan-out (see runCollection)
	// Optional: without both, alerts are still detected and logged to
	// /data/alerts.json, just not pushed anywhere.
	TG_BOT_TOKEN?: string;
	TG_CHAT_ID?: string;
};

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, HEAD, OPTIONS",
};

const NDJSON_CONTENT_TYPE = "application/x-ndjson";

function proxyUrl(env: Env, originalUrl: string): string {
	return originalUrl
		.replace("https://fapi.binance.com", `${env.PROXY_BASE}/host-fapi`)
		.replace("https://www.binance.com", `${env.PROXY_BASE}/host-www`)
		.replace("https://web3.binance.com", `${env.PROXY_BASE}/host-web3`);
}

async function fetchJson<T = any>(
	env: Env,
	url: string,
	headers?: Record<string, string>,
): Promise<T> {
	const resp = await fetch(proxyUrl(env, url), {
		headers: {
			"User-Agent": UA,
			"X-Proxy-Token": env.PROXY_TOKEN,
			...(headers ?? {}),
		},
	});
	if (!resp.ok) {
		throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
	}
	return (await resp.json()) as T;
}

async function fetchSafe<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T | null> {
	try {
		return await fn();
	} catch (e) {
		console.warn(`[WARN] ${label} failed:`, e);
		return null;
	}
}

function round(n: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

function tsTaipei(now: Date): string {
	const t = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

function dateTaipei(now: Date): string {
	const t = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

async function appendDayShard(
	env: Env,
	symbol: string,
	row: Record<string, any>,
): Promise<void> {
	const date = dateTaipei(new Date());
	const dayKey = `${symbol}/days/${date}.ndjson`;
	const indexKey = `${symbol}/days/index.json`;

	const [existing, indexObj] = await Promise.all([
		env.DATA.get(dayKey),
		env.DATA.get(indexKey),
	]);

	const oldText = existing ? await existing.text() : "";
	const newText = oldText + JSON.stringify(row) + "\n";

	let dates: string[] = [];
	if (indexObj) {
		try {
			const parsed = await indexObj.json<any>();
			if (Array.isArray(parsed)) dates = parsed;
		} catch {}
	}

	const writes: Promise<any>[] = [
		env.DATA.put(dayKey, newText, {
			httpMetadata: { contentType: NDJSON_CONTENT_TYPE },
		}),
	];

	if (!dates.includes(date)) {
		dates.push(date);
		dates.sort();
		writes.push(
			env.DATA.put(indexKey, JSON.stringify(dates), {
				httpMetadata: { contentType: "application/json" },
			}),
		);
	}

	await Promise.all(writes);
}

async function collectSymbol(
	meta: SymbolMeta,
	env: Env,
	btcTicker: any | null,
): Promise<{ row: Record<string, any> }> {
	const { symbol } = meta;
	const ts = tsTaipei(new Date());

	const baseSm =
		"https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal";
	const smHeaders = {
		clienttype: "web",
		referer: `https://www.binance.com/zh-TC/smart-money/signal/${symbol}`,
	};
	const baseF = "https://fapi.binance.com";

	const [
		overviewRaw,
		statsRaw,
		ticker,
		oi,
		fundingArr,
		globalLsArr,
		topLsPosArr,
	] = await Promise.all([
		fetchJson<any>(env, `${baseSm}/overview?symbol=${symbol}`, smHeaders),
		fetchJson<any>(
			env,
			`${baseSm}/details/stats?symbol=${symbol}&timeRange=30m`,
			smHeaders,
		),
		fetchJson<any>(env, `${baseF}/fapi/v1/ticker/24hr?symbol=${symbol}`),
		fetchJson<any>(env, `${baseF}/fapi/v1/openInterest?symbol=${symbol}`),
		fetchJson<any[]>(
			env,
			`${baseF}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`,
		),
		fetchJson<any[]>(
			env,
			`${baseF}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`,
		),
		fetchJson<any[]>(
			env,
			`${baseF}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`,
		),
	]);

	const overview = overviewRaw.data;
	const stats = statsRaw.data;
	const funding = fundingArr[0];
	const globalLs = globalLsArr[0];
	const topLsPos = topLsPosArr[0];
	const price = parseFloat(ticker.lastPrice);

	const [takerData, depthData, aggTrades, web3Dynamic] = await Promise.all([
		fetchSafe("taker-ratio", () =>
			fetchJson<any[]>(
				env,
				`${baseF}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=3`,
			),
		),
		fetchSafe("depth", () =>
			fetchJson<any>(env, `${baseF}/fapi/v1/depth?symbol=${symbol}&limit=20`),
		),
		fetchSafe("aggTrades", () =>
			fetchJson<any[]>(
				env,
				`${baseF}/fapi/v1/aggTrades?symbol=${symbol}&limit=200`,
			),
		),
		meta.onchain
			? fetchSafe("web3-dynamic", () =>
					fetchJson<any>(
						env,
						`https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info?chainId=${meta.onchain!.chain}&contractAddress=${meta.onchain!.addr}`,
						{ "Accept-Encoding": "identity" },
					),
				)
			: Promise.resolve(null),
	]);

	let takerInfo: Record<string, number> = {};
	if (takerData && takerData.length > 0) {
		const lt = takerData[0];
		takerInfo = {
			taker_buy_sell_ratio: round(parseFloat(lt.buySellRatio), 4),
			taker_buy_vol: round((parseFloat(lt.buyVol) * price) / 1e6, 2),
			taker_sell_vol: round((parseFloat(lt.sellVol) * price) / 1e6, 2),
		};
	}

	let depthInfo: Record<string, number> = {};
	if (depthData) {
		const bids: [number, number][] = depthData.bids.map(
			(b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])],
		);
		const asks: [number, number][] = depthData.asks.map(
			(a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])],
		);
		const bidTotal = bids.reduce((s, [, q]) => s + q * price, 0);
		const askTotal = asks.reduce((s, [, q]) => s + q * price, 0);
		const biggestBid: [number, number] = bids.length
			? bids.reduce((m, x) => (x[1] > m[1] ? x : m))
			: [0, 0];
		const biggestAsk: [number, number] = asks.length
			? asks.reduce((m, x) => (x[1] > m[1] ? x : m))
			: [0, 0];
		depthInfo = {
			depth_bid_total_k: round(bidTotal / 1e3, 1),
			depth_ask_total_k: round(askTotal / 1e3, 1),
			depth_bid_wall_price: round(biggestBid[0], 6),
			depth_bid_wall_qty: Math.round(biggestBid[1]),
			depth_ask_wall_price: round(biggestAsk[0], 6),
			depth_ask_wall_qty: Math.round(biggestAsk[1]),
			depth_ratio: round(bidTotal / Math.max(askTotal, 1), 2),
		};
	}

	let tradeInfo: Record<string, number> = {};
	if (aggTrades) {
		const largeThreshold = 50000 / Math.max(price, 0.001);
		const mediumThreshold = 10000 / Math.max(price, 0.001);
		const largeTrades = aggTrades.filter(
			(t: any) => parseFloat(t.q) >= largeThreshold,
		);
		const mediumTrades = aggTrades.filter(
			(t: any) => parseFloat(t.q) >= mediumThreshold,
		);
		const buyVol = aggTrades
			.filter((t: any) => !t.m)
			.reduce((s: number, t: any) => s + parseFloat(t.q) * price, 0);
		const sellVol = aggTrades
			.filter((t: any) => t.m)
			.reduce((s: number, t: any) => s + parseFloat(t.q) * price, 0);
		tradeInfo = {
			tape_large_count: largeTrades.length,
			tape_medium_count: mediumTrades.length,
			tape_large_buy: largeTrades.filter((t: any) => !t.m).length,
			tape_large_sell: largeTrades.filter((t: any) => t.m).length,
			tape_medium_buy: mediumTrades.filter((t: any) => !t.m).length,
			tape_medium_sell: mediumTrades.filter((t: any) => t.m).length,
			tape_aggr_buy_k: round(buyVol / 1e3, 1),
			tape_aggr_sell_k: round(sellVol / 1e3, 1),
		};
	}

	let btcInfo: Record<string, number> = {};
	if (symbol !== "BTCUSDT" && btcTicker) {
		const btcPct = parseFloat(btcTicker.priceChangePercent);
		const symPct = parseFloat(ticker.priceChangePercent);
		btcInfo = {
			btc_price: Math.round(parseFloat(btcTicker.lastPrice)),
			btc_24h_pct: round(btcPct, 2),
			river_vs_btc: round(symPct - btcPct, 2),
		};
	}

	let onchain: Record<string, number> = {};
	if (web3Dynamic && web3Dynamic.success) {
		const d = web3Dynamic.data;
		onchain = {
			onchain_holders: parseInt(d.holders ?? "0", 10) || 0,
			onchain_top10_pct: round(parseFloat(d.top10HoldersPercentage ?? "0"), 2),
			onchain_kol_holders: parseInt(d.kolHolders ?? "0", 10) || 0,
			onchain_sm_holders: parseInt(d.smartMoneyHolders ?? "0", 10) || 0,
			onchain_liquidity: round(parseFloat(d.liquidity ?? "0") / 1e6, 2),
		};
	}

	const row: Record<string, any> = {
		timestamp: ts,
		price,
		price_change_pct: parseFloat(ticker.priceChangePercent),
		volume_24h: round(parseFloat(ticker.quoteVolume) / 1e6, 2),
		oi_usdt: round((parseFloat(oi.openInterest) * price) / 1e6, 2),
		oi_coin: round(parseFloat(oi.openInterest), 2),
		funding_rate: parseFloat(funding.fundingRate) * 100,
		sm_total_traders: overview.totalTraders,
		sm_long_traders: overview.longTraders,
		sm_short_traders: overview.shortTraders,
		sm_long_whales: overview.longWhales ?? 0,
		sm_short_whales: overview.shortWhales ?? 0,
		sm_long_pos_usdt: round((overview.longTradersQty * price) / 1e6, 2),
		sm_short_pos_usdt: round((overview.shortTradersQty * price) / 1e6, 2),
		sm_ls_ratio: overview.longShortRatio,
		sm_long_avg_price: round(overview.longTradersAvgEntryPrice, 4),
		sm_short_avg_price: round(overview.shortTradersAvgEntryPrice, 4),
		sm_long_profit_pct: round(
			(overview.longProfitTraders / Math.max(overview.longTraders, 1)) * 100,
			1,
		),
		sm_short_profit_pct: round(
			(overview.shortProfitTraders / Math.max(overview.shortTraders, 1)) * 100,
			1,
		),
		sm30_long_traders: stats.longTraders,
		sm30_short_traders: stats.shortTraders,
		sm30_long_whales: stats.longWhales,
		sm30_short_whales: stats.shortWhales,
		sm30_long_pos_usdt: round(stats.longPositions / 1e3, 1),
		sm30_short_pos_usdt: round(stats.shortPositions / 1e3, 1),
		global_ls_ratio: parseFloat(globalLs.longShortRatio),
		top_pos_ls_ratio: parseFloat(topLsPos.longShortRatio),
		...onchain,
		...takerInfo,
		...depthInfo,
		...tradeInfo,
		...btcInfo,
	};

	const prevKey = `${symbol}/prev_row.json`;
	const jsonOpts = { httpMetadata: { contentType: "application/json" } };

	await Promise.all([
		env.DATA.put(prevKey, JSON.stringify(row), jsonOpts),
		appendDayShard(env, symbol, row),
	]);

	console.log(`[OK] ${symbol} $${price} @ ${ts}`);
	return { row };
}

type SummaryEntry = {
	symbol: string;
	label: string;
	price: number | null;
	change_pct: number | null;
	sm_ls_ratio?: any;
	// True when there is something displayable: this cycle's numbers, or the
	// previous cycle's carried forward (see carryForwardFailures). Only a symbol
	// that has never collected successfully is false.
	has_data: boolean;
	// Set when this cycle failed and the numbers above came from the last one.
	stale?: boolean;
	hidden?: boolean;
	last_ts?: string;
	error?: string;
};

function fetchBtcRef(env: Env): Promise<BtcRef | null> {
	return fetchSafe("btc-ref", () =>
		fetchJson<BtcRef>(
			env,
			"https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT",
		),
	);
}

type BatchResult = {
	summary: SummaryEntry[];
	// Only the symbols that collected successfully — see AlertSample.
	samples: AlertSample[];
};

// Collect one batch of symbols within a single invocation (its own subrequest
// budget). Writes each symbol's day shard + prev_row; returns the summary rows.
// Does NOT write symbols.json — the orchestrator merges all batches first.
async function collectGroup(
	env: Env,
	metas: SymbolMeta[],
	btcRef?: BtcRef,
): Promise<BatchResult> {
	// The orchestrator fetches this once and passes it to every batch; fetch it
	// here only on a direct /collect call, or if the orchestrator's own failed.
	const btcTicker = btcRef ?? (await fetchBtcRef(env));

	const results = await Promise.allSettled(
		metas.map((m) => collectSymbol(m, env, btcTicker)),
	);

	const samples: AlertSample[] = [];
	const summary = metas.map((meta, i): SummaryEntry => {
		const r = results[i];
		if (r.status === "fulfilled") {
			const { row } = r.value;
			const sample = toAlertSample(meta, row);
			if (sample) samples.push(sample);
			return {
				symbol: meta.short,
				label: meta.label,
				price: row.price,
				change_pct: row.price_change_pct,
				sm_ls_ratio: row.sm_ls_ratio,
				has_data: true,
				hidden: meta.hidden,
				last_ts: row.timestamp,
			};
		}
		console.error(`[ERROR] ${meta.symbol}:`, r.reason);
		return {
			symbol: meta.short,
			label: meta.label,
			price: null,
			change_pct: null,
			has_data: false,
			hidden: meta.hidden,
			error: String(r.reason),
		};
	});

	return { summary, samples };
}

// A row missing any of the four numbers the detector tracks is dropped rather
// than defaulted: a zero would land in the rolling window as a real datapoint
// and both distort the sigma and fire a bogus alert on the way back up.
function toAlertSample(
	meta: SymbolMeta,
	row: Record<string, any>,
): AlertSample | null {
	const nums = {
		price: Number(row.price),
		price_change_pct: Number(row.price_change_pct),
		sm_ls_ratio: Number(row.sm_ls_ratio),
		sm_long_pos_usdt: Number(row.sm_long_pos_usdt),
		sm_short_pos_usdt: Number(row.sm_short_pos_usdt),
	};
	if (Object.values(nums).some((n) => !Number.isFinite(n))) {
		console.warn(`[WARN] ${meta.symbol}: incomplete row, skipped for alerts`);
		return null;
	}
	return { short: meta.short, label: meta.label, ...nums };
}

// Orchestrator (cron + /run): fan each batch out to its own sub-invocation via a
// self fetch to /collect, so every batch gets a fresh 50-subrequest budget. Then
// merge the returned summaries and write symbols.json once. This invocation only
// spends one subrequest per batch.
async function runCollection(env: Env) {
	const batches = getBatches();

	// Every row carries the same BTC reference, so fetch it once here instead of
	// once per batch. On failure the params are omitted and each batch falls
	// back to fetching it itself.
	const btcRef = await fetchBtcRef(env);
	const btcQuery = btcRef
		? `&btc_price=${encodeURIComponent(btcRef.lastPrice)}` +
			`&btc_pct=${encodeURIComponent(btcRef.priceChangePercent)}`
		: "";

	const perBatch = await Promise.all(
		batches.map(async (group, i): Promise<BatchResult> => {
			try {
				const resp = await env.SELF.fetch(
					`${SELF_ORIGIN}/collect?batch=${i}${btcQuery}`,
				);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				return (await resp.json()) as BatchResult;
			} catch (e) {
				console.error(`[ERROR] batch ${i} fetch failed:`, e);
				return {
					summary: group.map(
						(meta): SummaryEntry => ({
							symbol: meta.short,
							label: meta.label,
							price: null,
							change_pct: null,
							has_data: false,
							hidden: meta.hidden,
							error: String(e),
						}),
					),
					samples: [],
				};
			}
		}),
	);

	const summary = perBatch.flatMap((b) => b.summary);
	const merged = await carryForwardFailures(env, summary);

	await env.DATA.put("symbols.json", JSON.stringify(merged), {
		httpMetadata: { contentType: "application/json" },
	});
	await env.DATA.put(
		"meta.json",
		JSON.stringify({ updated_at: new Date().toISOString() }),
		{ httpMetadata: { contentType: "application/json" } },
	);

	const alerts = await runAlertPass(
		env,
		perBatch.flatMap((b) => b.samples),
	);

	const ok = summary.filter((s) => s.has_data).length;
	const stale = merged.filter((s) => s.stale).length;
	console.log(
		`Done: ${ok}/${summary.length} symbols collected ` +
			`(${batches.length} batches)` +
			(stale ? `, ${stale} carried forward from the previous cycle` : ""),
	);
	return { ok, stale, total: summary.length, alerts, summary: merged };
}

// Detection runs in its own sub-invocation (POST /alerts) for a fresh 10ms CPU
// budget — the same reason collection fans out into batches. Any failure in
// here is logged and swallowed: a broken alert pass must never cost us a
// collection cycle, whose data is the thing that cannot be recreated later.
async function runAlertPass(
	env: Env,
	samples: AlertSample[],
): Promise<AlertPassResult> {
	if (!samples.length) return { fired: 0 };
	try {
		const resp = await env.SELF.fetch(`${SELF_ORIGIN}/alerts`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-internal-token": env.PROXY_TOKEN,
			},
			body: JSON.stringify(samples),
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		return (await resp.json()) as AlertPassResult;
	} catch (e) {
		console.error("[ERROR] alert pass failed:", e);
		return { fired: 0, error: String(e) };
	}
}

type AlertPassResult = { fired: number; pushed?: boolean; error?: string };

// Fold this cycle's samples into the rolling window and push whatever fired.
async function processAlerts(
	env: Env,
	samples: AlertSample[],
): Promise<AlertPassResult> {
	const now = new Date();
	const state = await loadState(env.DATA);
	const fired = detect(state, samples, now.getTime(), tsTaipei(now));

	// Saved even when nothing fires: the window has to keep growing, and the
	// cooldown stamps of anything that did fire live in here too.
	await saveState(env.DATA, state);
	if (!fired.length) return { fired: 0 };

	console.log(
		`[ALERT] ${fired.length} fired: ` +
			fired
				.map((f) => `${f.symbol}/${f.metric} ${f.z.toFixed(1)}σ`)
				.join(", "),
	);

	if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
		console.warn("[WARN] telegram not configured — recorded, not pushed");
		return { fired: fired.length, pushed: false };
	}

	try {
		await sendTelegram(
			env.TG_BOT_TOKEN,
			env.TG_CHAT_ID,
			formatMessage(fired, SELF_ORIGIN),
		);
		return { fired: fired.length, pushed: true };
	} catch (e) {
		// The save above already stamped the cooldowns, so this message is lost
		// rather than retried next cycle. Dropping one push beats re-pushing
		// every signal in it, and /data/alerts.json still holds the record.
		console.error("[ERROR] telegram push failed:", e);
		return { fired: fired.length, pushed: false, error: String(e) };
	}
}

// Rebuild one symbol's window from the day shards already in R2. Reads the two
// most recent days, enough to fill a 24h window whenever today's shard is
// still short.
async function backfillSymbol(
	env: Env,
	meta: SymbolMeta,
): Promise<{ symbol: string; samples: number; last_ts: string | null }> {
	const idxObj = await env.DATA.get(`${meta.symbol}/days/index.json`);
	const dates = idxObj ? ((await idxObj.json()) as string[]) : [];

	const shards = await Promise.all(
		dates.slice(-2).map(async (d) => {
			const obj = await env.DATA.get(`${meta.symbol}/days/${d}.ndjson`);
			return obj ? obj.text() : "";
		}),
	);

	// Each shard already ends in a newline, so plain concatenation is safe.
	const lines = shards
		.join("")
		.split("\n")
		.filter((l) => l !== "")
		.slice(-ALERT_WINDOW);

	const rows: { r: number; l: number; s: number }[] = [];
	let lastTs: string | null = null;
	for (const line of lines) {
		try {
			const row = JSON.parse(line);
			const r = Number(row.sm_ls_ratio);
			const l = Number(row.sm_long_pos_usdt);
			const s = Number(row.sm_short_pos_usdt);
			if (!Number.isFinite(r) || !Number.isFinite(l) || !Number.isFinite(s)) {
				continue;
			}
			rows.push({ r, l, s });
			if (typeof row.timestamp === "string") lastTs = row.timestamp;
		} catch {
			// A truncated trailing line is expected mid-append; skip it.
		}
	}

	const state = await loadState(env.DATA);
	const n = backfill(state, meta.short, rows, parseTaipeiTs(lastTs));
	await saveState(env.DATA, state);

	console.log(`[BACKFILL] ${meta.symbol}: ${n} samples up to ${lastTs}`);
	return { symbol: meta.short, samples: n, last_ts: lastTs };
}

// Inverse of tsTaipei: "YYYY-MM-DD HH:MM" is a UTC+8 wall clock.
function parseTaipeiTs(ts: string | null): number {
	if (!ts) return 0;
	const ms = Date.parse(`${ts.replace(" ", "T")}:00+08:00`);
	return Number.isFinite(ms) ? ms : 0;
}

// symbols.json is rewritten wholesale every cycle, so a symbol whose collection
// failed this round would otherwise drop to price:null/has_data:false — which
// blanks its card and greys out its tile even though its day shards in R2 are
// intact and still render. Carry the last good numbers forward, flagged stale.
async function carryForwardFailures(
	env: Env,
	summary: SummaryEntry[],
): Promise<SummaryEntry[]> {
	if (summary.every((s) => s.has_data)) return summary;

	let prev: Map<string, SummaryEntry>;
	try {
		const obj = await env.DATA.get("symbols.json");
		if (!obj) return summary;
		const rows = (await obj.json()) as SummaryEntry[];
		prev = new Map(rows.map((r) => [r.symbol, r]));
	} catch (e) {
		console.error("[ERROR] could not read previous symbols.json:", e);
		return summary;
	}

	return summary.map((entry) => {
		if (entry.has_data) return entry;
		const old = prev.get(entry.symbol);
		if (!old?.has_data) return entry;
		return {
			...old,
			// Metadata always comes from this deployment, never the old file.
			label: entry.label,
			hidden: entry.hidden,
			stale: true,
			error: entry.error,
		};
	});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "public, max-age=30",
			...CORS_HEADERS,
		},
	});
}

async function serveR2(
	env: Env,
	key: string,
	contentType = "application/json",
): Promise<Response> {
	const obj = await env.DATA.get(key);
	if (!obj) return jsonResponse({ error: "not found", key }, 404);
	const ct = obj.httpMetadata?.contentType ?? contentType;
	return new Response(obj.body, {
		status: 200,
		headers: {
			"content-type": ct,
			"cache-control": "public, max-age=30",
			...CORS_HEADERS,
		},
	});
}

export default {
	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(runCollection(env));
	},

	async fetch(request, env, _ctx): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const p = url.pathname;

		if (p === "/run") {
			const result = await runCollection(env);
			return jsonResponse(result);
		}

		// One batch, run as its own invocation (fresh 50-subrequest budget).
		// Called by runCollection's fan-out; returns the batch's summary rows.
		if (p === "/collect") {
			const batches = getBatches();
			// Number(null) and Number("") are both 0, so an absent param would
			// otherwise pass the range check and silently collect batch 0.
			const rawBatch = url.searchParams.get("batch");
			const batchIdx = Number(rawBatch);
			if (
				rawBatch === null ||
				rawBatch.trim() === "" ||
				!Number.isInteger(batchIdx) ||
				batchIdx < 0 ||
				batchIdx >= batches.length
			) {
				return jsonResponse({ error: "invalid batch" }, 400);
			}
			// Supplied by runCollection's fan-out so the batch doesn't refetch
			// the BTC reference; absent on a direct call, which then fetches it.
			const btcPrice = url.searchParams.get("btc_price");
			const btcPct = url.searchParams.get("btc_pct");
			const btcRef: BtcRef | undefined =
				btcPrice && btcPct
					? { lastPrice: btcPrice, priceChangePercent: btcPct }
					: undefined;

			return jsonResponse(await collectGroup(env, batches[batchIdx], btcRef));
		}

		// Internal fan-out target for runCollection's alert pass. Unlike /collect
		// this is token-guarded: a stranger calling it could push fabricated
		// samples into the rolling window, or burn the Telegram quota.
		if (p === "/alerts") {
			if (request.method !== "POST") {
				return jsonResponse({ error: "POST only" }, 405);
			}
			if (request.headers.get("x-internal-token") !== env.PROXY_TOKEN) {
				return jsonResponse({ error: "forbidden" }, 403);
			}
			let samples: AlertSample[];
			try {
				samples = (await request.json()) as AlertSample[];
				if (!Array.isArray(samples)) throw new Error("expected an array");
			} catch (e) {
				return jsonResponse({ error: `bad body: ${e}` }, 400);
			}
			return jsonResponse(await processAlerts(env, samples));
		}

		// Seed one symbol's rolling window from the day shards already in R2, so
		// detection starts working immediately instead of 8 hours after deploy.
		// One symbol per call: parsing a full window is the CPU-heavy part.
		if (p === "/alerts/backfill") {
			if (request.headers.get("x-internal-token") !== env.PROXY_TOKEN) {
				return jsonResponse({ error: "forbidden" }, 403);
			}
			const short = url.searchParams.get("symbol");
			const meta = SYMBOLS_META.find((x) => x.short === short);
			if (!meta) return jsonResponse({ error: "unknown symbol" }, 404);
			return jsonResponse(await backfillSymbol(env, meta));
		}

		// Sanity-check the Telegram wiring without waiting for a real signal.
		if (p === "/alerts/test") {
			if (request.headers.get("x-internal-token") !== env.PROXY_TOKEN) {
				return jsonResponse({ error: "forbidden" }, 403);
			}
			if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
				return jsonResponse({ error: "telegram secrets not set" }, 400);
			}
			await sendTelegram(
				env.TG_BOT_TOKEN,
				env.TG_CHAT_ID,
				`🔔 <b>聰明錢異動</b> — 測試訊息\n\n` +
					`推播通道正常，偵測到異動時會像這樣通知。\n` +
					`<a href="${SELF_ORIGIN}">開啟 dashboard</a>`,
			);
			return jsonResponse({ ok: true });
		}

		if (p === "/data/symbols.json") {
			return serveR2(env, "symbols.json");
		}

		// What has fired recently, newest first — the feedback loop for tuning
		// the thresholds in alerts.ts.
		if (p === "/data/alerts.json") {
			const state = await loadState(env.DATA);
			return jsonResponse({ recent: state.recent });
		}

		const dayIdxMatch = p.match(/^\/data\/([a-z0-9]+)\/days\/index\.json$/);
		if (dayIdxMatch) {
			const meta = SYMBOLS_META.find((x) => x.short === dayIdxMatch[1]);
			if (!meta) return jsonResponse({ error: "unknown symbol" }, 404);
			return serveR2(env, `${meta.symbol}/days/index.json`);
		}

		const dayShardMatch = p.match(
			/^\/data\/([a-z0-9]+)\/days\/(\d{4}-\d{2}-\d{2})\.ndjson$/,
		);
		if (dayShardMatch) {
			const meta = SYMBOLS_META.find((x) => x.short === dayShardMatch[1]);
			if (!meta) return jsonResponse({ error: "unknown symbol" }, 404);
			return serveR2(
				env,
				`${meta.symbol}/days/${dayShardMatch[2]}.ndjson`,
				NDJSON_CONTENT_TYPE,
			);
		}

		const m = p.match(/^\/data\/([a-z0-9]+)\/(history_full|prev_row)\.json$/);
		if (m) {
			const meta = SYMBOLS_META.find((x) => x.short === m[1]);
			if (!meta) return jsonResponse({ error: "unknown symbol" }, 404);
			return serveR2(env, `${meta.symbol}/${m[2]}.json`);
		}

		return new Response(
			"smart-money-collector\n\n" +
				"GET /run                              trigger collection now (fans out to batches)\n" +
				"GET /collect?batch=N                  collect one batch (internal fan-out target;\n" +
				"                                      optional &btc_price=&btc_pct= reuse the\n" +
				"                                      orchestrator's BTC reference)\n" +
				"POST /alerts                          run the alert pass (internal, token)\n" +
				"GET /alerts/backfill?symbol=<short>   seed one symbol's window (token)\n" +
				"GET /alerts/test                      send a Telegram test push (token)\n" +
				"GET /data/symbols.json                list of symbols\n" +
				"GET /data/alerts.json                 recent alerts, newest first\n" +
				"GET /data/<short>/prev_row.json       latest row\n" +
				"GET /data/<short>/days/index.json     list of available dates\n" +
				"GET /data/<short>/days/<date>.ndjson  daily shard, one row per line\n" +
				"GET /data/<short>/history_full.json   (legacy, stale fallback)\n\n" +
				"symbols: " +
				SYMBOLS_META.map(
					(m) => m.short + (m.hidden ? " (hidden)" : ""),
				).join(", "),
			{ headers: { "content-type": "text/plain", ...CORS_HEADERS } },
		);
	},
} satisfies ExportedHandler<Env>;
