// Serves the local sample dataset at /data during `astro dev`, so pages can be
// developed without the R2 bucket. Production never uses this: /data there is
// handled by the Worker (worker/index.ts) reading the bucket binding.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { handleThermalVerifications } from "../worker/thermals-verify.ts";

export default function devData({ root = "dev-data" } = {}) {
  return {
    name: "dev-data",
    hooks: {
      "astro:server:setup": ({ server, logger }) => {
        const base = resolve(root);
        const devThermalFile = join(base, "thermal_predictions.json");
        const localThermalsFile = resolve("../thermals/data/forecast_predictions.json");
        const legacyThermalFile = resolve("../../thermal_predicion/web/static/forecast_predictions.json");

        if (!existsSync(base)) {
          logger.warn(`${root}/ not found; run \`pnpm run dev-data\` to generate the sample dataset`);
        }

        const devBucket = {
          async get(key) {
            const file = join(base, key);
            if (!existsSync(file)) return null;
            const raw = readFileSync(file, "utf8");
            return { text: async () => raw };
          },
          async put(key, value) {
            const file = join(base, key);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, value, "utf8");
          },
        };

        // Serve thermal prediction dataset at /api/forecast and /data/thermal_predictions.json
        const serveThermalForecast = (_req, res) => {
          const sourceFile = [devThermalFile, localThermalsFile, legacyThermalFile].find((f) => existsSync(f)) ?? null;
          if (!sourceFile) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"thermal forecast data not found"}');
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(readFileSync(sourceFile));
        };

        server.middlewares.use("/api/forecast", serveThermalForecast);
        server.middlewares.use("/data/thermal_predictions.json", serveThermalForecast);

        server.middlewares.use("/api/thermals", (req, res, next) => {
          const subPath = (req.url ?? "/").split("?")[0];
          if (subPath !== "/verifications" && subPath !== "/verify") {
            next();
            return;
          }
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", async () => {
            try {
              const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
              const webReq = new Request(`http://localhost/api/thermals${req.url ?? ""}`, {
                method: req.method ?? "GET",
                headers: {
                  "content-type": req.headers["content-type"] ?? "application/json",
                  "cf-connecting-ip": req.socket?.remoteAddress || "127.0.0.1",
                },
                body: req.method === "POST" ? rawBody : undefined,
              });
              const webRes = await handleThermalVerifications(webReq, devBucket);
              res.statusCode = webRes.status;
              webRes.headers.forEach((v, k) => res.setHeader(k, v));
              res.end(await webRes.text());
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // The Worker's station endpoint, answered from the sample file.
        server.middlewares.use("/api/stations", (req, res) => {
          const id = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\//, "");
          const path = join(base, "api", "stations", `${id}.json`);
          if (!/^[A-Z0-9]{3,20}$/.test(id) || !existsSync(path)) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"not found"}');
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-sample-data", "true");
          res.end(readFileSync(path));
        });
        server.middlewares.use("/data", (req, res) => {
          const path = normalize(join(base, decodeURIComponent((req.url ?? "/").split("?")[0])));
          if (!path.startsWith(base + sep) || !existsSync(path) || !statSync(path).isFile()) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end('{"error":"not found"}');
            return;
          }
          res.setHeader("content-type", path.endsWith(".gz") ? "application/gzip" : "application/json");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-sample-data", "true");
          res.end(readFileSync(path));
        });
      },
    },
  };
}
