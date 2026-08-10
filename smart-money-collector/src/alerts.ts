/**
 * Smart-money change detection + Telegram delivery.
 *
 * Runs as its own sub-invocation (POST /alerts, fired by runCollection) so the
 * statistics get a fresh 10ms CPU budget, separate from the collection
 * orchestrator — same reasoning as the /collect batch fan-out.
 */

// One symbol's numbers for this cycle. Only symbols that actually collected
// this round appear here: a row carried forward by carryForwardFailures is the
// previous cycle's values repeated, which would inject a fake zero-change step
// into the window and deflate the sigma.
export type AlertSample = {
	short: string;
	label: string;
	price: number;
	price_change_pct: number;
	sm_ls_ratio: number;
	sm_long_pos_usdt: number;
	sm_short_pos_usdt: number;
};

export type Metric = "ls" | "long" | "short";

// --- tuning ---------------------------------------------------------------
// A move is worth pushing when it is large *relative to how much this symbol
// normally moves in 15 minutes*. A fixed threshold cannot work across the
// tracked set: BTC's ratio sits still while the small caps swing all day, so
// one number would either spam on LAB or never fire on BTC.
//
// Every knob lives here. Revisit after watching a week of real firing rates —
// GET /data/alerts.json lists what fired, including the z that triggered it.

export const WINDOW = 96; // samples kept per symbol = 24h at one per 15min
const MIN_SAMPLES = 32; // need 8h of history before scoring anything
const Z_THRESHOLD = 2.5; // sigmas above this symbol's own 15min spread
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // per symbol + metric
const MAX_GAP_MS = 40 * 60 * 1000; // >2 cron cycles apart: step not comparable
const MAX_RECENT = 50; // kept in state, served at /data/alerts.json

// Floors that stop a statistically loud move from firing when it is
// economically meaningless. A symbol whose ratio barely budges has a tiny
// sigma, which would otherwise turn every twitch into a 3-sigma event.
//
// Keep these low enough that the sigma stays in charge for most symbols. At
// MIN_POS_PCT = 0.1 the floor decided 12 of 14 notional checks outright —
// BTC's 2.5-sigma step is 1.6%, so a 10% floor made it a 15-sigma ask that
// would never fire. Measured against real history on 2026-08-10; re-derive
// from /data/alerts.json rather than guessing if these need another pass.
const MIN_LS_DELTA = 0.05; // absolute sm_ls_ratio change
const MIN_POS_PCT = 0.03; // 3% swing in one side's notional...
const MIN_POS_USDT = 0.5; // ...on a side holding >= $0.5M (row unit: millions)

// --- state ----------------------------------------------------------------
// Compact on purpose: the whole object is parsed and re-serialised every cron
// tick under a 10ms CPU budget. Single-letter keys, and one timestamp per
// symbol rather than per sample — enough to spot a collection gap.
type SymbolState = {
	t: number; // epoch ms of the newest sample
	r: number[]; // sm_ls_ratio, newest last
	l: number[]; // sm_long_pos_usdt
	s: number[]; // sm_short_pos_usdt
	a: Partial<Record<Metric, number>>; // metric -> epoch ms of its last alert
};

export type AlertRecord = {
	ts: string;
	symbol: string;
	label: string;
	metric: Metric;
	dir: "up" | "down";
	from: number;
	to: number;
	pct: number;
	z: number;
	price: number;
	price_change_pct: number;
};

export type AlertState = {
	v: 1;
	sym: Record<string, SymbolState>;
	recent: AlertRecord[];
};

export const STATE_KEY = "alerts/state.json";

export function emptyState(): AlertState {
	return { v: 1, sym: {}, recent: [] };
}

export async function loadState(bucket: R2Bucket): Promise<AlertState> {
	try {
		const obj = await bucket.get(STATE_KEY);
		if (!obj) return emptyState();
		const parsed = (await obj.json()) as AlertState;
		if (parsed?.v !== 1 || !parsed.sym) return emptyState();
		parsed.recent ??= [];
		return parsed;
	} catch (e) {
		// A corrupt state file must not stall collection: start over. The cost is
		// one quiet window while history rebuilds, not a failed cron.
		console.error("[ERROR] alert state unreadable, resetting:", e);
		return emptyState();
	}
}

export function saveState(bucket: R2Bucket, state: AlertState): Promise<unknown> {
	return bucket.put(STATE_KEY, JSON.stringify(state), {
		httpMetadata: { contentType: "application/json" },
	});
}

function pushSample(series: number[], value: number): number[] {
	series.push(value);
	return series.length > WINDOW ? series.slice(-WINDOW) : series;
}

type Score = { z: number; from: number; to: number; delta: number; pct: number };

// Score the newest step in `series` against the spread of every step before it.
// `relative` scores percentage steps — right for notional, which grows and
// shrinks by orders of magnitude — instead of absolute ones, right for a ratio.
function score(series: number[], relative: boolean): Score | null {
	// +2: one point is consumed by the first step, one by the step being judged.
	if (series.length < MIN_SAMPLES + 2) return null;

	const steps: number[] = [];
	for (let i = 1; i < series.length; i++) {
		const prev = series[i - 1];
		steps.push(
			relative
				? (series[i] - prev) / Math.max(Math.abs(prev), 1e-9)
				: series[i] - prev,
		);
	}

	const current = steps.pop() as number;
	const n = steps.length;
	let sum = 0;
	for (const x of steps) sum += x;
	const mean = sum / n;
	let acc = 0;
	for (const x of steps) acc += (x - mean) ** 2;
	const sd = Math.sqrt(acc / n);
	if (!(sd > 0)) return null;

	const from = series[series.length - 2];
	const to = series[series.length - 1];
	return {
		z: (current - mean) / sd,
		from,
		to,
		delta: to - from,
		pct: (to - from) / Math.max(Math.abs(from), 1e-9),
	};
}

function passesFloor(metric: Metric, r: Score): boolean {
	if (metric === "ls") return Math.abs(r.delta) >= MIN_LS_DELTA;
	// A big percentage swing on a near-empty book is noise, not a signal.
	return (
		Math.abs(r.pct) >= MIN_POS_PCT && Math.max(r.from, r.to) >= MIN_POS_USDT
	);
}

// Fold this cycle's samples into the rolling window and return whatever crossed
// the bar. Mutates `state` — the caller persists it whether or not anything
// fired, since the window must keep growing either way.
export function detect(
	state: AlertState,
	samples: AlertSample[],
	nowMs: number,
	tsLabel: string,
): AlertRecord[] {
	const fired: AlertRecord[] = [];

	for (const s of samples) {
		const prev = state.sym[s.short];
		const st: SymbolState = prev ?? { t: 0, r: [], l: [], s: [], a: {} };

		// After a gap the missing cycles' moves collapse into one step, which is
		// not comparable with the 15-minute steps the sigma was built from. Keep
		// the sample — the window needs it — but do not score this round.
		const gapped = prev != null && nowMs - prev.t > MAX_GAP_MS;

		st.r = pushSample(st.r, s.sm_ls_ratio);
		st.l = pushSample(st.l, s.sm_long_pos_usdt);
		st.s = pushSample(st.s, s.sm_short_pos_usdt);
		st.t = nowMs;
		state.sym[s.short] = st;

		if (gapped) continue;

		const checks: { metric: Metric; series: number[]; relative: boolean }[] = [
			{ metric: "ls", series: st.r, relative: false },
			{ metric: "long", series: st.l, relative: true },
			{ metric: "short", series: st.s, relative: true },
		];

		for (const c of checks) {
			if (nowMs - (st.a[c.metric] ?? 0) < COOLDOWN_MS) continue;

			const r = score(c.series, c.relative);
			if (!r || Math.abs(r.z) < Z_THRESHOLD || !passesFloor(c.metric, r)) {
				continue;
			}

			st.a[c.metric] = nowMs;
			fired.push({
				ts: tsLabel,
				symbol: s.short,
				label: s.label,
				metric: c.metric,
				dir: r.delta >= 0 ? "up" : "down",
				from: r.from,
				to: r.to,
				pct: r.pct,
				z: r.z,
				price: s.price,
				price_change_pct: s.price_change_pct,
			});
		}
	}

	if (fired.length) {
		state.recent = [...fired, ...state.recent].slice(0, MAX_RECENT);
	}
	return fired;
}

// Seed a symbol's window from history already in R2 (see /alerts/backfill), so
// detection starts on the next cron instead of 8 hours after deploy. `lastMs`
// is when the newest row was collected — carrying it over means a stale
// backfill is caught by the same gap check a missed cron cycle is.
export function backfill(
	state: AlertState,
	short: string,
	rows: { r: number; l: number; s: number }[],
	lastMs: number,
): number {
	const tail = rows.slice(-WINDOW);
	state.sym[short] = {
		t: lastMs,
		r: tail.map((x) => x.r),
		l: tail.map((x) => x.l),
		s: tail.map((x) => x.s),
		// Cooldowns survive a re-run, so backfilling twice cannot replay pushes.
		a: state.sym[short]?.a ?? {},
	};
	return tail.length;
}

// --- message ---------------------------------------------------------------

const METRIC_LABEL: Record<Metric, string> = {
	ls: "多空比",
	long: "多單持倉",
	short: "空單持倉",
};

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPrice(p: number): string {
	if (p >= 1000) return p.toFixed(0);
	if (p >= 1) return p.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
	return p.toPrecision(4);
}

// Row unit for notional is millions of USDT.
function fmtUsd(m: number): string {
	return m >= 1 ? `$${m.toFixed(2)}M` : `$${(m * 1000).toFixed(0)}K`;
}

function fmtPct(ratio: number): string {
	return `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;
}

export function formatMessage(
	records: AlertRecord[],
	dashboardUrl: string,
): string {
	const bySymbol = new Map<string, AlertRecord[]>();
	for (const r of records) {
		const list = bySymbol.get(r.symbol);
		if (list) list.push(r);
		else bySymbol.set(r.symbol, [r]);
	}

	const blocks: string[] = [];
	for (const rs of bySymbol.values()) {
		// Strongest signal leads, and sets the block's direction arrow.
		rs.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
		const head = rs[0];
		const lines = [
			`${head.dir === "up" ? "📈" : "📉"} <b>${esc(head.label)}</b>  ` +
				`$${fmtPrice(head.price)}  ` +
				`<code>${fmtPct(head.price_change_pct / 100)} 24h</code>`,
		];
		for (const r of rs) {
			const from = r.metric === "ls" ? r.from.toFixed(4) : fmtUsd(r.from);
			const to = r.metric === "ls" ? r.to.toFixed(4) : fmtUsd(r.to);
			lines.push(
				`   ${METRIC_LABEL[r.metric]} ${from} → ${to}  ` +
					`(${fmtPct(r.pct)}, ${r.z.toFixed(1)}σ)`,
			);
		}
		blocks.push(lines.join("\n"));
	}

	const ts = records[0]?.ts ?? "";
	return (
		`🔔 <b>聰明錢異動</b> · ${esc(ts)} (UTC+8)\n\n` +
		`${blocks.join("\n\n")}\n\n` +
		`<a href="${dashboardUrl}">開啟 dashboard</a>`
	);
}

// --- delivery --------------------------------------------------------------

export async function sendTelegram(
	token: string,
	chatId: string,
	text: string,
): Promise<void> {
	const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		}),
	});
	if (!resp.ok) {
		const body = (await resp.text()).slice(0, 200);
		throw new Error(`telegram HTTP ${resp.status}: ${body}`);
	}
}
