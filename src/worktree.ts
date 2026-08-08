import { existsSync, lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  DECISIONS,
  DEFAULT_WORKTREE_CONCURRENCY,
  MAX_WORKTREE_CONCURRENCY,
  PROGRESS_STAGES,
  type AsyncCommandRunner,
  type AuditRow,
  type CommandResult,
  type CommandRunner,
  type ProgressHandler,
  type RemovalTargetOptions,
  type Worktree,
  type WorktreeState,
} from "./domain.js";
import { commandResult, commandResultAsync, nonEmptyLines } from "./command.js";
import { mapWithConcurrency } from "./concurrency.js";
import { parseWorktreeList } from "./discovery.js";

const SIZE_BATCH_SIZE = 12;
const FILE_MTIME_CONCURRENCY = 32;
const GIT_FILE_LIST_ARGUMENTS = Object.freeze([
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
] as const);
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

interface WorktreeStateOptions {
  runCommand?: CommandRunner;
  openProcessCount?: number | null;
  deepProcessScan?: boolean;
  sizeKib?: number | null;
}

interface AsyncWorktreeStateOptions {
  runCommand?: AsyncCommandRunner;
  openProcessCount?: number | null;
  deepProcessScan?: boolean;
  sizeKib?: number | null;
}

export function scanProcessCwds(
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

export function processCountForPath(
  processPaths: Map<string, Set<string>> | null,
  path: string,
): number | null {
  if (!processPaths) return null;
  const pids = new Set<string>();
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

function parseLastCommit(output: unknown): WorktreeState["lastCommit"] {
  const [date = "", subject = ""] = String(output).trim().split("\t");
  return { date, subject };
}

function parseGitFileList(output: unknown): string[] {
  return String(output)
    .split("\0")
    .filter((path) => path.length > 0);
}

function safeWorktreeFilePath(
  worktreePath: string,
  relativePath: string,
): string | null {
  const root = resolve(worktreePath);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return null;
  }
  return candidate;
}

function formatFileTimestamp(timestampMs: number | null): string | null {
  if (timestampMs === null || !Number.isFinite(timestampMs)) return null;
  const timestamp = new Date(timestampMs);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function latestFileModificationFromPaths(
  worktreePath: string,
  paths: string[],
): string | null {
  let latestTimestampMs: number | null = null;
  for (const relativePath of paths) {
    const filePath = safeWorktreeFilePath(worktreePath, relativePath);
    if (!filePath) continue;
    try {
      const fileStat = lstatSync(filePath);
      if (!fileStat.isFile()) continue;
      latestTimestampMs = Math.max(latestTimestampMs ?? 0, fileStat.mtimeMs);
    } catch {
      continue;
    }
  }
  return formatFileTimestamp(latestTimestampMs);
}

async function latestFileModificationFromPathsAsync(
  worktreePath: string,
  paths: string[],
): Promise<string | null> {
  const timestamps = await mapWithConcurrency(
    paths,
    FILE_MTIME_CONCURRENCY,
    async (relativePath) => {
      const filePath = safeWorktreeFilePath(worktreePath, relativePath);
      if (!filePath) return null;
      try {
        const fileStat = await lstat(filePath);
        return fileStat.isFile() ? fileStat.mtimeMs : null;
      } catch {
        return null;
      }
    },
  );
  const latestTimestampMs = timestamps.reduce<number | null>(
    (latest, timestamp) =>
      timestamp === null ? latest : Math.max(latest ?? 0, timestamp),
    null,
  );
  return formatFileTimestamp(latestTimestampMs);
}

function gitFileList(
  worktreePath: string,
  runCommand: CommandRunner,
): string[] {
  const result = runCommand("git", [
    "-C",
    worktreePath,
    ...GIT_FILE_LIST_ARGUMENTS,
  ]);
  return result.status === 0 ? parseGitFileList(result.stdout) : [];
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

export function collectWorktreeState(
  worktree: Worktree,
  {
    runCommand = commandResult,
    openProcessCount = null,
    deepProcessScan = false,
    sizeKib,
  }: WorktreeStateOptions = {},
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
  const lastFileModifiedAt = latestFileModificationFromPaths(
    worktree.path,
    gitFileList(worktree.path, runCommand),
  );
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
    lastFileModifiedAt,
    openProcessCount: deepProcessScan
      ? openFiles
        ? countOpenProcesses(openFiles)
        : null
      : openProcessCount,
  };
}

export async function collectWorktreeStateAsync(
  worktree: Worktree,
  {
    runCommand = commandResultAsync,
    openProcessCount = null,
    deepProcessScan = false,
    sizeKib,
  }: AsyncWorktreeStateOptions = {},
): Promise<WorktreeState> {
  const [status, ignored, lastCommit, size, openFiles, fileList] =
    await Promise.all([
      runCommand("git", [
        "-C",
        worktree.path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      runCommand("git", [
        "-C",
        worktree.path,
        "status",
        "--porcelain=v1",
        "--ignored",
        "--untracked-files=all",
      ]),
      runCommand("git", [
        "-C",
        worktree.path,
        "show",
        "-s",
        "--format=%cI%x09%s",
        worktree.head ?? "",
      ]),
      sizeKib === undefined
        ? runCommand("du", ["-sk", worktree.path])
        : Promise.resolve(null),
      deepProcessScan
        ? runCommand("lsof", ["-F", "p", "+D", worktree.path])
        : Promise.resolve(null),
      runCommand("git", [
        "-C",
        worktree.path,
        ...GIT_FILE_LIST_ARGUMENTS,
      ]),
    ]);
  const ignoredState =
    ignored.status === 0 ? ignoredDetails(ignored.stdout) : null;
  const lastFileModifiedAt =
    fileList.status === 0
      ? await latestFileModificationFromPathsAsync(
          worktree.path,
          parseGitFileList(fileList.stdout),
        )
      : null;

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
    lastFileModifiedAt,
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

export async function measureWorktreeSizesAsync(
  worktrees: Worktree[],
  runCommand: AsyncCommandRunner = commandResultAsync,
  onProgress: ProgressHandler = () => {},
  concurrency = DEFAULT_WORKTREE_CONCURRENCY,
): Promise<Map<string, number>> {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_WORKTREE_CONCURRENCY
  ) {
    throw new Error(
      `worktree concurrency must be an integer between 1 and ${MAX_WORKTREE_CONCURRENCY}.`,
    );
  }
  const existingWorktrees = worktrees.filter((worktree) =>
    existsSync(worktree.path),
  );
  if (existingWorktrees.length === 0) return new Map();

  const batches: Worktree[][] = [];
  for (
    let index = 0;
    index < existingWorktrees.length;
    index += SIZE_BATCH_SIZE
  ) {
    batches.push(existingWorktrees.slice(index, index + SIZE_BATCH_SIZE));
  }

  let completed = 0;
  const results = await mapWithConcurrency(
    batches,
    concurrency,
    async (batch) => {
      const result = await runCommand("du", [
        "-sk",
        ...batch.map((worktree) => worktree.path),
      ]);
      if (result.status === 0 || result.stdout.length > 0) {
        completed += batch.length;
        onProgress({
          stage: PROGRESS_STAGES.SIZES,
          completed,
          total: existingWorktrees.length,
        });
        return [result];
      }

      const individualResults = await mapWithConcurrency(
        batch,
        concurrency,
        (worktree) => runCommand("du", ["-sk", worktree.path]),
      );
      completed += batch.length;
      onProgress({
        stage: PROGRESS_STAGES.SIZES,
        completed,
        total: existingWorktrees.length,
      });
      return individualResults;
    },
  );
  const sizes = new Map<string, number>();
  for (const batchResults of results) {
    for (const result of batchResults) {
      for (const line of nonEmptyLines(result.stdout)) {
        const match = line.match(/^(\d+)\s+(.+)$/u);
        if (match) sizes.set(match[2], Number.parseInt(match[1], 10));
      }
    }
  }
  return sizes;
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
  force = false,
  runCommand = commandResult,
}: {
  repoRoot: string;
  path: string;
  force?: boolean;
  runCommand?: CommandRunner;
}): CommandResult {
  return runCommand("git", [
    "-C",
    repoRoot,
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    "--",
    path,
  ]);
}

export function verifyRemovalTarget({
  repoRoot,
  row,
  allowWarnings = false,
  runCommand = commandResult,
}: RemovalTargetOptions): boolean {
  if (!existsSync(row.path)) return false;
  if (
    !allowWarnings &&
    (row.dirtyCount !== 0 || row.ignoredUnknownCount !== 0)
  ) return false;
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
  if (!allowWarnings) {
    const status = runCommand("git", [
      "-C",
      row.path,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.status !== 0 || status.stdout.trim().length > 0) return false;
  }
  if (allowWarnings) return true;
  const openFiles = runCommand("lsof", ["-F", "p", "+D", row.path]);
  return countOpenProcesses(openFiles) === 0;
}
