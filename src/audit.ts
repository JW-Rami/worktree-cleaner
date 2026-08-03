#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { join, resolve } from "node:path";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => CommandResult;

export type ProgressStage =
  (typeof PROGRESS_STAGES)[keyof typeof PROGRESS_STAGES];

export interface ProgressEvent {
  stage: ProgressStage;
  total?: number;
  completed?: number;
  repositoryIndex?: number;
  repositoryTotal?: number;
  repositoryRoot?: string;
}

export type ProgressHandler = (progress: ProgressEvent) => void;

export interface CliArgs {
  cwd: string;
  root: string | null;
  maxDepth: number;
  json: boolean;
  interactive: boolean;
  mergedOnly: boolean;
  noGithub: boolean;
  noChat: boolean;
  deepProcessScan: boolean;
  version?: boolean;
  help?: boolean;
}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string | null;
  detached?: boolean;
  bare?: boolean;
}

export interface LastCommit {
  date: string;
  subject: string;
}

export interface WorktreeState extends Worktree {
  head: string;
  branch: string | null;
  detached: boolean;
  dirtyCount: number | null;
  ignoredCount: number | null;
  ignoredRebuildableCount: number | null;
  ignoredUnknownCount: number | null;
  sizeKib: number | null;
  lastCommit: LastCommit;
  openProcessCount: number | null;
}

export interface PullRequest {
  number: number;
  state: string;
  title: string;
  headRefName: string;
  headRefOid: string;
  mergedAt?: string | null;
  isDraft?: boolean;
  url?: string;
  baseRefName?: string;
}

export type PullRequestKind =
  | "NO_BRANCH"
  | "MERGED_EXACT"
  | "HEAD_EXACT"
  | "AMBIGUOUS"
  | "MERGED_STALE"
  | "BRANCH_STALE"
  | "NO_PR"
  | "UNKNOWN_GITHUB";

export interface PullRequestEvidence {
  kind: PullRequestKind;
  pullRequest: PullRequest | null;
}

export interface RawChatThread {
  id?: string | null;
  sessionId?: string | null;
  name?: string | null;
  title?: string | null;
  status?: string | { type?: string | null } | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  cwd?: string | null;
}

export interface ChatThread {
  id?: string | null;
  title?: string;
  name?: string;
  status: string;
  updatedAt?: string | null;
  cwd?: string | null;
}

export type ChatKind = "UNKNOWN_CHAT" | "EXACT" | "NO_CHAT";

export interface ChatEvidence {
  kind: ChatKind;
  threads: ChatThread[];
}

export interface AuditRow extends WorktreeState {
  pr: PullRequestEvidence;
  chat: ChatEvidence;
  decision: Decision;
  marker: string;
  size: string;
  repoRoot?: string;
  repository?: string | null;
}

export interface AuditError {
  stage?: "discovery" | "audit";
  path: string;
  message: string;
}

export interface SingleAudit {
  repoRoot: string;
  repository: string | null;
  rows: AuditRow[];
}

export interface AggregateRow extends AuditRow {
  repoRoot: string;
  repository: string | null;
}

export interface AggregateAudit {
  root: string;
  repositories: SingleAudit[];
  rows: AggregateRow[];
  errors: AuditError[];
}

export type Audit = SingleAudit | AggregateAudit;

export type ChatLookup = (cwd: string) => Promise<ChatEvidence>;

export interface AuditWorktreeOptions {
  cwd?: string;
  runCommand?: CommandRunner;
  chatLookup?: ChatLookup;
  noGithub?: boolean;
  noChat?: boolean;
  deepProcessScan?: boolean;
  onProgress?: ProgressHandler;
}

export type AuditRepositoryFunction = (
  options: AuditWorktreeOptions,
) => Promise<SingleAudit>;

export interface AuditRepositoriesOptions
  extends Omit<AuditWorktreeOptions, "cwd"> {
  root?: string;
  auditRepository?: AuditRepositoryFunction;
  maxDepth?: number;
}

export type AuditRepositoriesFunction = (
  options: AuditRepositoriesOptions,
) => Promise<AggregateAudit>;

export interface RemovalTargetOptions {
  repoRoot: string;
  row: AuditRow;
  runCommand?: CommandRunner;
}

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
} as const);
const PR_STATES = Object.freeze({
  MERGED: "MERGED",
  OPEN: "OPEN",
  CLOSED: "CLOSED",
} as const);
export const DECISIONS = Object.freeze({
  REMOVE_CANDIDATE: "REMOVE_CANDIDATE",
  KEEP_MAIN: "KEEP_MAIN",
  KEEP_DIRTY: "KEEP_DIRTY",
  KEEP_ACTIVE_CHAT: "KEEP_ACTIVE_CHAT",
  REVIEW: "REVIEW",
  UNKNOWN: "UNKNOWN",
} as const);
export type Decision = (typeof DECISIONS)[keyof typeof DECISIONS];
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const MAX_PATH_DISPLAY_LENGTH = 52;
export const DEFAULT_DISCOVERY_MAX_DEPTH = 8;
const DISCOVERY_DIRECTORY_IGNORES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const DECISION_LABELS: Record<Decision, string> = Object.freeze({
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

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return property in error ? error[property as keyof typeof error] : undefined;
}

export function commandResult(
  command: string,
  args: string[],
  { cwd, timeoutMs = COMMAND_TIMEOUT_MS }: CommandOptions = {},
): CommandResult {
  try {
    return {
      status: 0,
      stdout: String(execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      })),
      stderr: "",
    };
  } catch (error) {
    const status = errorProperty(error, "status");
    const stdout = errorProperty(error, "stdout");
    const stderr = errorProperty(error, "stderr");
    const message = error instanceof Error ? error.message : undefined;
    return {
      status:
        typeof status === "number" && Number.isInteger(status) ? status : 1,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? message ?? ""),
    };
  }
}

function nonEmptyLines(value: unknown): string[] {
  return String(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function parseArgs(argv: string[] = []): CliArgs {
  const args: CliArgs = {
    cwd: process.cwd(),
    root: null,
    maxDepth: DEFAULT_DISCOVERY_MAX_DEPTH,
    json: false,
    interactive: false,
    mergedOnly: false,
    noGithub: false,
    noChat: false,
    deepProcessScan: false,
  };
  let cwdWasProvided = false;
  let rootWasProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      cwdWasProvided = true;
      args.cwd = resolve(argv[++index] ?? "");
    } else if (argument === "--root" || argument === "--repos-dir") {
      rootWasProvided = true;
      args.root = resolve(argv[++index] ?? "");
    } else if (argument === "--max-depth") {
      const value = Number.parseInt(argv[++index] ?? "", 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          "--max-depth must be a non-negative integer.",
        );
      }
      args.maxDepth = value;
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
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (cwdWasProvided && rootWasProvided) {
    throw new Error("Use either --cwd or --root, not both.");
  }
  if (args.json) {
    args.interactive = false;
  }
  return args;
}

export function parseWorktreeList(output: unknown): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;

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

function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function discoveryError(path: string, error: unknown): AuditError {
  return {
    path,
    message: error instanceof Error ? error.message : String(error),
  };
}

interface RepositoryMetadata {
  repoRoot: string;
  commonDir: string;
}

interface RepositoryCandidate {
  path: string;
  hasGitDirectory: boolean;
}

function repositoryMetadata(
  candidatePath: string,
  runCommand: CommandRunner,
): RepositoryMetadata | null {
  const topLevel = runCommand("git", [
    "-C",
    candidatePath,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (topLevel.status !== 0) return null;

  const commonDirectory = runCommand("git", [
    "-C",
    candidatePath,
    "rev-parse",
    "--git-common-dir",
  ]);
  const repoRoot = safeRealPath(topLevel.stdout.trim());
  const commonDir =
    commonDirectory.status === 0 && commonDirectory.stdout.trim().length > 0
      ? safeRealPath(resolve(candidatePath, commonDirectory.stdout.trim()))
      : repoRoot;
  return { repoRoot, commonDir };
}

export function discoverRepositoryRoots(
  root: string,
  {
    runCommand = commandResult,
    maxDepth = DEFAULT_DISCOVERY_MAX_DEPTH,
  }: { runCommand?: CommandRunner; maxDepth?: number } = {},
): { root: string; roots: string[]; errors: AuditError[] } {
  const absoluteRoot = safeRealPath(root);
  if (!existsSync(absoluteRoot)) {
    throw new Error(`Root directory does not exist: ${absoluteRoot}`);
  }
  if (!lstatSync(absoluteRoot).isDirectory()) {
    throw new Error(`Root path must be a directory: ${absoluteRoot}`);
  }

  const candidates: RepositoryCandidate[] = [];
  const errors: AuditError[] = [];
  const visitedDirectories = new Set<string>();
  const walk = (directory: string, depth: number): void => {
    const realDirectory = safeRealPath(directory);
    if (visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);

    const gitMarker = join(realDirectory, ".git");
    try {
      const markerStat = lstatSync(gitMarker);
      if (markerStat.isDirectory() || markerStat.isFile()) {
        candidates.push({
          path: realDirectory,
          hasGitDirectory: markerStat.isDirectory(),
        });
      }
    } catch (error) {
      if (errorProperty(error, "code") !== "ENOENT")
        errors.push(discoveryError(gitMarker, error));
    }

    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(realDirectory, { withFileTypes: true }) as Dirent[];
    } catch (error) {
      errors.push(discoveryError(realDirectory, error));
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        DISCOVERY_DIRECTORY_IGNORES.has(entry.name)
      ) {
        continue;
      }
      walk(join(realDirectory, entry.name), depth + 1);
    }
  };

  walk(absoluteRoot, 0);
  const repositoriesByCommonDirectory = new Map<
    string,
    RepositoryMetadata & { hasGitDirectory: boolean }
  >();
  for (const candidate of candidates.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const metadata = repositoryMetadata(candidate.path, runCommand);
    if (!metadata) {
      errors.push({
        path: candidate.path,
        message: "The Git marker could not be resolved to a repository.",
      });
      continue;
    }
    const key = metadata.commonDir;
    const current = repositoriesByCommonDirectory.get(key);
    if (!current || (candidate.hasGitDirectory && !current.hasGitDirectory)) {
      repositoriesByCommonDirectory.set(key, {
        ...metadata,
        hasGitDirectory: candidate.hasGitDirectory,
      });
    }
  }

  return {
    root: absoluteRoot,
    roots: [...repositoriesByCommonDirectory.values()]
      .map(({ repoRoot }) => repoRoot)
      .sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

function scanProcessCwds(
  runCommand: CommandRunner,
): Map<string, Set<string>> | null {
  const result = runCommand("lsof", ["-F", "pn", "-a", "-d", "cwd"]);
  if (result.status === 127 || result.stderr.includes("not found")) return null;
  if (result.status !== 0 && result.stderr.trim().length > 0) return null;
  const processPaths = new Map<string, Set<string>>();
  let pid: string | null = null;
  for (const line of nonEmptyLines(result.stdout)) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) {
      const path = line.slice(1);
      const pids = processPaths.get(path);
      if (pids) pids.add(pid);
      else processPaths.set(path, new Set([pid]));
    }
  }
  return processPaths;
}

function processCountForPath(
  processPaths: Map<string, Set<string>> | null,
  path: string,
): number | null {
  if (!processPaths) return null;
  const pids = new Set();
  for (const [cwd, cwdPids] of processPaths) {
    if (cwd === path || cwd.startsWith(`${path}/`)) {
      for (const pid of cwdPids) pids.add(pid);
    }
  }
  return pids.size;
}

function countStatusEntries(output: unknown): number {
  return nonEmptyLines(output).length;
}

function ignoredPathIsRebuildable(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return segments.some((segment) => REBUILDABLE_IGNORED_NAMES.has(segment));
}

function ignoredDetails(output: unknown): {
  count: number;
  rebuildableCount: number;
  unknownCount: number;
} {
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

function parseLastCommit(output: unknown): LastCommit {
  const [date = "", subject = ""] = String(output).trim().split("\t");
  return { date, subject };
}

function parseSize(output: unknown): number | null {
  const value = Number.parseInt(
    String(output).trim().split(/\s+/u)[0] ?? "",
    10,
  );
  return Number.isFinite(value) ? value : null;
}

function countOpenProcesses(result: CommandResult): number | null {
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
  worktree: Worktree,
  {
    runCommand = commandResult,
    openProcessCount = null,
    deepProcessScan = false,
    sizeKib,
  }: {
    runCommand?: CommandRunner;
    openProcessCount?: number | null;
    deepProcessScan?: boolean;
    sizeKib?: number | null;
  } = {},
): WorktreeState {
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
    worktree.head ?? "",
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
    head: worktree.head ?? "",
    branch: worktree.branch ?? null,
    detached: worktree.detached ?? false,
    dirtyCount: status.status === 0 ? countStatusEntries(status.stdout) : null,
    ignoredCount: ignoredState?.count ?? null,
    ignoredRebuildableCount: ignoredState?.rebuildableCount ?? null,
    ignoredUnknownCount: ignoredState?.unknownCount ?? null,
    sizeKib: sizeKib === undefined ? parseSize(size?.stdout ?? "") : sizeKib,
    lastCommit: parseLastCommit(lastCommit.stdout),
    openProcessCount: deepProcessScan
      ? openFiles
        ? countOpenProcesses(openFiles)
        : null
      : openProcessCount,
  };
}

export function measureWorktreeSizes(
  worktrees: Worktree[],
  runCommand: CommandRunner,
  onProgress: ProgressHandler = () => {},
): Map<string, number> {
  const existingWorktrees = worktrees.filter((worktree) =>
    existsSync(worktree.path),
  );
  if (existingWorktrees.length === 0) return new Map();
  const sizes = new Map<string, number>();
  const parseResult = (result: CommandResult): void => {
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

export function repositoryFromRemote(remoteUrl: string): string | null {
  const normalized = String(remoteUrl)
    .trim()
    .replace(/^git@[^:]+:/u, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/")
    .replace(/\.git$/u, "");
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/u);
  return match?.[1] ?? null;
}

function getRepositorySlug(
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

function loadPullRequests(
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

function queryPullRequest(
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

export function groupChatThreadsByCwd(
  paths: string[],
  chatResult: ChatEvidence,
): Map<string, ChatEvidence> {
  const chatsByPath = new Map<string, ChatEvidence>();
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

function statusType(
  status: string | { type?: string | null } | null | undefined,
): string | null {
  return typeof status === "string" ? status : (status?.type ?? null);
}

function isActiveChat(thread: ChatThread): boolean {
  return statusType(thread.status) === ACTIVE_CHAT_STATUS;
}

function normalizeChatThreads(threads: RawChatThread[]): ChatThread[] {
  return threads.map((thread) => ({
    id: thread.id ?? thread.sessionId ?? null,
    title: thread.name ?? thread.title ?? "(untitled)",
    status: statusType(thread.status) ?? "unknown",
    updatedAt: thread.updatedAt ?? thread.updated_at ?? null,
    cwd: thread.cwd ?? null,
  }));
}

function parseProtocolLines(buffer: string): {
  complete: string[];
  remainder: string;
} {
  const lines = buffer.split("\n");
  return { complete: lines.slice(0, -1), remainder: lines.at(-1) ?? "" };
}

interface ProtocolResult {
  data?: RawChatThread[];
  nextCursor?: string | null;
}

interface ProtocolMessage {
  id?: number;
  result?: ProtocolResult | null;
  error?: unknown;
}

export function createCodexChatLookup({
  spawnImpl = spawn,
  timeoutMs = CHAT_QUERY_TIMEOUT_MS,
}: { spawnImpl?: typeof spawn; timeoutMs?: number } = {}): ChatLookup {
  return function lookup(cwd: string): Promise<ChatEvidence> {
    return new Promise<ChatEvidence>((resolveLookup) => {
      const child = spawnImpl("codex", ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      let finished = false;
      let requestId = INITIAL_REQUEST_ID;
      let threads: RawChatThread[] = [];
      let cursor: string | null = null;
      let archiveIndex = 0;
      const archiveFilters = [null, true];

      const finish = (result: ChatEvidence): void => {
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
      const write = (message: unknown): void => {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      };
      const sendList = (): number => {
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

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const parsed = parseProtocolLines(buffer);
        buffer = parsed.remainder;
        for (const line of parsed.complete) {
          if (!line.trim()) continue;
          let message: ProtocolMessage;
          try {
            message = JSON.parse(line) as ProtocolMessage;
          } catch {
            continue;
          }
          if (message.id === 1) {
            write({ method: "initialized", params: {} });
            sendList();
          } else if (message.id !== undefined && message.id >= 2) {
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

function chatDecision(chat: ChatEvidence): { kind: string; active: boolean } {
  if (chat.kind === "UNKNOWN_CHAT") return { kind: "UNKNOWN", active: false };
  if (chat.threads.some(isActiveChat)) return { kind: "ACTIVE", active: true };
  return { kind: chat.kind, active: false };
}

function decisionFor({
  isMain,
  state,
  pr,
  chat,
}: {
  isMain: boolean;
  state: WorktreeState;
  pr: PullRequestEvidence;
  chat: ChatEvidence;
}): Decision {
  if (isMain) return DECISIONS.KEEP_MAIN;
  if (state.dirtyCount !== null && state.dirtyCount > 0)
    return DECISIONS.KEEP_DIRTY;
  if (state.openProcessCount === null || state.openProcessCount > 0)
    return DECISIONS.REVIEW;
  if (state.ignoredUnknownCount !== null && state.ignoredUnknownCount > 0)
    return DECISIONS.REVIEW;
  if (chatDecision(chat).active) return DECISIONS.KEEP_ACTIVE_CHAT;
  if (pr.kind === "MERGED_EXACT" && chat.kind === "EXACT")
    return DECISIONS.REMOVE_CANDIDATE;
  if (pr.kind === "UNKNOWN_GITHUB" || chat.kind === "UNKNOWN_CHAT")
    return DECISIONS.UNKNOWN;
  return DECISIONS.REVIEW;
}

function formatGib(sizeKib: number | null): string {
  if (sizeKib === null) return "?";
  return `${(sizeKib / KIB_PER_GIB).toFixed(2)} GiB`;
}

function markerFor(decision: Decision): string {
  if (decision === DECISIONS.REMOVE_CANDIDATE) return "🟢";
  if (decision === DECISIONS.REVIEW) return "🟡";
  if (decision === DECISIONS.UNKNOWN) return "⚪";
  return "🔴";
}

export function buildAuditRow({
  state,
  pr,
  chat,
  mainPath,
}: {
  state: WorktreeState;
  pr: PullRequestEvidence;
  chat: ChatEvidence;
  mainPath: string;
}): AuditRow {
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
}: AuditWorktreeOptions = {}): Promise<SingleAudit> {
  const rootResult = runCommand("git", [
    "-C",
    cwd,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (rootResult.status !== 0)
    throw new Error("The current directory is not a Git repository.");
  const repoRoot = rootResult.stdout.trim();
  const listResult = runCommand("git", [
    "-C",
    repoRoot,
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (listResult.status !== 0)
    throw new Error("Unable to list Git worktrees.");
  const worktrees = parseWorktreeList(listResult.stdout);
  onProgress({ stage: PROGRESS_STAGES.WORKTREES, total: worktrees.length });
  const repository = noGithub ? null : getRepositorySlug(repoRoot, runCommand);
  const lookup: ChatLookup = noChat
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
  const chatResults: ChatEvidence[] = await Promise.all(
    worktrees.map((worktree) => lookup(worktree.path)),
  );
  const chatResult: ChatEvidence = {
    kind: chatResults.some((result) => result.kind === "UNKNOWN_CHAT")
      ? "UNKNOWN_CHAT"
      : "EXACT",
    threads: chatResults.flatMap((result) => result.threads ?? []),
  };
  const chatsByPath = groupChatThreadsByCwd(
    worktrees.map((worktree) => worktree.path),
    chatResult,
  );
  const rows: AuditRow[] = [];

  for (const worktree of worktrees) {
    if (!existsSync(worktree.path)) {
      rows.push(
        buildAuditRow({
          state: {
            ...worktree,
            head: worktree.head ?? "",
            branch: worktree.branch ?? null,
            detached: worktree.detached ?? false,
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
    const pr: PullRequestEvidence = noGithub
      ? { kind: "UNKNOWN_GITHUB", pullRequest: null }
      : queryPullRequest(state, repository, pullRequests);
    const chat: ChatEvidence = chatsByPath.get(state.path) ?? {
      kind: "UNKNOWN_CHAT",
      threads: [],
    };
    rows.push(buildAuditRow({ state, pr, chat, mainPath: repoRoot }));
  }

  return { repoRoot, repository, rows };
}

export async function auditRepositories({
  root = process.cwd(),
  runCommand = commandResult,
  auditRepository = auditWorktrees,
  maxDepth = DEFAULT_DISCOVERY_MAX_DEPTH,
  chatLookup,
  noGithub = false,
  noChat = false,
  deepProcessScan = false,
  onProgress = () => {},
}: AuditRepositoriesOptions = {}): Promise<AggregateAudit> {
  const discovery = discoverRepositoryRoots(root, { runCommand, maxDepth });
  const repositories: SingleAudit[] = [];
  const errors: AuditError[] = discovery.errors.map((error) => ({
    stage: "discovery",
    ...error,
  }));

  for (let index = 0; index < discovery.roots.length; index += 1) {
    const repoRoot = discovery.roots[index];
    try {
      const audit = await auditRepository({
        cwd: repoRoot,
        runCommand,
        chatLookup,
        noGithub,
        noChat,
        deepProcessScan,
        onProgress: (progress) =>
          onProgress({
            ...progress,
            repositoryIndex: index + 1,
            repositoryTotal: discovery.roots.length,
            repositoryRoot: repoRoot,
          }),
      });
      repositories.push(audit);
    } catch (error) {
      errors.push({
        stage: "audit",
        path: repoRoot,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rows: AggregateRow[] = repositories.flatMap((audit) =>
    audit.rows.map((row) => ({
      ...row,
      repoRoot: audit.repoRoot,
      repository: audit.repository,
    })),
  );
  return { root: discovery.root, repositories, rows, errors };
}

export function defaultSelection(rows: AuditRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.decision === DECISIONS.REMOVE_CANDIDATE)
      .map((row) => row.path),
  );
}

export function removeWorktree({
  repoRoot,
  path,
  runCommand = commandResult,
}: {
  repoRoot: string;
  path: string;
  runCommand?: CommandRunner;
}): CommandResult {
  return runCommand("git", ["-C", repoRoot, "worktree", "remove", "--", path]);
}

export function verifyRemovalTarget({
  repoRoot,
  row,
  runCommand = commandResult,
}: RemovalTargetOptions): boolean {
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

function colorize(value: string, color: "bold", enabled: boolean): string {
  return enabled && color === "bold"
    ? `${ANSI_BOLD}${value}${ANSI_RESET}`
    : value;
}

function shortenText(value: unknown, maxLength: number): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = maxLength - 1 - prefixLength;
  return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
}

function decisionLabel(decision: Decision): string {
  return DECISION_LABELS[decision] ?? decision;
}

function pullRequestLabel(row: AuditRow): string {
  return row.pr.pullRequest
    ? `PR #${row.pr.pullRequest.number} ${row.pr.pullRequest.state}`
    : row.pr.kind;
}

function chatLabel(row: AuditRow): string {
  const chat = row.chat.threads[0];
  return chat ? `${chat.title} [${chat.status}]` : `chat ${row.chat.kind}`;
}

function auditSummary(rows: AuditRow[]): string {
  const counts = rows.reduce<Record<string, number>>((summary, row) => {
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

function compactAuditLine(row: AuditRow): string {
  const repositoryLabel = row.repository ?? row.repoRoot;
  const scope = repositoryLabel ? `[${shortenText(repositoryLabel, 28)}] ` : "";
  return `${row.marker} ${row.size.padStart(9)} ${decisionLabel(row.decision).padEnd(7)} ${scope}${shortenText(row.path, MAX_PATH_DISPLAY_LENGTH)} · ${shortenText(pullRequestLabel(row), 22)} · 💬 ${shortenText(chatLabel(row), 28)} · dirty=${row.dirtyCount ?? "?"} open=${row.openProcessCount ?? "?"}`;
}

export function renderAudit(
  audit: Audit,
  { color = Boolean(process.stdout.isTTY) }: { color?: boolean } = {},
): string {
  const title = "root" in audit
    ? `workspace: ${audit.root}`
    : (audit.repository ?? "local Git repository");
  const lines = [
    colorize(`\n💾 Worktree audit: ${title}`, "bold", color),
    auditSummary(audit.rows),
    "",
  ];
  for (const row of audit.rows) {
    lines.push(compactAuditLine(row));
  }
  lines.push(
    "",
    "🟢 SAFE | 🟡 REVIEW | 🔴 KEEP | ⚪ UNKNOWN · --json keeps all details",
  );
  if ("errors" in audit && audit.errors.length > 0) {
    lines.push(
      "",
      `⚠️ ${audit.errors.length} discovery or audit error(s):`,
      ...audit.errors.map((error) => `- ${error.path}: ${error.message}`),
    );
  }
  return lines.join("\n");
}
