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
			const outHeaders = {};
			upstreamRes.headers.forEach((v, k) => {
				const lk = k.toLowerCase();
				if (lk === "content-encoding" || lk === "transfer-encoding") return;
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
