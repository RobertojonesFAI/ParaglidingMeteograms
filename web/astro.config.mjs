// @ts-check
import { defineConfig } from "astro/config";
import devData from "./integrations/dev-data.mjs";

export default defineConfig({
  // Static pages; the Worker in worker/ adds /data and /api at the edge.
  output: "static",
  // Set to the real domain once it is connected (used for canonical URLs).
  site: "https://example.com",
  trailingSlash: "ignore",
  integrations: [devData()],
  vite: {
    // Launch pages are built from ../forecasts/sites.json.
    server: { fs: { allow: [".."] } },
  },
});
