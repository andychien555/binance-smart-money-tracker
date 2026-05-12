#!/usr/bin/env python3
"""Multi-symbol Dashboard - Flask app serving historical data + charts"""

import json
from pathlib import Path
from flask import Flask, jsonify, send_from_directory, request

app = Flask(__name__, static_folder="static", template_folder="templates")

BASE_DIR = Path("/root/.openclaw/workspace/data")

# Known symbols (display name → data dir name)
SYMBOLS = ["river", "btc", "eth", "sol", "siren", "lit", "rave", "pippin", "beat", "power"]


def load_history(symbol, hours=72):
    data_dir = BASE_DIR / symbol.lower()
    history_file = data_dir / "history_full.json"
    
    if not history_file.exists():
        return []
    
    with open(history_file) as f:
        data = json.load(f)
    
    if hours and len(data) > hours * 4:
        data = data[-(hours * 4):]
    
    return data


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/symbols")
def api_symbols():
    """Return available symbols with latest price"""
    result = []
    for sym in SYMBOLS:
        data_dir = BASE_DIR / sym
        prev_file = data_dir / "prev_row.json"
        info = {"symbol": sym, "label": sym.upper() + "/USDT"}
        if prev_file.exists():
            with open(prev_file) as f:
                d = json.load(f)
                info["price"] = d.get("price")
                info["change_pct"] = d.get("price_change_pct")
                info["has_data"] = True
        else:
            info["has_data"] = False
        result.append(info)
    return jsonify(result)


@app.route("/api/data/<int:hours>")
def api_data_hours_default(hours):
    """Legacy route - defaults to river"""
    symbol = request.args.get("symbol", "river")
    data = load_history(symbol, hours=None if hours >= 9999 else min(hours, 720))
    return jsonify(data)


@app.route("/api/data/<symbol>/<int:hours>")
def api_data_symbol_hours(symbol, hours):
    """Return data for specific symbol and hour range"""
    data = load_history(symbol, hours=None if hours >= 9999 else min(hours, 720))
    return jsonify(data)


@app.route("/api/latest/<symbol>")
def api_latest_symbol(symbol):
    """Return latest snapshot for a symbol"""
    data_dir = BASE_DIR / symbol.lower()
    prev_file = data_dir / "prev_row.json"
    if prev_file.exists():
        with open(prev_file) as f:
            return jsonify(json.load(f))
    return jsonify({})


# Legacy routes
@app.route("/api/data")
def api_data():
    return jsonify(load_history("river", hours=168))


@app.route("/api/latest")
def api_latest():
    return api_latest_symbol("river")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8899, debug=False)
