#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const COMMAND_TIMEOUT_MS = 10_000;
const CHAT_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_GH_LIMIT = 100;
const SIZE_BATCH_SIZE = 12;
const KIB_PER_GIB = 1024 * 1024;
const INITIAL_REQUEST_ID = 1;
const THREAD_LIST_LIMIT = 100;
const ACTIVE_CHAT_STATUS = "active";
export const PROGRESS_STAGES = Object.freeze({
  WORKTREES: "worktrees",
  PROCESSES: "processes",
  SIZES: "sizes",
  GITHUB: "github",
  CHATS: "chats",
});
const PR_STATES = Object.freeze({
  MERGED: "MERGED",
  OPEN: "OPEN",
  CLOSED: "CLOSED",
});
export const DECISIONS = Object.freeze({
  REMOVE_CANDIDATE: "REMOVE_CANDIDATE",
  KEEP_MAIN: "KEEP_MAIN",
  KEEP_DIRTY: "KEEP_DIRTY",
  KEEP_ACTIVE_CHAT: "KEEP_ACTIVE_CHAT",
  REVIEW: "REVIEW",
  UNKNOWN: "UNKNOWN",
});
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const MAX_PATH_DISPLAY_LENGTH = 52;
const DECISION_LABELS = Object.freeze({
  [DECISIONS.REMOVE_CANDIDATE]: "SAFE",
  [DECISIONS.KEEP_MAIN]: "MAIN",
  [DECISIONS.KEEP_DIRTY]: "DIRTY",
  [DECISIONS.KEEP_ACTIVE_CHAT]: "ACTIVE",
  [DECISIONS.REVIEW]: "REVIEW",
  [DECISIONS.UNKNOWN]: "UNKNOWN",
});
const REBUILDABLE_IGNORED_NAMES = new Set([
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "target",
  "test-results",
]);

export function commandResult(
  command,
  args,
  { cwd, timeoutMs = COMMAND_TIMEOUT_MS } = {},
) {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      status: Number.isInteger(error.status) ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

function nonEmptyLines(value) {
  return String(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function parseArgs(argv = []) {
  const args = {
    cwd: process.cwd(),
    json: false,
    interactive: false,
    mergedOnly: false,
    noGithub: false,
    noChat: false,
    deepProcessScan: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      args.cwd = resolve(argv[++index] ?? "");
    } else if (argument === "--json") {
      args.json = true;
    } else if (argument === "--interactive" || argument === "-i") {
      args.interactive = true;
    } else if (argument === "--merged-only") {
      args.mergedOnly = true;
    } else if (argument === "--no-github") {
      args.noGithub = true;
    } else if (argument === "--no-chat") {
      args.noChat = true;
    } else if (argument === "--deep-process-scan") {
      args.deepProcessScan = true;
    } else if (argument === "--version") {
      args.version = true;
    } else if (argument === "--help" || argument === "-h") {
      args.help = true;
    } else {
      throw new Error(`Argument inconnu: ${argument}`);
    }
  }

  if (args.json) {
    args.interactive = false;
  }
  return args;
}

export function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;

  for (const line of nonEmptyLines(output)) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        detached: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const branchRef = line.slice("branch ".length);
      current.branch = branchRef.replace(/^refs\/heads\//u, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    }
  }

  if (current) worktrees.push(current);
  return worktrees.filter((worktree) => !worktree.bare);
}

function scanProcessCwds(runCommand) {
  const result = runCommand("lsof", ["-F", "pn", "-a", "-d", "cwd"]);
  if (result.status === 127 || result.stderr.includes("not found")) return null;
  if (result.status !== 0 && result.stderr.trim().length > 0) return null;
  const processPaths = new Map();
  let pid = null;
  for (const line of nonEmptyLines(result.stdout)) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) {
      const path = line.slice(1);
      if (!processPaths.has(path)) processPaths.set(path, new Set());
      processPaths.get(path).add(pid);
    }
  }
  return processPaths;
}

function processCountForPath(processPaths, path) {
  if (!processPaths) return null;
  const pids = new Set();
  for (const [cwd, cwdPids] of processPaths) {
    if (cwd === path || cwd.startsWith(`${path}/`)) {
      for (const pid of cwdPids) pids.add(pid);
    }
  }
  return pids.size;
}

function countStatusEntries(output) {
  return nonEmptyLines(output).length;
}

function ignoredPathIsRebuildable(path) {
  const segments = path.split("/").filter(Boolean);
  return segments.some((segment) => REBUILDABLE_IGNORED_NAMES.has(segment));
}

function ignoredDetails(output) {
  const paths = nonEmptyLines(output)
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3));
  const unknownCount = paths.filter(
    (path) => !ignoredPathIsRebuildable(path),
  ).length;
  return {
    count: paths.length,
    rebuildableCount: paths.length - unknownCount,
    unknownCount,
  };
}

function parseLastCommit(output) {
  const [date = "", subject = ""] = String(output).trim().split("\t");
  return { date, subject };
}

function parseSize(output) {
  const value = Number.parseInt(
    String(output).trim().split(/\s+/u)[0] ?? "",
    10,
  );
  return Number.isFinite(value) ? value : null;
}

function countOpenProcesses(result) {
  if (result.status === 127 || result.stderr.includes("not found")) return null;
  if (result.status !== 0 && result.stderr.trim().length > 0) return null;
  const pids = new Set(
    nonEmptyLines(result.stdout)
      .filter((line) => line.startsWith("p"))
      .map((line) => line.slice(1)),
  );
  return pids.size;
}

function collectWorktreeState(
  worktree,
  {
    runCommand = commandResult,
    openProcessCount,
    deepProcessScan = false,
    sizeKib,
  } = {},
) {
  const status = runCommand("git", [
    "-C",
    worktree.path,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const ignored = runCommand("git", [
    "-C",
    worktree.path,
    "status",
    "--porcelain=v1",
    "--ignored",
    "--untracked-files=all",
  ]);
  const lastCommit = runCommand("git", [
    "-C",
    worktree.path,
    "show",
    "-s",
    "--format=%cI%x09%s",
    worktree.head,
  ]);
  const size =
    sizeKib === undefined ? runCommand("du", ["-sk", worktree.path]) : null;
  const openFiles = deepProcessScan
    ? runCommand("lsof", ["-F", "p", "+D", worktree.path])
    : null;
  const ignoredState =
    ignored.status === 0 ? ignoredDetails(ignored.stdout) : null;

  return {
    ...worktree,
    dirtyCount: status.status === 0 ? countStatusEntries(status.stdout) : null,
    ignoredCount: ignoredState?.count ?? null,
    ignoredRebuildableCount: ignoredState?.rebuildableCount ?? null,
    ignoredUnknownCount: ignoredState?.unknownCount ?? null,
    sizeKib: sizeKib === undefined ? parseSize(size.stdout) : sizeKib,
    lastCommit: parseLastCommit(lastCommit.stdout),
    openProcessCount: deepProcessScan
      ? countOpenProcesses(openFiles)
      : openProcessCount,
  };
}

export function measureWorktreeSizes(
  worktrees,
  runCommand,
  onProgress = () => {},
) {
  const existingWorktrees = worktrees.filter((worktree) =>
    existsSync(worktree.path),
  );
  if (existingWorktrees.length === 0) return new Map();
  const sizes = new Map();
  const parseResult = (result) => {
    for (const line of nonEmptyLines(result.stdout)) {
      const match = line.match(/^(\d+)\s+(.+)$/u);
      if (match) sizes.set(match[2], Number.parseInt(match[1], 10));
    }
  };

  for (
    let index = 0;
    index < existingWorktrees.length;
    index += SIZE_BATCH_SIZE
  ) {
    const batch = existingWorktrees.slice(index, index + SIZE_BATCH_SIZE);
    const result = runCommand("du", [
      "-sk",
      ...batch.map((worktree) => worktree.path),
    ]);
    parseResult(result);
    if (result.status !== 0 && result.stdout.length === 0) {
      for (const worktree of batch) {
        parseResult(runCommand("du", ["-sk", worktree.path]));
      }
    }
    onProgress({
      stage: PROGRESS_STAGES.SIZES,
      completed: Math.min(index + batch.length, existingWorktrees.length),
      total: existingWorktrees.length,
    });
  }
  return sizes;
}

export function repositoryFromRemote(remoteUrl) {
  const normalized = String(remoteUrl)
    .trim()
    .replace(/^git@[^:]+:/u, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/")
    .replace(/\.git$/u, "");
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/u);
  return match?.[1] ?? null;
}

function getRepositorySlug(repoRoot, runCommand) {
  const remote = runCommand("git", [
    "-C",
    repoRoot,
    "remote",
    "get-url",
    "origin",
  ]);
  return remote.status === 0 ? repositoryFromRemote(remote.stdout) : null;
}

function parseJsonOutput(result) {
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function matchPullRequest({ branch, head, pullRequests }) {
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

function loadPullRequests(repository, runCommand) {
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
  return Array.isArray(pullRequests) ? pullRequests : null;
}

function queryPullRequest(worktree, repository, pullRequests) {
  if (!repository || pullRequests === null)
    return { kind: "UNKNOWN_GITHUB", pullRequest: null };
  if (!worktree.branch) return { kind: "NO_BRANCH", pullRequest: null };
  return matchPullRequest({
    branch: worktree.branch,
    head: worktree.head,
    pullRequests,
  });
}

export function groupChatThreadsByCwd(paths, chatResult) {
  const chatsByPath = new Map();
  for (const path of paths) {
    const threads =
      chatResult.threads?.filter((thread) => thread.cwd === path) ?? [];
    chatsByPath.set(path, {
      kind:
        chatResult.kind === "UNKNOWN_CHAT"
          ? "UNKNOWN_CHAT"
          : threads.length > 0
            ? "EXACT"
            : "NO_CHAT",
      threads,
    });
  }
  return chatsByPath;
}

function statusType(status) {
  return typeof status === "string" ? status : (status?.type ?? null);
}

function isActiveChat(thread) {
  return statusType(thread.status) === ACTIVE_CHAT_STATUS;
}

function normalizeChatThreads(threads) {
  return threads.map((thread) => ({
    id: thread.id ?? thread.sessionId ?? null,
    title: thread.name ?? thread.title ?? "(sans titre)",
    status: statusType(thread.status) ?? "unknown",
    updatedAt: thread.updatedAt ?? thread.updated_at ?? null,
    cwd: thread.cwd ?? null,
  }));
}

function parseProtocolLines(buffer) {
  const lines = buffer.split("\n");
  return { complete: lines.slice(0, -1), remainder: lines.at(-1) ?? "" };
}

export function createCodexChatLookup({
  spawnImpl = spawn,
  timeoutMs = CHAT_QUERY_TIMEOUT_MS,
} = {}) {
  return function lookup(cwd) {
    return new Promise((resolveLookup) => {
      const child = spawnImpl("codex", ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      let finished = false;
      let requestId = INITIAL_REQUEST_ID;
      let threads = [];
      let cursor = null;
      let archiveIndex = 0;
      const archiveFilters = [null, true];

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.stdin?.end();
        resolveLookup(result);
      };
      const timeout = setTimeout(
        () => finish({ kind: "UNKNOWN_CHAT", threads: [] }),
        timeoutMs,
      );
      const write = (message) =>
        child.stdin.write(`${JSON.stringify(message)}\n`);
      const sendList = () => {
        const id = requestId++;
        write({
          id,
          method: "thread/list",
          params: {
            cwd,
            archived: archiveFilters[archiveIndex],
            limit: THREAD_LIST_LIMIT,
            cursor,
          },
        });
        return id;
      };

      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const parsed = parseProtocolLines(buffer);
        buffer = parsed.remainder;
        for (const line of parsed.complete) {
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id === 1) {
            write({ method: "initialized", params: {} });
            sendList();
          } else if (message.id >= 2) {
            const result = message.result;
            if (!result || message.error) {
              finish({ kind: "UNKNOWN_CHAT", threads: [] });
            } else {
              threads = threads.concat(
                Array.isArray(result.data) ? result.data : [],
              );
              cursor = result.nextCursor ?? null;
              if (cursor) sendList();
              else if (archiveIndex < archiveFilters.length - 1) {
                archiveIndex += 1;
                cursor = null;
                sendList();
              } else
                finish({
                  kind: threads.length > 0 ? "EXACT" : "NO_CHAT",
                  threads: normalizeChatThreads(threads),
                });
            }
          }
        }
      });
      child.on("error", () => finish({ kind: "UNKNOWN_CHAT", threads: [] }));
      child.on("close", () =>
        finish({
          kind: threads.length > 0 ? "EXACT" : "UNKNOWN_CHAT",
          threads: normalizeChatThreads(threads),
        }),
      );
      write({
        id: INITIAL_REQUEST_ID,
        method: "initialize",
        params: {
          clientInfo: {
            name: "invisible-worktree-audit",
            version: "0.1.0",
          },
        },
      });
    });
  };
}

function chatDecision(chat) {
  if (chat.kind === "UNKNOWN_CHAT") return { kind: "UNKNOWN", active: false };
  if (chat.threads.some(isActiveChat)) return { kind: "ACTIVE", active: true };
  return { kind: chat.kind, active: false };
}

function decisionFor({ isMain, state, pr, chat }) {
  if (isMain) return DECISIONS.KEEP_MAIN;
  if (state.dirtyCount > 0) return DECISIONS.KEEP_DIRTY;
  if (state.openProcessCount === null || state.openProcessCount > 0)
    return DECISIONS.REVIEW;
  if (state.ignoredUnknownCount > 0) return DECISIONS.REVIEW;
  if (chatDecision(chat).active) return DECISIONS.KEEP_ACTIVE_CHAT;
  if (pr.kind === "MERGED_EXACT" && chat.kind === "EXACT")
    return DECISIONS.REMOVE_CANDIDATE;
  if (pr.kind === "UNKNOWN_GITHUB" || chat.kind === "UNKNOWN_CHAT")
    return DECISIONS.UNKNOWN;
  return DECISIONS.REVIEW;
}

function formatGib(sizeKib) {
  if (sizeKib === null) return "?";
  return `${(sizeKib / KIB_PER_GIB).toFixed(2)} GiB`;
}

function markerFor(decision) {
  if (decision === DECISIONS.REMOVE_CANDIDATE) return "🟢";
  if (decision === DECISIONS.REVIEW) return "🟡";
  if (decision === DECISIONS.UNKNOWN) return "⚪";
  return "🔴";
}

export function buildAuditRow({ state, pr, chat, mainPath }) {
  const isMain = state.path === mainPath;
  const decision = decisionFor({ isMain, state, pr, chat });
  return {
    ...state,
    pr,
    chat,
    decision,
    marker: markerFor(decision),
    size: formatGib(state.sizeKib),
  };
}

export async function auditWorktrees({
  cwd = process.cwd(),
  runCommand = commandResult,
  chatLookup,
  noGithub = false,
  noChat = false,
  deepProcessScan = false,
  onProgress = () => {},
} = {}) {
  const rootResult = runCommand("git", [
    "-C",
    cwd,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (rootResult.status !== 0)
    throw new Error("Le dossier courant n’est pas un dépôt Git.");
  const repoRoot = rootResult.stdout.trim();
  const listResult = runCommand("git", [
    "-C",
    repoRoot,
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (listResult.status !== 0)
    throw new Error("Impossible de lister les worktrees Git.");
  const worktrees = parseWorktreeList(listResult.stdout);
  onProgress({ stage: PROGRESS_STAGES.WORKTREES, total: worktrees.length });
  const repository = noGithub ? null : getRepositorySlug(repoRoot, runCommand);
  const lookup = noChat
    ? async () => ({ kind: "UNKNOWN_CHAT", threads: [] })
    : (chatLookup ?? createCodexChatLookup());
  onProgress({ stage: PROGRESS_STAGES.PROCESSES });
  const processPaths = deepProcessScan ? null : scanProcessCwds(runCommand);
  const sizes = measureWorktreeSizes(worktrees, runCommand, onProgress);
  onProgress({ stage: PROGRESS_STAGES.GITHUB });
  const pullRequests = noGithub
    ? null
    : loadPullRequests(repository, runCommand);
  onProgress({ stage: PROGRESS_STAGES.CHATS });
  const chatResults = await Promise.all(
    worktrees.map((worktree) => lookup(worktree.path)),
  );
  const chatResult = {
    kind: chatResults.some((result) => result.kind === "UNKNOWN_CHAT")
      ? "UNKNOWN_CHAT"
      : "EXACT",
    threads: chatResults.flatMap((result) => result.threads ?? []),
  };
  const chatsByPath = groupChatThreadsByCwd(
    worktrees.map((worktree) => worktree.path),
    chatResult,
  );
  const rows = [];

  for (const worktree of worktrees) {
    if (!existsSync(worktree.path)) {
      rows.push(
        buildAuditRow({
          state: {
            ...worktree,
            dirtyCount: null,
            ignoredCount: null,
            ignoredRebuildableCount: null,
            ignoredUnknownCount: null,
            sizeKib: null,
            lastCommit: { date: "", subject: "" },
            openProcessCount: null,
          },
          pr: { kind: "UNKNOWN_GITHUB", pullRequest: null },
          chat: chatsByPath.get(worktree.path) ?? {
            kind: "UNKNOWN_CHAT",
            threads: [],
          },
          mainPath: repoRoot,
        }),
      );
      continue;
    }
    const state = collectWorktreeState(worktree, {
      runCommand,
      deepProcessScan,
      openProcessCount: processCountForPath(processPaths, worktree.path),
      sizeKib: sizes.get(worktree.path) ?? null,
    });
    const pr = noGithub
      ? { kind: "UNKNOWN_GITHUB", pullRequest: null }
      : queryPullRequest(state, repository, pullRequests);
    const chat = chatsByPath.get(state.path) ?? {
      kind: "UNKNOWN_CHAT",
      threads: [],
    };
    rows.push(buildAuditRow({ state, pr, chat, mainPath: repoRoot }));
  }

  return { repoRoot, repository, rows };
}

export function defaultSelection(rows) {
  return new Set(
    rows
      .filter((row) => row.decision === DECISIONS.REMOVE_CANDIDATE)
      .map((row) => row.path),
  );
}

export function removeWorktree({ repoRoot, path, runCommand = commandResult }) {
  return runCommand("git", ["-C", repoRoot, "worktree", "remove", "--", path]);
}

export function verifyRemovalTarget({
  repoRoot,
  row,
  runCommand = commandResult,
}) {
  if (
    !existsSync(row.path) ||
    row.dirtyCount !== 0 ||
    row.ignoredUnknownCount !== 0
  )
    return false;
  const registered = runCommand("git", [
    "-C",
    repoRoot,
    "worktree",
    "list",
    "--porcelain",
  ]);
  const current = parseWorktreeList(registered.stdout).find(
    (worktree) => worktree.path === row.path,
  );
  if (!current || current.head !== row.head || current.branch !== row.branch)
    return false;
  const status = runCommand("git", [
    "-C",
    row.path,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.status !== 0 || status.stdout.trim().length > 0) return false;
  const openFiles = runCommand("lsof", ["-F", "p", "+D", row.path]);
  return countOpenProcesses(openFiles) === 0;
}

function colorize(value, color, enabled) {
  return enabled && color === "bold"
    ? `${ANSI_BOLD}${value}${ANSI_RESET}`
    : value;
}

function shortenText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = maxLength - 1 - prefixLength;
  return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
}

function decisionLabel(decision) {
  return DECISION_LABELS[decision] ?? decision;
}

function pullRequestLabel(row) {
  return row.pr.pullRequest
    ? `PR #${row.pr.pullRequest.number} ${row.pr.pullRequest.state}`
    : row.pr.kind;
}

function chatLabel(row) {
  const chat = row.chat.threads[0];
  return chat ? `${chat.title} [${chat.status}]` : `chat ${row.chat.kind}`;
}

function auditSummary(rows) {
  const counts = rows.reduce((summary, row) => {
    summary[decisionLabel(row.decision)] =
      (summary[decisionLabel(row.decision)] ?? 0) + 1;
    return summary;
  }, {});
  return [
    `${rows.length} worktrees`,
    `${counts.SAFE ?? 0} safe`,
    `${counts.REVIEW ?? 0} review`,
    `${counts.UNKNOWN ?? 0} unknown`,
  ].join(" · ");
}

function compactAuditLine(row) {
  return `${row.marker} ${row.size.padStart(9)} ${decisionLabel(row.decision).padEnd(7)} ${shortenText(row.path, MAX_PATH_DISPLAY_LENGTH)} · ${shortenText(pullRequestLabel(row), 22)} · 💬 ${shortenText(chatLabel(row), 28)} · dirty=${row.dirtyCount ?? "?"} open=${row.openProcessCount ?? "?"}`;
}

export function renderAudit(audit, { color = process.stdout.isTTY } = {}) {
  const lines = [
    colorize(
      `\n💾 Worktree audit: ${audit.repository ?? "dépôt Git local"}`,
      "bold",
      color,
    ),
    auditSummary(audit.rows),
    "",
  ];
  for (const row of audit.rows) {
    lines.push(compactAuditLine(row));
  }
  lines.push(
    "",
    "🟢 SAFE | 🟡 REVIEW | 🔴 KEEP | ⚪ UNKNOWN · --json conserve tous les détails",
  );
  return lines.join("\n");
}
