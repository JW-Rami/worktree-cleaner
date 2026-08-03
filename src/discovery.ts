import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_AUDIT_CONCURRENCY,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  DEFAULT_WORKTREE_CONCURRENCY,
  MAX_AUDIT_CONCURRENCY,
  MAX_WORKTREE_CONCURRENCY,
  type AuditError,
  type CliArgs,
  type CommandRunner,
  type Worktree,
} from "./domain.js";
import { commandResult, getErrorProperty, nonEmptyLines } from "./command.js";

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

export function parseArgs(argv: string[] = []): CliArgs {
  const args: CliArgs = {
    cwd: process.cwd(),
    cwdExplicit: false,
    root: null,
    all: false,
    maxDepth: DEFAULT_DISCOVERY_MAX_DEPTH,
    concurrency: DEFAULT_AUDIT_CONCURRENCY,
    worktreeConcurrency: DEFAULT_WORKTREE_CONCURRENCY,
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
      args.cwdExplicit = true;
      args.cwd = resolve(argv[++index] ?? "");
    } else if (argument === "--root" || argument === "--repos-dir") {
      rootWasProvided = true;
      args.root = resolve(argv[++index] ?? "");
    } else if (argument === "--all" || argument === "-all") {
      args.all = true;
    } else if (argument === "--max-depth") {
      const value = Number.parseInt(argv[++index] ?? "", 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          "--max-depth must be a non-negative integer.",
        );
      }
      args.maxDepth = value;
    } else if (argument === "--concurrency") {
      const value = Number(argv[++index] ?? "");
      if (
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_AUDIT_CONCURRENCY
      ) {
        throw new Error(
          `--concurrency must be an integer between 1 and ${MAX_AUDIT_CONCURRENCY}.`,
        );
      }
      args.concurrency = value;
    } else if (argument === "--worktree-concurrency") {
      const value = Number(argv[++index] ?? "");
      if (
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_WORKTREE_CONCURRENCY
      ) {
        throw new Error(
          `--worktree-concurrency must be an integer between 1 and ${MAX_WORKTREE_CONCURRENCY}.`,
        );
      }
      args.worktreeConcurrency = value;
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

export function defaultWorkspaceRoot(
  cwd: string,
  runCommand: CommandRunner = commandResult,
): string {
  const result = runCommand("git", [
    "-C",
    cwd,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (result.status !== 0 || result.stdout.trim().length === 0)
    return safeRealPath(cwd);
  return dirname(safeRealPath(result.stdout.trim()));
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
      if (getErrorProperty(error, "code") !== "ENOENT")
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
