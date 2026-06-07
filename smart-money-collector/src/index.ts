const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36";

type SymbolMeta = {
	symbol: string;
	short: string;
	label: string;
	onchain?: { chain: string; addr: string };
};

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
	{ symbol: "VVVUSDT", short: "vvv", label: "VVV/USDT" },
];

// Cloudflare Workers (Free) caps each invocation at 50 fetch() subrequests.
// Each symbol costs ~10-11 subrequests, so all symbols in one invocation blows
// the limit (the tail-end depth/aggTrades fetches start failing). Instead the
// cron fans out into batches, each run as its OWN sub-invocation (via a self
// fetch to /collect?batch=N) so each gets a fresh 50-subrequest budget.
const SELF_ORIGIN = "https://smart-money-collector.andychien-design.workers.dev";
const BATCH_SIZE = 3; // symbols per sub-invocation (worst case ~32 subrequests)

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
			tape_large_buy: mediumTrades.filter((t: any) => !t.m).length,
			tape_large_sell: mediumTrades.filter((t: any) => t.m).length,
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
	has_data: boolean;
	last_ts?: string;
	error?: string;
};

// Collect one batch of symbols within a single invocation (its own subrequest
// budget). Writes each symbol's day shard + prev_row; returns the summary rows.
// Does NOT write symbols.json — the orchestrator merges all batches first.
async function collectGroup(
	env: Env,
	metas: SymbolMeta[],
): Promise<SummaryEntry[]> {
	const btcTicker = await fetchSafe("btc-ref", () =>
		fetchJson<any>(
			env,
			"https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT",
		),
	);

	const results = await Promise.allSettled(
		metas.map((m) => collectSymbol(m, env, btcTicker)),
	);

	return metas.map((meta, i): SummaryEntry => {
		const r = results[i];
		if (r.status === "fulfilled") {
			return {
				symbol: meta.short,
				label: meta.label,
				price: r.value.row.price,
				change_pct: r.value.row.price_change_pct,
				sm_ls_ratio: r.value.row.sm_ls_ratio,
				has_data: true,
				last_ts: r.value.row.timestamp,
			};
		}
		console.error(`[ERROR] ${meta.symbol}:`, r.reason);
		return {
			symbol: meta.short,
			label: meta.label,
			price: null,
			change_pct: null,
			has_data: false,
			error: String(r.reason),
		};
	});
}

// Orchestrator (cron + /run): fan each batch out to its own sub-invocation via a
// self fetch to /collect, so every batch gets a fresh 50-subrequest budget. Then
// merge the returned summaries and write symbols.json once. This invocation only
// spends one subrequest per batch.
async function runCollection(env: Env) {
	const batches = getBatches();
	const perBatch = await Promise.all(
		batches.map(async (group, i): Promise<SummaryEntry[]> => {
			try {
				const resp = await env.SELF.fetch(
					`${SELF_ORIGIN}/collect?batch=${i}`,
				);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const body = (await resp.json()) as { summary: SummaryEntry[] };
				return body.summary;
			} catch (e) {
				console.error(`[ERROR] batch ${i} fetch failed:`, e);
				return group.map(
					(meta): SummaryEntry => ({
						symbol: meta.short,
						label: meta.label,
						price: null,
						change_pct: null,
						has_data: false,
						error: String(e),
					}),
				);
			}
		}),
	);

	const summary = perBatch.flat();
	await env.DATA.put("symbols.json", JSON.stringify(summary), {
		httpMetadata: { contentType: "application/json" },
	});
	await env.DATA.put(
		"meta.json",
		JSON.stringify({ updated_at: new Date().toISOString() }),
		{ httpMetadata: { contentType: "application/json" } },
	);

	const ok = summary.filter((s) => s.has_data).length;
	console.log(
		`Done: ${ok}/${summary.length} symbols collected (${batches.length} batches)`,
	);
	return { ok, total: summary.length, summary };
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
			const batchIdx = Number(url.searchParams.get("batch"));
			if (
				!Number.isInteger(batchIdx) ||
				batchIdx < 0 ||
				batchIdx >= batches.length
			) {
				return jsonResponse({ error: "invalid batch" }, 400);
			}
			const summary = await collectGroup(env, batches[batchIdx]);
			return jsonResponse({ summary });
		}

		if (p === "/data/symbols.json") {
			return serveR2(env, "symbols.json");
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
				"GET /collect?batch=N                  collect one batch (internal fan-out target)\n" +
				"GET /data/symbols.json                list of symbols\n" +
				"GET /data/<short>/prev_row.json       latest row\n" +
				"GET /data/<short>/days/index.json     list of available dates\n" +
				"GET /data/<short>/days/<date>.ndjson  daily shard, one row per line\n" +
				"GET /data/<short>/history_full.json   (legacy, stale fallback)\n\n" +
				"symbols: " +
				SYMBOLS_META.map((m) => m.short).join(", "),
			{ headers: { "content-type": "text/plain", ...CORS_HEADERS } },
		);
	},
} satisfies ExportedHandler<Env>;
