import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError, LAUNCHES_PATH, SITES_PATH, listLaunches, saveLaunch } from "../worker/github.ts";
import { joinLaunches, type Launch } from "../src/lib/launches.ts";

const config = { token: "t0k3n", repo: "owner/repo", branch: "main" };
const sites = {
  schemaVersion: 2,
  sites: [{ slug: "cervidae-peak", name: "Cervidae Peak", latitude: 43.62332, longitude: -115.98076, timeZone: "America/Boise" }],
};
const launches = {
  schemaVersion: 1,
  launches: { "cervidae-peak": { facingDeg: 315, windArcHalfWidthDeg: 45, windMinMph: 5, windMaxMph: 15, gustMaxMph: 20, region: "Boise, ID", notes: "" } },
};
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64").replace(/(.{60})/g, "$1\n");

/** A tiny fake of the GitHub REST endpoints saveLaunch uses. */
function fakeGitHub({ refConflicts = 0 } = {}) {
  const calls: { method: string; path: string; body?: any; headers: Record<string, string> }[] = [];
  let head = "sha-head-1";
  let conflicts = refConflicts;
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const path = url.replace("https://api.github.com/repos/owner/repo", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, headers: init.headers });
    const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
    if (init.method === "GET" && path === "/git/ref/heads/main") return ok({ object: { sha: head } });
    if (init.method === "GET" && path === `/contents/${SITES_PATH}?ref=${head}`) return ok({ content: encode(sites) });
    if (init.method === "GET" && path === `/contents/${LAUNCHES_PATH}?ref=${head}`) return ok({ content: encode(launches) });
    if (init.method === "GET" && path === `/git/commits/${head}`) return ok({ tree: { sha: "tree-base" } });
    if (init.method === "POST" && path === "/git/trees") return ok({ sha: "tree-new" });
    if (init.method === "POST" && path === "/git/commits") return ok({ sha: "commit-new", html_url: "https://github.com/owner/repo/commit/commit-new" });
    if (init.method === "PATCH" && path === "/git/refs/heads/main") {
      if (conflicts > 0) {
        conflicts -= 1;
        head = "sha-head-2"; // someone else pushed
        return { ok: false, status: 422, json: async () => ({}), text: async () => "Update is not a fast forward" };
      }
      return ok({});
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => `no route ${init.method} ${path}` };
  };
  return { fetchImpl, calls };
}

const newLaunch: Launch = {
  slug: "shafer-butte",
  name: "Shafer Butte",
  latitude: 43.78,
  longitude: -116.08,
  timeZone: "America/Boise",
  facingDeg: 203,
  windArcHalfWidthDeg: 45,
  windMinMph: 4,
  windMaxMph: 14,
  gustMaxMph: 18,
  region: "Boise, ID",
  notes: "",
};

test("listLaunches reads both files at the branch head", async () => {
  const { fetchImpl } = fakeGitHub();
  const result = await listLaunches(config, fetchImpl);
  assert.equal(result.headSha, "sha-head-1");
  assert.deepEqual(result.launches, joinLaunches(sites as never, launches as never));
});

test("saveLaunch writes both files in one fast-forward commit", async () => {
  const { fetchImpl, calls } = fakeGitHub();
  const result = await saveLaunch(config, fetchImpl, newLaunch, "create");
  assert.deepEqual(result, { commitSha: "commit-new", commitUrl: "https://github.com/owner/repo/commit/commit-new" });

  const tree = calls.find((c) => c.path === "/git/trees")!.body;
  assert.equal(tree.base_tree, "tree-base");
  const files = Object.fromEntries(tree.tree.map((e: { path: string; content: string }) => [e.path, JSON.parse(e.content)]));
  assert.deepEqual(files[SITES_PATH].sites.map((s: { slug: string }) => s.slug), ["cervidae-peak", "shafer-butte"]);
  assert.equal(files[LAUNCHES_PATH].launches["shafer-butte"].facingDeg, 203);
  assert.ok(tree.tree.every((e: { content: string }) => e.content.endsWith("}\n")));

  const commit = calls.find((c) => c.path === "/git/commits")!.body;
  assert.deepEqual(commit.parents, ["sha-head-1"]);
  assert.match(commit.message, /^Add launch Shafer Butte/);
  assert.equal(calls.find((c) => c.method === "PATCH")!.body.force, false);
  assert.equal(calls[0].headers.authorization, "Bearer t0k3n");
  assert.ok(calls[0].headers["user-agent"]);
});

test("saveLaunch re-reads and retries once when the branch moved", async () => {
  const { fetchImpl, calls } = fakeGitHub({ refConflicts: 1 });
  await saveLaunch(config, fetchImpl, newLaunch, "create");
  const commits = calls.filter((c) => c.path === "/git/commits");
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[1].body.parents, ["sha-head-2"]);
});

test("saveLaunch refuses a duplicate slug without writing", async () => {
  const { fetchImpl, calls } = fakeGitHub();
  const existing = joinLaunches(sites as never, launches as never)[0];
  await assert.rejects(saveLaunch(config, fetchImpl, existing, "create"), (e: unknown) => e instanceof GitHubError && e.status === 409);
  assert.ok(!calls.some((c) => c.method === "POST"));
});
