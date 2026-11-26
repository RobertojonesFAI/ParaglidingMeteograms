// Serves the local sample dataset at /data during `astro dev`, so pages can be
// developed without the R2 bucket. Production never uses this: /data there is
// handled by the Worker (worker/index.ts) reading the bucket binding.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { handleThermalVerifications } from "../worker/thermals-verify.ts";

// Pilot thermal reports, kept in memory for the dev server's lifetime.
function memoryBucket() {
  const store = new Map();
  return {
    async put(key, _value, options) {
      store.set(key, options?.customMetadata);
    },
    async list({ prefix }) {
      const objects = [...store].filter(([key]) => key.startsWith(prefix)).map(([key, customMetadata]) => ({ key, customMetadata }));
      return { objects, truncated: false };
    },
  };
}

export default function devData({ root = "dev-data" } = {}) {
  return {
    name: "dev-data",
    hooks: {
      "astro:server:setup": ({ server, logger }) => {
        const base = resolve(root);
        if (!existsSync(base)) {
          logger.warn(`${root}/ not found; run \`pnpm run dev-data\` to generate the sample dataset`);
        }
        // The Worker's thermal report endpoints, with a throwaway secret.
        const reports = memoryBucket();
        server.middlewares.use("/api/thermals", async (req, res, next) => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const request = new Request(`http://localhost/api/thermals${req.url ?? ""}`, {
            method: req.method,
            headers: { "content-type": "application/json", "cf-connecting-ip": req.socket.remoteAddress ?? "127.0.0.1" },
            body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
          });
          const response = await handleThermalVerifications(request, reports, { secret: "dev-only-secret" }).catch(next);
          if (!response) return;
          res.statusCode = response.status;
          response.headers.forEach((value, name) => res.setHeader(name, value));
          res.end(await response.text());
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
