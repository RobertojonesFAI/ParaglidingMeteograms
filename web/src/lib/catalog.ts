// Build-time launch catalogue: joins the engine's site catalogue with the
// website's launch details. Imported only by .astro pages (never shipped to
// the browser as a module).

import sitesFile from "../../../forecasts/sites.json";
import launchesFile from "../data/launches.json";
import { consistencyErrors, joinLaunches, type LaunchesFile, type SitesFile, type Launch } from "./launches.ts";

const sites = sitesFile as SitesFile;
const details = launchesFile as LaunchesFile;

const problems = consistencyErrors(sites, details);
if (problems.length > 0) throw new Error(`launch files are inconsistent: ${problems.join("; ")}`);

export const launches: Launch[] = joinLaunches(sites, details);
