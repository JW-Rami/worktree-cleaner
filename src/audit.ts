import { existsSync } from "node:fs";

import {
  DEFAULT_AUDIT_CONCURRENCY,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  DEFAULT_WORKTREE_CONCURRENCY,
  MAX_AUDIT_CONCURRENCY,
  MAX_WORKTREE_CONCURRENCY,
  PROGRESS_STAGES,
  WARNING_CODES,
  type AsyncCommandRunner,
  type AggregateAudit,
  type AggregateRow,
  type AuditError,
  type AuditWarning,
  type AuditRepositoriesOptions,
  type AuditRow,
  type AuditWorktreeOptions,
  type ChatEvidence,
  type ChatLookup,
  type CommandRunner,
  type ProgressHandler,
  type PullRequest,
  type PullRequestEvidence,
  type SingleAudit,
  type Worktree,
  type WorktreeState,
  type WarningCode,
} from "./domain.js";
import { commandResult, commandResultAsync } from "./command.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  discoverRepositoryRoots,
  defaultWorkspaceRoot,
  parseArgs,
  parseWorktreeList,
} from "./discovery.js";
import { createCodexChatLookup } from "./chat.js";
import {
  getRepositorySlug,
  loadPullRequests,
  matchPullRequest,
  queryPullRequest,
} from "./github.js";
import { buildAuditRow } from "./policy.js";
import {
  collectWorktreeStateAsync,
  measureWorktreeSizesAsync,
  processCountForPath,
  scanProcessCwds,
} from "./worktree.js";

export {
  DEFAULT_AUDIT_CONCURRENCY,
  DECISIONS,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  DEFAULT_WORKTREE_CONCURRENCY,
  MAX_AUDIT_CONCURRENCY,
  MAX_WORKTREE_CONCURRENCY,
  PROGRESS_STAGES,
  WARNING_CODES,
} from "./domain.js";
export type {
  AggregateAudit,
  AggregateRow,
  Audit,
  AuditError,
  AuditWarning,
  AuditRepositoriesFunction,
  AuditRepositoriesOptions,
  AuditRepositoryFunction,
  AuditRow,
  AuditWorktreeOptions,
  ChatEvidence,
  ChatKind,
  ChatLookup,
  ChatThread,
  CliArgs,
  AsyncCommandRunner,
  CommandOptions,
  CommandResult,
  CommandRunner,
  Decision,
  LastCommit,
  ProgressEvent,
  ProgressHandler,
  ProgressStage,
  PullRequest,
  PullRequestEvidence,
  PullRequestKind,
  RawChatThread,
  RemovalTargetOptions,
  SingleAudit,
  Worktree,
  WorktreeState,
  WarningCode,
} from "./domain.js";
export { commandResult, commandResultAsync } from "./command.js";
export {
  discoverRepositoryRoots,
  defaultWorkspaceRoot,
  parseArgs,
  parseWorktreeList,
} from "./discovery.js";
export { createCodexChatLookup, groupChatThreadsByCwd } from "./chat.js";
export {
  matchPullRequest,
  repositoryFromRemote,
} from "./github.js";
export { buildAuditRow } from "./policy.js";
export {
  defaultSelection,
  collectWorktreeStateAsync,
  measureWorktreeSizes,
  measureWorktreeSizesAsync,
  removeWorktree,
  verifyRemovalTarget,
} from "./worktree.js";
export { renderAudit } from "./audit-render.js";

interface AuditContext {
  repoRoot: string;
  repository: string | null;
  asyncRunCommand: AsyncCommandRunner;
  processPaths: Map<string, Set<string>> | null;
  sizes: Map<string, number>;
  pullRequests: PullRequest[] | null;
  chatsByPath: Map<string, ChatEvidence>;
}

function unknownChatEvidence(): ChatEvidence {
  return { kind: "UNKNOWN_CHAT", threads: [] };
}

function unknownPullRequestEvidence(): PullRequestEvidence {
  return { kind: "UNKNOWN_GITHUB", pullRequest: null };
}

function missingWorktreeState(worktree: Worktree): WorktreeState {
  return {
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
  };
}

async function prepareAuditContext({
  repoRoot,
  worktrees,
  runCommand,
  asyncRunCommand,
  chatLookup,
  noGithub,
  noChat,
  deepProcessScan,
  worktreeConcurrency,
  onProgress,
}: {
  repoRoot: string;
  worktrees: Worktree[];
  runCommand: CommandRunner;
  asyncRunCommand: AsyncCommandRunner;
  chatLookup?: ChatLookup;
  noGithub: boolean;
  noChat: boolean;
  deepProcessScan: boolean;
  worktreeConcurrency: number;
  onProgress: ProgressHandler;
}): Promise<AuditContext> {
  const repository = noGithub
    ? null
    : getRepositorySlug(repoRoot, runCommand);
  const lookup: ChatLookup = noChat
    ? async () => unknownChatEvidence()
    : (chatLookup ?? createCodexChatLookup());

  onProgress({ stage: PROGRESS_STAGES.PROCESSES });
  const processPaths = deepProcessScan ? null : scanProcessCwds(runCommand);
  const sizes = await measureWorktreeSizesAsync(
    worktrees,
    asyncRunCommand,
    onProgress,
    worktreeConcurrency,
  );

  onProgress({ stage: PROGRESS_STAGES.GITHUB });
  const pullRequests = noGithub
    ? null
    : loadPullRequests(repository, runCommand);

  onProgress({ stage: PROGRESS_STAGES.CHATS });
  const chatWorktrees =
    pullRequests === null
      ? []
      : worktrees.filter(
          (worktree) =>
            matchPullRequest({
              branch: worktree.branch ?? null,
              head: worktree.head ?? "",
              pullRequests,
            }).kind === "MERGED_EXACT",
        );
  let chatResults: ChatEvidence[];
  try {
    chatResults = await mapWithConcurrency(
      chatWorktrees,
      worktreeConcurrency,
      (worktree) => lookup(worktree.path),
    );
  } finally {
    lookup.close?.();
  }

  const chatsByPath = new Map<string, ChatEvidence>(
    worktrees.map((worktree) => [worktree.path, unknownChatEvidence()]),
  );
  chatWorktrees.forEach((worktree, index) => {
    chatsByPath.set(worktree.path, chatResults[index]);
  });

  return {
    repoRoot,
    repository,
    asyncRunCommand,
    processPaths,
    sizes,
    pullRequests,
    chatsByPath,
  };
}

async function auditWorktreeRow(
  worktree: Worktree,
  context: AuditContext,
  {
    noGithub,
    deepProcessScan,
  }: { noGithub: boolean; deepProcessScan: boolean },
): Promise<AuditRow> {
  const chat = context.chatsByPath.get(worktree.path) ?? unknownChatEvidence();
  if (!existsSync(worktree.path)) {
    return buildAuditRow({
      state: missingWorktreeState(worktree),
      pr: unknownPullRequestEvidence(),
      chat,
      mainPath: context.repoRoot,
    });
  }

  const state = await collectWorktreeStateAsync(worktree, {
    runCommand: context.asyncRunCommand,
    deepProcessScan,
    openProcessCount: processCountForPath(
      context.processPaths,
      worktree.path,
    ),
    sizeKib: context.sizes.get(worktree.path) ?? null,
  });
  const pr = noGithub
    ? unknownPullRequestEvidence()
    : queryPullRequest(state, context.repository, context.pullRequests);
  return buildAuditRow({ state, pr, chat, mainPath: context.repoRoot });
}

export async function auditWorktrees({
  cwd = process.cwd(),
  runCommand = commandResult,
  asyncRunCommand = commandResultAsync,
  chatLookup,
  noGithub = false,
  noChat = false,
  deepProcessScan = false,
  worktreeConcurrency = DEFAULT_WORKTREE_CONCURRENCY,
  onProgress = () => {},
}: AuditWorktreeOptions = {}): Promise<SingleAudit> {
  if (
    !Number.isInteger(worktreeConcurrency) ||
    worktreeConcurrency < 1 ||
    worktreeConcurrency > MAX_WORKTREE_CONCURRENCY
  ) {
    throw new Error(
      `worktree concurrency must be an integer between 1 and ${MAX_WORKTREE_CONCURRENCY}.`,
    );
  }
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
  const context = await prepareAuditContext({
    repoRoot,
    worktrees,
    runCommand,
    asyncRunCommand,
    chatLookup,
    noGithub,
    noChat,
    deepProcessScan,
    worktreeConcurrency,
    onProgress,
  });
  const rows = await mapWithConcurrency(
    worktrees,
    worktreeConcurrency,
    (worktree) =>
      auditWorktreeRow(worktree, context, { noGithub, deepProcessScan }),
  );
  return { repoRoot, repository: context.repository, rows };
}

function repositoryProgress(
  onProgress: ProgressHandler,
  repositoryIndex: number,
  repositoryTotal: number,
  repositoryRoot: string,
): ProgressHandler {
  return (progress) =>
    onProgress({
      ...progress,
      repositoryIndex,
      repositoryTotal,
      repositoryRoot,
    });
}

function aggregateRows(repositories: SingleAudit[]): AggregateRow[] {
  return repositories.flatMap((audit) =>
    audit.rows.map((row) => ({
      ...row,
      repoRoot: audit.repoRoot,
      repository: audit.repository,
    })),
  );
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
  concurrency = DEFAULT_AUDIT_CONCURRENCY,
  worktreeConcurrency = DEFAULT_WORKTREE_CONCURRENCY,
  onProgress = () => {},
}: AuditRepositoriesOptions = {}): Promise<AggregateAudit> {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_AUDIT_CONCURRENCY
  ) {
    throw new Error(
      `concurrency must be an integer between 1 and ${MAX_AUDIT_CONCURRENCY}.`,
    );
  }
  if (
    !Number.isInteger(worktreeConcurrency) ||
    worktreeConcurrency < 1 ||
    worktreeConcurrency > MAX_WORKTREE_CONCURRENCY
  ) {
    throw new Error(
      `worktree concurrency must be an integer between 1 and ${MAX_WORKTREE_CONCURRENCY}.`,
    );
  }
  const discovery = discoverRepositoryRoots(root, { runCommand, maxDepth });
  const errors: AuditError[] = discovery.errors.map((error) => ({
    stage: "discovery",
    ...error,
  }));

  const repositoriesByIndex: Array<SingleAudit | null> = Array.from(
    { length: discovery.roots.length },
    () => null,
  );
  const auditErrorsByIndex: AuditError[][] = Array.from(
    { length: discovery.roots.length },
    () => [],
  );
  let nextRepositoryIndex = 0;
  const workerCount = Math.min(concurrency, discovery.roots.length);
  const auditNextRepository = async (): Promise<void> => {
    while (nextRepositoryIndex < discovery.roots.length) {
      const index = nextRepositoryIndex;
      nextRepositoryIndex += 1;
      const repoRoot = discovery.roots[index];
      try {
        repositoriesByIndex[index] = await auditRepository({
          cwd: repoRoot,
          runCommand,
          chatLookup,
          noGithub,
          noChat,
          deepProcessScan,
          worktreeConcurrency,
          onProgress: repositoryProgress(
            onProgress,
            index + 1,
            discovery.roots.length,
            repoRoot,
          ),
        });
      } catch (error) {
        auditErrorsByIndex[index].push({
          stage: "audit",
          path: repoRoot,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: workerCount }, () => auditNextRepository()),
  );

  const repositories = repositoriesByIndex.filter(
    (audit): audit is SingleAudit => audit !== null,
  );
  errors.push(...auditErrorsByIndex.flat());

  return {
    root: discovery.root,
    repositories,
    rows: aggregateRows(repositories),
    errors,
  };
}
