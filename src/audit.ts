import { existsSync } from "node:fs";

import {
  DEFAULT_DISCOVERY_MAX_DEPTH,
  PROGRESS_STAGES,
  type AggregateAudit,
  type AggregateRow,
  type AuditError,
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
} from "./domain.js";
import { commandResult } from "./command.js";
import {
  discoverRepositoryRoots,
  parseArgs,
  parseWorktreeList,
} from "./discovery.js";
import {
  createCodexChatLookup,
  groupChatThreadsByCwd,
} from "./chat.js";
import {
  getRepositorySlug,
  loadPullRequests,
  queryPullRequest,
} from "./github.js";
import { buildAuditRow } from "./policy.js";
import {
  collectWorktreeState,
  measureWorktreeSizes,
  processCountForPath,
  scanProcessCwds,
} from "./worktree.js";

export {
  DECISIONS,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  PROGRESS_STAGES,
} from "./domain.js";
export type {
  AggregateAudit,
  AggregateRow,
  Audit,
  AuditError,
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
} from "./domain.js";
export { commandResult } from "./command.js";
export {
  discoverRepositoryRoots,
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
  measureWorktreeSizes,
  removeWorktree,
  verifyRemovalTarget,
} from "./worktree.js";
export { renderAudit } from "./audit-render.js";

interface AuditContext {
  repoRoot: string;
  repository: string | null;
  runCommand: CommandRunner;
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
  chatLookup,
  noGithub,
  noChat,
  deepProcessScan,
  onProgress,
}: {
  repoRoot: string;
  worktrees: Worktree[];
  runCommand: CommandRunner;
  chatLookup?: ChatLookup;
  noGithub: boolean;
  noChat: boolean;
  deepProcessScan: boolean;
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
  const sizes = measureWorktreeSizes(worktrees, runCommand, onProgress);

  onProgress({ stage: PROGRESS_STAGES.GITHUB });
  const pullRequests = noGithub
    ? null
    : loadPullRequests(repository, runCommand);

  onProgress({ stage: PROGRESS_STAGES.CHATS });
  const chatResults = await Promise.all(
    worktrees.map((worktree) => lookup(worktree.path)),
  );
  const chatResult: ChatEvidence = {
    kind: chatResults.some((result) => result.kind === "UNKNOWN_CHAT")
      ? "UNKNOWN_CHAT"
      : "EXACT",
    threads: chatResults.flatMap((result) => result.threads ?? []),
  };

  return {
    repoRoot,
    repository,
    runCommand,
    processPaths,
    sizes,
    pullRequests,
    chatsByPath: groupChatThreadsByCwd(
      worktrees.map((worktree) => worktree.path),
      chatResult,
    ),
  };
}

function auditWorktreeRow(
  worktree: Worktree,
  context: AuditContext,
  {
    noGithub,
    deepProcessScan,
  }: { noGithub: boolean; deepProcessScan: boolean },
): AuditRow {
  const chat = context.chatsByPath.get(worktree.path) ?? unknownChatEvidence();
  if (!existsSync(worktree.path)) {
    return buildAuditRow({
      state: missingWorktreeState(worktree),
      pr: unknownPullRequestEvidence(),
      chat,
      mainPath: context.repoRoot,
    });
  }

  const state = collectWorktreeState(worktree, {
    runCommand: context.runCommand,
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
  const context = await prepareAuditContext({
    repoRoot,
    worktrees,
    runCommand,
    chatLookup,
    noGithub,
    noChat,
    deepProcessScan,
    onProgress,
  });
  const rows = worktrees.map((worktree) =>
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
        onProgress: repositoryProgress(
          onProgress,
          index + 1,
          discovery.roots.length,
          repoRoot,
        ),
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

  return {
    root: discovery.root,
    repositories,
    rows: aggregateRows(repositories),
    errors,
  };
}
