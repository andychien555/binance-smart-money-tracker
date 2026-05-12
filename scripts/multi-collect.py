#!/usr/bin/env python3
"""Multi-symbol Futures + Smart Money data collector.

Usage:
  python3 multi-collect.py RIVERUSDT
  python3 multi-collect.py BTCUSDT ETHUSDT SOLUSDT
  python3 multi-collect.py --all
"""

import json, sys, time, argparse
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent / "data"
TZ8 = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36"

# Known symbols and their on-chain config (if any)
ONCHAIN_CONFIG = {
    "RIVERUSDT": {
        "bsc_addr": "0xda7ad9dea9397cffddae2f8a052b82f1484252b3",
        "bsc_chain": "56",
    },
    "SIRENUSDT": {
        "bsc_addr": "0x997a58129890bbda032231a52ed1ddc845fc18e1",
        "bsc_chain": "56",
    },
    "LITUSDT": {
        "bsc_addr": "0xb59490ab09a0f526cc7305822ac65f2ab12f9723",
        "bsc_chain": "56",
    },
    "RAVEUSDT": {
        "bsc_addr": "0x17205fab260a7a6383a81452ce6315a39370db97",
        "bsc_chain": "1",
    },
    "BEATUSDT": {
        "bsc_addr": "0xcf3232b85b43bca90e51d38cc06cc8bb8c8a3e36",
        "bsc_chain": "56",
    },
    "POWERUSDT": {
        "bsc_addr": "0x9dc44ae5be187eca9e2a67e33f27a4c91cea1223",
        "bsc_chain": "56",
    },
}

ALL_SYMBOLS = ["RIVERUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT", "SIRENUSDT", "LITUSDT", "RAVEUSDT", "PIPPINUSDT", "BEATUSDT", "POWERUSDT"]


def fetch_json(url, headers=None, method="GET", data=None):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    if data and isinstance(data, dict):
        data = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    req = Request(url, headers=h, data=data, method=method)
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def fetch_safe(label, fn):
    try:
        return fn()
    except Exception as e:
        print(f"[WARN] {label} failed: {e}", file=sys.stderr)
        return None


def collect_symbol(symbol):
    """Collect data for one symbol. Returns (row, report_text)."""
    now = datetime.now(TZ8)
    ts = now.strftime("%Y-%m-%d %H:%M")
    
    # Derive display name (strip USDT)
    display = symbol.replace("USDT", "")
    
    data_dir = BASE_DIR / display.lower()
    data_dir.mkdir(parents=True, exist_ok=True)

    base_sm = "https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal"
    sm_headers = {"clienttype": "web", "referer": f"https://www.binance.com/zh-TC/smart-money/signal/{symbol}"}
    base_f = "https://fapi.binance.com"

    # Core APIs
    overview = fetch_json(f"{base_sm}/overview?symbol={symbol}", sm_headers)["data"]
    stats = fetch_json(f"{base_sm}/details/stats?symbol={symbol}&timeRange=30m", sm_headers)["data"]
    ticker = fetch_json(f"{base_f}/fapi/v1/ticker/24hr?symbol={symbol}")
    oi = fetch_json(f"{base_f}/fapi/v1/openInterest?symbol={symbol}")
    funding = fetch_json(f"{base_f}/fapi/v1/fundingRate?symbol={symbol}&limit=1")[0]
    global_ls = fetch_json(f"{base_f}/futures/data/globalLongShortAccountRatio?symbol={symbol}&period=1h&limit=1")[0]
    top_ls_pos = fetch_json(f"{base_f}/futures/data/topLongShortPositionRatio?symbol={symbol}&period=1h&limit=1")[0]

    price = float(ticker["lastPrice"])

    # Taker ratio
    taker_data = fetch_safe("taker-ratio", lambda: fetch_json(
        f"{base_f}/futures/data/takerlongshortRatio?symbol={symbol}&period=1h&limit=3"))
    taker_info = {}
    if taker_data and len(taker_data) > 0:
        lt = taker_data[0]
        taker_info = {
            "taker_buy_sell_ratio": round(float(lt["buySellRatio"]), 4),
            "taker_buy_vol": round(float(lt["buyVol"]) * price / 1e6, 2),
            "taker_sell_vol": round(float(lt["sellVol"]) * price / 1e6, 2),
        }

    # Depth
    depth_data = fetch_safe("depth", lambda: fetch_json(
        f"{base_f}/fapi/v1/depth?symbol={symbol}&limit=20"))
    depth_info = {}
    if depth_data:
        bids = [(float(p), float(q)) for p, q in depth_data["bids"]]
        asks = [(float(p), float(q)) for p, q in depth_data["asks"]]
        bid_total = sum(q * price for _, q in bids)
        ask_total = sum(q * price for _, q in asks)
        biggest_bid = max(bids, key=lambda x: x[1]) if bids else (0, 0)
        biggest_ask = max(asks, key=lambda x: x[1]) if asks else (0, 0)
        depth_info = {
            "depth_bid_total_k": round(bid_total / 1e3, 1),
            "depth_ask_total_k": round(ask_total / 1e3, 1),
            "depth_bid_wall_price": round(biggest_bid[0], 6),
            "depth_bid_wall_qty": round(biggest_bid[1]),
            "depth_ask_wall_price": round(biggest_ask[0], 6),
            "depth_ask_wall_qty": round(biggest_ask[1]),
            "depth_ratio": round(bid_total / max(ask_total, 1), 2),
        }

    # Agg trades
    agg_trades = fetch_safe("aggTrades", lambda: fetch_json(
        f"{base_f}/fapi/v1/aggTrades?symbol={symbol}&limit=200"))
    trade_info = {}
    if agg_trades:
        large_threshold = 50000 / max(price, 0.001)
        medium_threshold = 10000 / max(price, 0.001)
        large_trades = [t for t in agg_trades if float(t["q"]) >= large_threshold]
        medium_trades = [t for t in agg_trades if float(t["q"]) >= medium_threshold]
        buy_vol = sum(float(t["q"]) * price for t in agg_trades if not t["m"])
        sell_vol = sum(float(t["q"]) * price for t in agg_trades if t["m"])
        large_buy = sum(1 for t in medium_trades if not t["m"])
        large_sell = sum(1 for t in medium_trades if t["m"])
        trade_info = {
            "tape_large_count": len(large_trades),
            "tape_medium_count": len(medium_trades),
            "tape_large_buy": large_buy,
            "tape_large_sell": large_sell,
            "tape_aggr_buy_k": round(buy_vol / 1e3, 1),
            "tape_aggr_sell_k": round(sell_vol / 1e3, 1),
        }

    # BTC reference (skip for BTC itself)
    btc_info = {}
    if symbol != "BTCUSDT":
        btc_ticker = fetch_safe("btc", lambda: fetch_json(
            f"{base_f}/fapi/v1/ticker/24hr?symbol=BTCUSDT"))
        if btc_ticker:
            btc_pct = float(btc_ticker["priceChangePercent"])
            sym_pct = float(ticker["priceChangePercent"])
            btc_info = {
                "btc_price": round(float(btc_ticker["lastPrice"]), 0),
                "btc_24h_pct": round(btc_pct, 2),
                "river_vs_btc": round(sym_pct - btc_pct, 2),
            }

    # On-chain (only for configured symbols)
    onchain = {}
    oc_cfg = ONCHAIN_CONFIG.get(symbol)
    if oc_cfg:
        web3_dynamic = fetch_safe("web3-dynamic", lambda: fetch_json(
            f"https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info"
            f"?chainId={oc_cfg['bsc_chain']}&contractAddress={oc_cfg['bsc_addr']}",
            {"Accept-Encoding": "identity"}
        ))
        if web3_dynamic and web3_dynamic.get("success"):
            d = web3_dynamic["data"]
            onchain = {
                "onchain_holders": int(d.get("holders") or 0),
                "onchain_top10_pct": round(float(d.get("top10HoldersPercentage") or 0), 2),
                "onchain_kol_holders": int(d.get("kolHolders") or 0),
                "onchain_sm_holders": int(d.get("smartMoneyHolders") or 0),
                "onchain_liquidity": round(float(d.get("liquidity") or 0) / 1e6, 2),
            }

        # OKX DEX (only for on-chain configured tokens)
        okx_token = fetch_safe("okx-token", lambda: json.loads(
            __import__("subprocess").run(
                ["/root/.local/bin/onchainos", "token", "price-info",
                 oc_cfg["bsc_addr"], "--chain", "bsc"],
                capture_output=True, text=True, timeout=15
            ).stdout
        ))
        okx_info = {}
        if okx_token and okx_token.get("ok") and okx_token.get("data"):
            od = okx_token["data"][0]
            okx_info = {
                "okx_price_chg_5m": round(float(od.get("priceChange5M", 0)), 2),
                "okx_price_chg_1h": round(float(od.get("priceChange1H", 0)), 2),
                "okx_price_chg_4h": round(float(od.get("priceChange4H", 0)), 2),
                "okx_txs_5m": int(od.get("txs5M", 0)),
                "okx_txs_1h": int(od.get("txs1H", 0)),
                "okx_txs_24h": int(od.get("txs24H", 0)),
                "okx_vol_1h": round(float(od.get("volume1H", 0)) / 1e3, 1),
                "okx_high_24h": round(float(od.get("maxPrice", 0)), 3),
                "okx_low_24h": round(float(od.get("minPrice", 0)), 3),
            }
    else:
        okx_info = {}

    # Build row
    row = {
        "timestamp": ts,
        "price": price,
        "price_change_pct": float(ticker["priceChangePercent"]),
        "volume_24h": round(float(ticker["quoteVolume"]) / 1e6, 2),
        "oi_usdt": round(float(oi["openInterest"]) * price / 1e6, 2),
        "oi_coin": round(float(oi["openInterest"]), 2),
        "funding_rate": float(funding["fundingRate"]) * 100,
        "sm_total_traders": overview["totalTraders"],
        "sm_long_traders": overview["longTraders"],
        "sm_short_traders": overview["shortTraders"],
        "sm_long_whales": overview.get("longWhales", 0),
        "sm_short_whales": overview.get("shortWhales", 0),
        "sm_long_pos_usdt": round(overview["longTradersQty"] * price / 1e6, 2),
        "sm_short_pos_usdt": round(overview["shortTradersQty"] * price / 1e6, 2),
        "sm_ls_ratio": overview["longShortRatio"],
        "sm_long_avg_price": round(overview["longTradersAvgEntryPrice"], 4),
        "sm_short_avg_price": round(overview["shortTradersAvgEntryPrice"], 4),
        "sm_long_profit_pct": round(overview["longProfitTraders"] / max(overview["longTraders"], 1) * 100, 1),
        "sm_short_profit_pct": round(overview["shortProfitTraders"] / max(overview["shortTraders"], 1) * 100, 1),
        "sm30_long_traders": stats["longTraders"],
        "sm30_short_traders": stats["shortTraders"],
        "sm30_long_whales": stats["longWhales"],
        "sm30_short_whales": stats["shortWhales"],
        "sm30_long_pos_usdt": round(stats["longPositions"] / 1e3, 1),
        "sm30_short_pos_usdt": round(stats["shortPositions"] / 1e3, 1),
        "global_ls_ratio": float(global_ls["longShortRatio"]),
        "top_pos_ls_ratio": float(top_ls_pos["longShortRatio"]),
        **onchain,
        **taker_info,
        **depth_info,
        **trade_info,
        **btc_info,
        **okx_info,
    }

    # Save prev row
    prev_file = data_dir / "prev_row.json"
    with open(prev_file, "w") as f:
        json.dump(row, f)

    # Append to history
    history_file = data_dir / "history_full.json"
    history = []
    if history_file.exists():
        try:
            with open(history_file) as f:
                history = json.load(f)
        except:
            history = []
    history.append(row)
    if len(history) > 3000:
        history = history[-3000:]
    with open(history_file, "w") as f:
        json.dump(history, f)

    print(f"[OK] {symbol} ${price} @ {ts} ({len(history)} pts)")
    return row


def main():
    parser = argparse.ArgumentParser(description="Multi-symbol collector")
    parser.add_argument("symbols", nargs="*", help="Symbol(s) like BTCUSDT ETHUSDT")
    parser.add_argument("--all", action="store_true", help="Collect all known symbols")
    args = parser.parse_args()

    symbols = ALL_SYMBOLS if args.all else (args.symbols or ["RIVERUSDT"])
    
    # Normalize: add USDT if not present
    symbols = [s.upper() if s.upper().endswith("USDT") else s.upper() + "USDT" for s in symbols]

    results = {}
    for sym in symbols:
        try:
            results[sym] = collect_symbol(sym)
        except Exception as e:
            print(f"[ERROR] {sym}: {e}", file=sys.stderr)
        if len(symbols) > 1:
            time.sleep(1)  # Rate limit courtesy

    print(f"\nDone: {len(results)}/{len(symbols)} symbols collected")
    return results


if __name__ == "__main__":
    main()
