import http from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.PROXY_SECRET;
if (!SECRET) {
	console.error("PROXY_SECRET env var is required");
	process.exit(1);
}

const ROUTES = {
	"/host-fapi": "https://fapi.binance.com",
	"/host-www": "https://www.binance.com",
	"/host-web3": "https://web3.binance.com",
};

function resolveUpstream(reqUrl) {
	for (const [prefix, host] of Object.entries(ROUTES)) {
		if (reqUrl === prefix || reqUrl.startsWith(prefix + "/")) {
			return host + reqUrl.slice(prefix.length);
		}
	}
	return null;
}

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const PASS_THROUGH = new Set([
	"clienttype",
	"referer",
	"accept-encoding",
	"accept-language",
]);

http
	.createServer(async (req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("ok");
			return;
		}

		if (req.headers["x-proxy-token"] !== SECRET) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("forbidden");
			return;
		}

		const upstream = resolveUpstream(req.url ?? "/");
		if (!upstream) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end(`no route for ${req.url}`);
			return;
		}

		const fwdHeaders = {
			"User-Agent": UA,
			Accept: "*/*",
		};
		for (const [k, v] of Object.entries(req.headers)) {
			const lk = k.toLowerCase();
			if (PASS_THROUGH.has(lk)) fwdHeaders[k] = v;
		}

		try {
			const upstreamRes = await fetch(upstream, {
				method: req.method,
				headers: fwdHeaders,
				redirect: "manual",
			});
			const buf = Buffer.from(await upstreamRes.arrayBuffer());
			// fetch() already decompressed the body, so the upstream's
			// content-encoding no longer describes what we are sending — and
			// neither does its content-length, which counts the *compressed*
			// bytes. Forwarding that length makes Node truncate the decoded body
			// to it: web3.binance.com answers gzipped with content-length 1359
			// for 3496 bytes of JSON, so the Worker received 1359 bytes and died
			// on "Unterminated string in JSON at position 1349". fapi answers
			// chunked (no content-length), which is why only the web3 endpoint
			// ever broke. Drop all three and let res.end() set the real length.
			const outHeaders = {};
			upstreamRes.headers.forEach((v, k) => {
				const lk = k.toLowerCase();
				if (
					lk === "content-encoding" ||
					lk === "transfer-encoding" ||
					lk === "content-length"
				)
					return;
				outHeaders[k] = v;
			});
			res.writeHead(upstreamRes.status, outHeaders);
			res.end(buf);
			console.log(
				`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${upstreamRes.status} (${buf.length}b)`,
			);
		} catch (e) {
			console.error(`[${new Date().toISOString()}] ${req.url} failed:`, e);
			res.writeHead(502, { "content-type": "text/plain" });
			res.end(String(e));
		}
	})
	.listen(PORT, "127.0.0.1", () => {
		console.log(`proxy listening on 127.0.0.1:${PORT}`);
		console.log(`routes: ${Object.keys(ROUTES).join(", ")}`);
	});
