type GitHubSource = { owner: string; repository: string; pullNumber?: number };

type GitTreeEntry = { path: string; type: string; sha: string; size?: number };

function githubHeaders(accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DiffSense",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

export function parseGitHubSource(value: string): GitHubSource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid GitHub repository or pull request URL.");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only github.com repository and pull request URLs are supported.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("The URL must include an owner and repository.");
  const [owner, repositoryName, marker, pullNumber] = parts;
  const repository = repositoryName.replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)) {
    throw new Error("The GitHub URL contains an invalid owner or repository name.");
  }
  if (marker !== undefined && (marker !== "pull" || !/^\d+$/.test(pullNumber ?? ""))) {
    throw new Error("Use a repository URL or a GitHub pull request URL.");
  }
  return { owner, repository, ...(pullNumber ? { pullNumber: Number(pullNumber) } : {}) };
}

async function githubFetch(url: string, accept?: string) {
  const response = await fetch(url, { headers: githubHeaders(accept), cache: "no-store" });
  if (!response.ok) {
    if (response.status === 404) throw new Error("GitHub could not find that repository or pull request.");
    if (response.status === 401 || response.status === 403) {
      throw new Error("GitHub denied access. Add a GITHUB_TOKEN for private repositories or rate-limited requests.");
    }
    throw new Error(`GitHub request failed (${response.status}).`);
  }
  return response;
}

export async function getPullRequestDiff(source: GitHubSource) {
  if (!source.pullNumber) throw new Error("A pull request URL is required to fetch a diff.");
  const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/pulls/${source.pullNumber}`;
  const response = await githubFetch(url, "application/vnd.github.diff");
  const diff = await response.text();
  if (!diff.trim()) throw new Error("The pull request has no diff to review.");
  if (diff.length > 500_000) throw new Error("This diff is larger than the 500 KB review limit.");
  return diff;
}

/**
 * The pull request's merge-base: the commit its diff applies to. Reviews read repository context and full changed files at
 * this pre-change commit, matching how the benchmark was measured.
 */
export async function getPullRequestMergeBase(source: GitHubSource) {
  if (!source.pullNumber) throw new Error("A pull request URL is required to resolve its merge-base.");
  const repo = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`;
  const pullRequest = (await (await githubFetch(`${repo}/pulls/${source.pullNumber}`)).json()) as { base: { sha: string }; head: { sha: string } };
  const comparison = (await (await githubFetch(`${repo}/compare/${pullRequest.base.sha}...${pullRequest.head.sha}`)).json()) as { merge_base_commit: { sha: string } };
  return comparison.merge_base_commit.sha;
}

export async function getRepositoryTree(owner: string, repository: string, ref?: string) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepository = encodeURIComponent(repository);
  const repoResponse = await githubFetch(`https://api.github.com/repos/${encodedOwner}/${encodedRepository}`);
  const repo = (await repoResponse.json()) as { default_branch: string };
  const branch = ref || repo.default_branch;
  const commitResponse = await githubFetch(
    `https://api.github.com/repos/${encodedOwner}/${encodedRepository}/commits/${encodeURIComponent(branch)}`,
  );
  const commit = (await commitResponse.json()) as { sha: string };
  const treeResponse = await githubFetch(
    `https://api.github.com/repos/${encodedOwner}/${encodedRepository}/git/trees/${commit.sha}?recursive=1`,
  );
  const tree = (await treeResponse.json()) as { sha: string; truncated?: boolean; tree: GitTreeEntry[] };
  if (tree.truncated) throw new Error("GitHub truncated this repository tree; index a smaller repository or branch.");
  return { commitSha: commit.sha, branch, entries: tree.tree };
}

export async function getRawRepositoryFile(owner: string, repository: string, commitSha: string, path: string) {
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${commitSha}/${safePath}`;
  const response = await fetch(url, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not fetch ${path} from GitHub.`);
  return response.text();
}
