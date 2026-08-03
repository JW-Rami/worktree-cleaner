import {
  type CommandResult,
  type CommandRunner,
  type PullRequest,
  type PullRequestEvidence,
  type WorktreeState,
} from "./domain.js";

const DEFAULT_GH_LIMIT = 100;
const PR_STATES = Object.freeze({
  MERGED: "MERGED",
  OPEN: "OPEN",
  CLOSED: "CLOSED",
} as const);

export function repositoryFromRemote(remoteUrl: string): string | null {
  const normalized = String(remoteUrl)
    .trim()
    .replace(/^git@[^:]+:/u, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/")
    .replace(/\.git$/u, "");
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/u);
  return match?.[1] ?? null;
}

export function getRepositorySlug(
  repoRoot: string,
  runCommand: CommandRunner,
): string | null {
  const remote = runCommand("git", [
    "-C",
    repoRoot,
    "remote",
    "get-url",
    "origin",
  ]);
  return remote.status === 0 ? repositoryFromRemote(remote.stdout) : null;
}

function parseJsonOutput(result: CommandResult): unknown {
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function matchPullRequest({
  branch,
  head,
  pullRequests,
}: {
  branch: string | null;
  head: string;
  pullRequests: PullRequest[];
}): PullRequestEvidence {
  if (!branch) return { kind: "NO_BRANCH", pullRequest: null };
  const branchMatches = pullRequests.filter(
    (pullRequest) => pullRequest.headRefName === branch,
  );
  const headMatches = branchMatches.filter(
    (pullRequest) => pullRequest.headRefOid === head,
  );

  if (headMatches.length === 1) {
    const pullRequest = headMatches[0];
    return {
      kind:
        pullRequest.state === PR_STATES.MERGED ? "MERGED_EXACT" : "HEAD_EXACT",
      pullRequest,
    };
  }
  if (headMatches.length > 1) return { kind: "AMBIGUOUS", pullRequest: null };
  if (branchMatches.length > 0) {
    return {
      kind: branchMatches.some(
        (pullRequest) => pullRequest.state === PR_STATES.MERGED,
      )
        ? "MERGED_STALE"
        : "BRANCH_STALE",
      pullRequest: branchMatches.length === 1 ? branchMatches[0] : null,
    };
  }
  return { kind: "NO_PR", pullRequest: null };
}

export function loadPullRequests(
  repository: string | null,
  runCommand: CommandRunner,
): PullRequest[] | null {
  if (!repository) return null;
  const result = runCommand("gh", [
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "all",
    "--limit",
    String(DEFAULT_GH_LIMIT * 10),
    "--json",
    "number,state,title,headRefName,headRefOid,mergedAt,isDraft,url,baseRefName",
  ]);
  const pullRequests = parseJsonOutput(result);
  return Array.isArray(pullRequests) ? (pullRequests as PullRequest[]) : null;
}

export function queryPullRequest(
  worktree: WorktreeState,
  repository: string | null,
  pullRequests: PullRequest[] | null,
): PullRequestEvidence {
  if (!repository || pullRequests === null)
    return { kind: "UNKNOWN_GITHUB", pullRequest: null };
  if (!worktree.branch) return { kind: "NO_BRANCH", pullRequest: null };
  return matchPullRequest({
    branch: worktree.branch,
    head: worktree.head,
    pullRequests,
  });
}
