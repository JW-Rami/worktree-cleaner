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

export const PROGRESS_STAGES = Object.freeze({
  WORKTREES: "worktrees",
  PROCESSES: "processes",
  SIZES: "sizes",
  GITHUB: "github",
  CHATS: "chats",
} as const);

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

export const DECISIONS = Object.freeze({
  REMOVE_CANDIDATE: "REMOVE_CANDIDATE",
  KEEP_MAIN: "KEEP_MAIN",
  KEEP_DIRTY: "KEEP_DIRTY",
  KEEP_ACTIVE_CHAT: "KEEP_ACTIVE_CHAT",
  REVIEW: "REVIEW",
  UNKNOWN: "UNKNOWN",
} as const);

export type Decision = (typeof DECISIONS)[keyof typeof DECISIONS];

export const DEFAULT_DISCOVERY_MAX_DEPTH = 8;
