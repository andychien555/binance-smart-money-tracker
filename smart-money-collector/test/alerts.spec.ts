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

function sample(over: Partial<AlertSample> = {}): AlertSample {
	return {
		short: "beat",
		label: "BEAT/USDT",
		price: 2.5,
		price_change_pct: -21.3,
		sm_ls_ratio: 1.2,
		sm_long_pos_usdt: 4,
		sm_short_pos_usdt: 3,
		...over,
	};
}

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
		expect(fired[0]).toMatchObject({ symbol: "beat", metric: "ls", dir: "up" });
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
		expect(state.sym.beat.r.at(-1)).toBe(1.6);
	});

	it("caps each series at the window length", () => {
		const { state } = warmUp(WINDOW + 30);
		expect(state.sym.beat.r).toHaveLength(WINDOW);
		expect(state.sym.beat.l).toHaveLength(WINDOW);
		expect(state.sym.beat.s).toHaveLength(WINDOW);
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
						...sample({ short: "lab", label: "LAB/USDT" }),
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
				sample({ short: "lab", label: "LAB/USDT", sm_ls_ratio: 1.6 }),
			],
			ms,
			TS,
		);
		expect(fired.map((f) => f.symbol)).toEqual(["beat"]);
	});
});

describe("formatMessage", () => {
	it("groups by symbol, strongest signal first", () => {
		const { state, ms } = warmUp(40);
		const fired = detect(
			state,
			[sample({ sm_ls_ratio: 1.35, sm_long_pos_usdt: 8 })],
			ms,
			TS,
		);
		expect(fired.length).toBeGreaterThan(1);

		const msg = formatMessage(fired, "https://example.test");
		expect(msg).toContain("BEAT/USDT");
		expect(msg).toContain(TS);
		expect(msg).toContain("https://example.test");
		// Notional is the larger move here, so its line leads the block.
		expect(msg.indexOf("多單持倉")).toBeLessThan(msg.indexOf("多空比"));
		// Only one header per symbol, however many metrics fired.
		expect(msg.match(/BEAT\/USDT/g)).toHaveLength(1);
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

		expect(backfill(state, "beat", rows, T0)).toBe(WINDOW);
		expect(state.sym.beat.r).toHaveLength(WINDOW);
		expect(state.sym.beat.r.at(-1)).toBeCloseTo(1.199, 6);
		expect(state.sym.beat.t).toBe(T0);
	});

	it("preserves cooldowns, so re-running it cannot replay pushes", () => {
		const { state, ms } = warmUp(40);
		detect(state, [sample({ sm_ls_ratio: 1.6 })], ms, TS);
		const cooldown = state.sym.beat.a.ls;

		backfill(state, "beat", [{ r: 1.2, l: 4, s: 3 }], ms);
		expect(state.sym.beat.a.ls).toBe(cooldown);
	});
});
