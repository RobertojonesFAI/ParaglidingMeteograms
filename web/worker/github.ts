// Saves launches by committing to the repository through the GitHub API.
//
// The admin page never writes the dataset bucket directly: it changes the two
// files the repository already treats as the source of truth, in one commit.
// That commit triggers the "Publish launches" workflow (forecasts) and the
// site rebuild (launch pages), and leaves an ordinary, revertible history.

import {
  applyLaunch,
  consistencyErrors,
  joinLaunches,
  serialize,
  type Launch,
  type LaunchesFile,
  type SitesFile,
} from "../src/lib/launches.ts";

export const SITES_PATH = "forecasts/sites.json";
export const LAUNCHES_PATH = "web/src/data/launches.json";

export interface GitHubConfig {
  token: string;
  /** "owner/name" */
  repo: string;
  branch: string;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

function client(config: GitHubConfig, fetchImpl: FetchLike) {
  return async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`https://api.github.com/repos/${config.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ParaglidingMeteograms-admin",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new GitHubError(response.status, `GitHub ${method} ${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  };
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface LaunchFiles {
  headSha: string;
  sites: SitesFile;
  launches: LaunchesFile;
}

/** Reads both launch files at the branch head. */
export async function readLaunchFiles(config: GitHubConfig, fetchImpl: FetchLike): Promise<LaunchFiles> {
  const gh = client(config, fetchImpl);
  const ref = await gh<{ object: { sha: string } }>("GET", `/git/ref/heads/${config.branch}`);
  const headSha = ref.object.sha;
  const read = async (path: string) => {
    const file = await gh<{ content: string }>("GET", `/contents/${path}?ref=${headSha}`);
    return JSON.parse(decodeBase64Utf8(file.content));
  };
  const [sites, launches] = await Promise.all([read(SITES_PATH), read(LAUNCHES_PATH)]);
  return { headSha, sites, launches };
}

export async function listLaunches(config: GitHubConfig, fetchImpl: FetchLike): Promise<{ headSha: string; launches: Launch[] }> {
  const files = await readLaunchFiles(config, fetchImpl);
  return { headSha: files.headSha, launches: joinLaunches(files.sites, files.launches) };
}

/**
 * Creates or updates one launch in a single commit on the branch. Retries once
 * if the branch moved between the read and the ref update.
 */
export async function saveLaunch(
  config: GitHubConfig,
  fetchImpl: FetchLike,
  launch: Launch,
  mode: "create" | "update",
): Promise<{ commitSha: string; commitUrl: string }> {
  const gh = client(config, fetchImpl);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const files = await readLaunchFiles(config, fetchImpl);
    const next = applyLaunch(files.sites, files.launches, launch, mode);
    if ("error" in next) throw new GitHubError(409, next.error);
    const problems = consistencyErrors(next.sites, next.launches);
    if (problems.length > 0) throw new GitHubError(409, `launch files would be inconsistent: ${problems.join("; ")}`);

    const base = await gh<{ tree: { sha: string } }>("GET", `/git/commits/${files.headSha}`);
    const tree = await gh<{ sha: string }>("POST", "/git/trees", {
      base_tree: base.tree.sha,
      tree: [
        { path: SITES_PATH, mode: "100644", type: "blob", content: serialize(next.sites) },
        { path: LAUNCHES_PATH, mode: "100644", type: "blob", content: serialize(next.launches) },
      ],
    });
    const verb = mode === "create" ? "Add" : "Update";
    const commit = await gh<{ sha: string; html_url: string }>("POST", "/git/commits", {
      message: `${verb} launch ${launch.name}\n\nSaved from the admin page.`,
      tree: tree.sha,
      parents: [files.headSha],
    });
    try {
      await gh("PATCH", `/git/refs/heads/${config.branch}`, { sha: commit.sha, force: false });
      return { commitSha: commit.sha, commitUrl: commit.html_url };
    } catch (error) {
      // 422: the branch moved (not a fast-forward). Re-read and try once more.
      if (!(error instanceof GitHubError) || error.status !== 422 || attempt === 1) throw error;
    }
  }
  throw new GitHubError(409, "the branch kept changing; try again");
}
