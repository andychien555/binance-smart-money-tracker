import { describe, expect, it } from "vitest";
import {
	type AlertSample,
	type AlertState,
	WINDOW,
	backfill,
	detect,
	emptyState,
	formatMessage,
} from "../src/alerts";

const T0 = Date.UTC(2026, 7, 10, 0, 0, 0);
const STEP = 15 * 60 * 1000;
const TS = "2026-08-10 10:00";

// Defaults to a symbol the gate does not watch, so a test that moves the ratio
// across 2.0 exercises only the z-score path. Gate tests opt in with a symbol
// from GATE_SYMBOLS.
function sample(over: Partial<AlertSample> = {}): AlertSample {
	return {
		short: "sol",
		label: "SOL/USDT",
		price: 2.5,
		price_change_pct: -21.3,
		sm_ls_ratio: 1.2,
		sm_long_pos_usdt: 4,
		sm_short_pos_usdt: 3,
		...over,
	};
}

const GATED = { short: "beat", label: "BEAT/USDT" };

// Feed n cycles of small deterministic jitter, so the detector has a spread to
// judge the next move against. The jitter is well under every floor, so a
// warm-up never fires on its own — any alert in a test comes from its own move.
function warmUp(
	n: number,
	base: Partial<AlertSample> = {},
): { state: AlertState; ms: number } {
	const b = sample(base);
	const state = emptyState();
	let ms = T0;
	for (let i = 0; i < n; i++) {
		const k = 1 + ((i % 5) - 2) * 0.001; // ±0.2%
		detect(
			state,
			[
				{
					...b,
					sm_ls_ratio: b.sm_ls_ratio * k,
					sm_long_pos_usdt: b.sm_long_pos_usdt * k,
					sm_short_pos_usdt: b.sm_short_pos_usdt * k,
				},
			],
			ms,
			"warm-up",
		);
		ms += STEP;
	}
	return { state, ms };
}

describe("detect", () => {
	it("stays quiet during warm-up, and warm-up itself never fires", () => {
		const { state, ms } = warmUp(20);
		expect(state.recent).toEqual([]);
		// A huge jump still cannot be scored without enough history behind it.
		expect(detect(state, [sample({ sm_ls_ratio: 2.5 })], ms, TS)).toEqual([]);
	});

	it("ignores ordinary jitter once warmed up", () => {
		const { state, ms } = warmUp(40);
		expect(detect(state, [sample({ sm_ls_ratio: 1.202 })], ms, TS)).toEqual([]);
	});

	it("fires on a ratio jump far outside the symbol's own spread", () => {
		const { state, ms } = warmUp(40);
		const fired = detect(state, [sample({ sm_ls_ratio: 1.6 })], ms, TS);

		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({ symbol: "sol", metric: "ls", dir: "up" });
		expect(Math.abs(fired[0].z)).toBeGreaterThan(2.5);
		expect(state.recent).toHaveLength(1);
	});

	it("fires on a jump in one side's notional", () => {
		const { state, ms } = warmUp(40);
		const fired = detect(state, [sample({ sm_long_pos_usdt: 6 })], ms, TS);

		expect(fired.map((f) => f.metric)).toEqual(["long"]);
		expect(fired[0].pct).toBeCloseTo(0.5, 1);
		expect(fired[0].dir).toBe("up");
	});

	it("reports a falling metric as down", () => {
		const { state, ms } = warmUp(40);
		const fired = detect(state, [sample({ sm_short_pos_usdt: 1 })], ms, TS);

		expect(fired.map((f) => f.metric)).toEqual(["short"]);
		expect(fired[0].dir).toBe("down");
	});

	it("ignores a statistically loud move that is economically trivial", () => {
		const { state, ms } = warmUp(40);
		// Tens of sigma against a ±0.2% spread, but a 0.02 ratio move is noise.
		expect(detect(state, [sample({ sm_ls_ratio: 1.22 })], ms, TS)).toEqual([]);
	});

	it("ignores a notional move below the percentage floor", () => {
		const { state, ms } = warmUp(40);
		// +8% against a ±0.2% spread is many sigma, but under the 13% floor.
		expect(
			detect(state, [sample({ sm_long_pos_usdt: 4.33 })], ms, TS),
		).toEqual([]);
		// ...while the next step, +20% from there, does fire.
		expect(
			detect(state, [sample({ sm_long_pos_usdt: 5.2 })], ms + STEP, TS),
		).toHaveLength(1);
	});

	it("ignores a big percentage swing on a near-empty book", () => {
		const { state, ms } = warmUp(40, {
			sm_long_pos_usdt: 0.1,
			sm_short_pos_usdt: 0.1,
		});
		// Tripling, but $0.1M -> $0.3M is below the notional floor.
		const fired = detect(
			state,
			[sample({ sm_long_pos_usdt: 0.3, sm_short_pos_usdt: 0.1 })],
			ms,
			TS,
		);
		expect(fired).toEqual([]);
	});

	it("holds the next alert for a metric until its cooldown lapses", () => {
		const { state, ms } = warmUp(40);
		expect(detect(state, [sample({ sm_ls_ratio: 1.6 })], ms, TS)).toHaveLength(
			1,
		);
		// A second jump one cycle later, just as large, stays silent.
		const again = detect(
			state,
			[sample({ sm_ls_ratio: 2.0 })],
			ms + STEP,
			TS,
		);
		expect(again).toEqual([]);
	});

	it("keeps a cooled-down metric from muting the others", () => {
		const { state, ms } = warmUp(40);
		detect(state, [sample({ sm_ls_ratio: 1.6 })], ms, TS);
		// ls is cooling down; a notional move on the same symbol still fires.
		const fired = detect(
			state,
			[sample({ sm_ls_ratio: 1.6, sm_long_pos_usdt: 6 })],
			ms + STEP,
			TS,
		);
		expect(fired.map((f) => f.metric)).toEqual(["long"]);
	});

	it("skips scoring after a collection gap but keeps the sample", () => {
		const { state, ms } = warmUp(40);
		// Two missed cycles: this step spans 45 minutes, not 15, so its size is
		// not comparable with the spread built from 15-minute steps.
		const fired = detect(
			state,
			[sample({ sm_ls_ratio: 1.6 })],
			ms + 3 * STEP,
			TS,
		);
		expect(fired).toEqual([]);
		expect(state.sym.sol.r.at(-1)).toBe(1.6);
	});

	it("caps each series at the window length", () => {
		const { state } = warmUp(WINDOW + 30);
		expect(state.sym.sol.r).toHaveLength(WINDOW);
		expect(state.sym.sol.l).toHaveLength(WINDOW);
		expect(state.sym.sol.s).toHaveLength(WINDOW);
	});

	it("scores each symbol against its own spread", () => {
		const state = emptyState();
		let ms = T0;
		for (let i = 0; i < 40; i++) {
			const k = 1 + ((i % 5) - 2) * 0.001;
			detect(
				state,
				[
					{ ...sample(), sm_ls_ratio: 1.2 * k }, // calm
					{
						...sample({ short: "btc", label: "BTC/USDT" }),
						// Swings ±25% every cycle: 1.6 would be unremarkable here.
						sm_ls_ratio: 1.2 * (1 + ((i % 2) - 0.5) * 0.5),
					},
				],
				ms,
				"warm-up",
			);
			ms += STEP;
		}

		const fired = detect(
			state,
			[
				sample({ sm_ls_ratio: 1.6 }),
				sample({ short: "btc", label: "BTC/USDT", sm_ls_ratio: 1.6 }),
			],
			ms,
			TS,
		);
		expect(fired.map((f) => f.symbol)).toEqual(["sol"]);
	});
});

describe("gate (absolute level)", () => {
	// Two readings is all the gate needs — no warm-up, which is what makes it
	// work on a symbol added yesterday.
	function cross(from: number, to: number, gapMs = STEP, symbol = GATED) {
		const state = emptyState();
		detect(state, [sample({ ...symbol, sm_ls_ratio: from })], T0, "warm-up");
		const fired = detect(
			state,
			[sample({ ...symbol, sm_ls_ratio: to })],
			T0 + gapMs,
			TS,
		);
		return { state, fired };
	}

	it("fires when a watched symbol crosses the level", () => {
		const { fired } = cross(1.9, 2.1);
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({
			symbol: "beat",
			metric: "gate",
			dir: "up",
			from: 1.9,
			to: 2.1,
		});
	});

	it("ignores jitter on the threshold itself", () => {
		// 1.995 -> 2.005 is a crossing, but not a breakout. Half of all raw
		// crossings in the historical data looked like this.
		expect(cross(1.995, 2.005).fired).toEqual([]);
	});

	it("catches a jump that starts just under the level", () => {
		// Starting at 1.999 and landing at 4.2 happened for real; a rule keyed on
		// a low starting point would have missed the biggest move in the history.
		expect(cross(1.999, 4.2).fired).toHaveLength(1);
	});

	it("does not watch the majors", () => {
		expect(cross(1.9, 2.5, STEP, { short: "sol", label: "SOL/USDT" }).fired)
			.toEqual([]);
	});

	it("reports the crossing, not the state", () => {
		const state = emptyState();
		let ms = T0;
		detect(state, [sample({ ...GATED, sm_ls_ratio: 1.9 })], ms, "warm-up");
		ms += STEP;
		expect(
			detect(state, [sample({ ...GATED, sm_ls_ratio: 2.3 })], ms, TS),
		).toHaveLength(1);
		// BEAT sat above 2 for 69% of its history — staying there must be silent.
		for (const v of [2.4, 2.5, 2.6, 3.0]) {
			ms += STEP;
			expect(
				detect(state, [sample({ ...GATED, sm_ls_ratio: v })], ms, TS),
			).toEqual([]);
		}
	});

	it("holds a second crossing until the cooldown lapses", () => {
		const state = emptyState();
		let ms = T0;
		detect(state, [sample({ ...GATED, sm_ls_ratio: 1.9 })], ms, "warm-up");
		ms += STEP;
		expect(
			detect(state, [sample({ ...GATED, sm_ls_ratio: 2.3 })], ms, TS),
		).toHaveLength(1);
		// Drops back under and crosses again, still inside the 12h cooldown.
		ms += STEP;
		detect(state, [sample({ ...GATED, sm_ls_ratio: 1.8 })], ms, TS);
		ms += STEP;
		expect(
			detect(state, [sample({ ...GATED, sm_ls_ratio: 2.4 })], ms, TS),
		).toEqual([]);
	});

	it("survives a collection gap that mutes the z-score checks", () => {
		const { fired } = cross(1.9, 2.3, 3 * 60 * 60 * 1000);
		expect(fired.map((f) => f.metric)).toEqual(["gate"]);
	});

	it("does not restate a gate hit as a separate ratio alert", () => {
		const { state, ms } = warmUp(40, GATED);
		const fired = detect(
			state,
			[sample({ ...GATED, sm_ls_ratio: 2.5 })],
			ms,
			TS,
		);
		expect(fired.map((f) => f.metric)).toEqual(["gate"]);
	});
});

describe("formatMessage", () => {
	it("leads with the gate hit and flags it", () => {
		const state = emptyState();
		detect(state, [sample({ ...GATED, sm_ls_ratio: 1.9 })], T0, "warm-up");
		const fired = detect(
			state,
			[sample({ ...GATED, sm_ls_ratio: 2.4 })],
			T0 + STEP,
			TS,
		);

		const msg = formatMessage(fired, "https://example.test");
		expect(msg).toContain("🚨");
		expect(msg).toContain("多空比突破 2");
		expect(msg).toContain("+0.500");
		// The gate has no sigma to quote.
		expect(msg).not.toContain("σ");
	});

	it("groups by symbol, strongest signal first", () => {
		const { state, ms } = warmUp(40);
		const fired = detect(
			state,
			[sample({ sm_ls_ratio: 1.45, sm_long_pos_usdt: 8 })],
			ms,
			TS,
		);
		expect(fired.length).toBeGreaterThan(1);

		const msg = formatMessage(fired, "https://example.test");
		expect(msg).toContain("SOL/USDT");
		expect(msg).toContain(TS);
		expect(msg).toContain("https://example.test");
		// Notional is the larger move here, so its line leads the block.
		expect(msg.indexOf("多單持倉")).toBeLessThan(msg.indexOf("多空比"));
		// Only one header per symbol, however many metrics fired.
		expect(msg.match(/SOL\/USDT/g)).toHaveLength(1);
	});

	it("escapes HTML so a label cannot break the markup", () => {
		const msg = formatMessage(
			[
				{
					ts: TS,
					symbol: "x",
					label: "<b>&evil</b>",
					metric: "ls",
					dir: "up",
					from: 1,
					to: 2,
					pct: 1,
					z: 3,
					price: 1,
					price_change_pct: 0,
				},
			],
			"https://example.test",
		);
		expect(msg).toContain("&lt;b&gt;&amp;evil&lt;/b&gt;");
	});
});

describe("backfill", () => {
	it("seeds a window from history, newest last", () => {
		const state = emptyState();
		const rows = Array.from({ length: 200 }, (_, i) => ({
			r: 1 + i * 0.001,
			l: 5,
			s: 4,
		}));

		expect(backfill(state, "sol", rows, T0)).toBe(WINDOW);
		expect(state.sym.sol.r).toHaveLength(WINDOW);
		expect(state.sym.sol.r.at(-1)).toBeCloseTo(1.199, 6);
		expect(state.sym.sol.t).toBe(T0);
	});

	it("preserves cooldowns, so re-running it cannot replay pushes", () => {
		const { state, ms } = warmUp(40);
		detect(state, [sample({ sm_ls_ratio: 1.6 })], ms, TS);
		const cooldown = state.sym.sol.a.ls;

		backfill(state, "sol", [{ r: 1.2, l: 4, s: 3 }], ms);
		expect(state.sym.sol.a.ls).toBe(cooldown);
	});
});
