#!/usr/bin/env node

import { createInterface } from "node:readline";

import {
  type AggregateAudit,
  type Audit,
  type AuditRepositoriesFunction,
  type AuditRow,
  type AuditWorktreeOptions,
  auditRepositories,
  auditWorktrees,
  type CliArgs,
  type CommandResult,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  DECISIONS,
  parseArgs,
  type ProgressEvent,
  type RemovalTargetOptions,
  removeWorktree,
  renderAudit,
  verifyRemovalTarget,
} from "./audit.js";

interface CliInput {
  isTTY?: boolean;
}

type ReadableCliInput = NodeJS.ReadableStream & CliInput;

interface CliOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

type Filter = "all" | "safe" | "review" | "unknown";
type AuditArgs = Pick<CliArgs, "cwd"> & Partial<Omit<CliArgs, "cwd">>;
type AuditFunction = (
  options: AuditWorktreeOptions,
) => Promise<Exclude<Audit, AggregateAudit>>;
type RemoveFunction = (options: {
  repoRoot: string;
  path: string;
}) => CommandResult;
type VerifyFunction = (options: RemovalTargetOptions) => boolean;

interface SharedExecutionOptions {
  args: AuditArgs;
  output: CliOutput;
  errorOutput: CliOutput;
  auditFn?: AuditFunction;
  rootAuditFn?: AuditRepositoriesFunction;
  removeFn?: RemoveFunction;
  verifyFn?: VerifyFunction;
}

interface DeletionOptions extends SharedExecutionOptions {
  audit: Audit;
  paths: Iterable<string>;
}

interface InteractiveSessionOptions extends SharedExecutionOptions {
  audit: Audit;
  input?: CliInput;
}

interface RunCliOptions {
  argv?: string[];
  input?: CliInput;
  output?: CliOutput;
  errorOutput?: CliOutput;
}

const DELETE_CONFIRMATION = "DELETE";
const PROMPT = "audit> ";
const DEFAULT_FILTER: Filter = "all";
const SAFE_FILTER: Filter = "safe";
const FILTERS: ReadonlySet<Filter> = new Set([
  DEFAULT_FILTER,
  SAFE_FILTER,
  "review",
  "unknown",
]);
const VERSION = "0.2.0";
const MAX_PREVIEW_ROWS = 20;

const HELP = `
Commands:
  /help                  Show this help
  /list                  Show visible worktrees
  /filter <name>         Filter: all, safe, review, unknown
  /select <n,...>        Select safe rows
  /safe                  Select all SAFE rows
  /clear                 Clear the selection
  /preview               Preview deletion
  /delete                Request confirmation, then revalidate before deletion
  /refresh               Re-run the full audit
  /json                  Print the structured result
  /plain                 Print the non-interactive report
  /cancel                Cancel the pending confirmation
  /quit                  Exit

SAFE rows are the only selectable rows. Deletion requires the exact DELETE
confirmation and a second Git/process validation.
`;

function progressWriter(errorOutput: CliOutput): (progress: ProgressEvent) => void {
  return (progress: ProgressEvent): void => {
    const scope = progress.repositoryIndex
      ? `[${progress.repositoryIndex}/${progress.repositoryTotal}] ${progress.repositoryRoot} · `
      : "";
    if (progress.stage === "worktrees") {
      errorOutput.write(
        `🔎 ${scope}${progress.total} worktrees found. Analyzing...\n`,
      );
    } else if (progress.stage === "processes") {
      errorOutput.write("⚙️ Scanning processes...\n");
    } else if (progress.stage === "sizes") {
      errorOutput.write(
        `📦 Measuring sizes: ${progress.completed}/${progress.total}\n`,
      );
    } else if (progress.stage === "github") {
      errorOutput.write("🔗 Checking GitHub PRs...\n");
    } else if (progress.stage === "chats") {
      errorOutput.write("💬 Matching Codex chats...\n");
    }
  };
}

function rowMatchesFilter(row: AuditRow, filter: Filter): boolean {
  if (filter === DEFAULT_FILTER) return true;
  if (filter === SAFE_FILTER)
    return row.decision === DECISIONS.REMOVE_CANDIDATE;
  if (filter === "review") return row.decision === DECISIONS.REVIEW;
  return row.decision === DECISIONS.UNKNOWN;
}

function visibleRows(audit: Audit, filter: Filter): AuditRow[] {
  return audit.rows.filter((row) => rowMatchesFilter(row, filter));
}

function rowIndexMap(rows: AuditRow[]): Map<number, AuditRow> {
  return new Map(rows.map((row, index) => [index + 1, row]));
}

function safeRows(rows: AuditRow[]): AuditRow[] {
  return rows.filter((row) => row.decision === DECISIONS.REMOVE_CANDIDATE);
}

function isFilter(value: string): value is Filter {
  return FILTERS.has(value as Filter);
}

function auditTitle(audit: Audit): string {
  if ("root" in audit) return `workspace: ${audit.root}`;
  return audit.repository ?? "local Git repository";
}

function formatRow(row: AuditRow, index: number, selected: Set<string>): string {
  const selectedMarker = selected.has(row.path) ? "*" : " ";
  const repositoryLabel = row.repository ?? row.repoRoot;
  const scope = repositoryLabel ? `[${repositoryLabel}] ` : "";
  const pullRequest = row.pr.pullRequest
    ? `PR #${row.pr.pullRequest.number} ${row.pr.pullRequest.state}`
    : row.pr.kind;
  const chat = row.chat.threads[0]
    ? `${row.chat.threads[0].title} [${row.chat.threads[0].status}]`
    : `chat ${row.chat.kind}`;
  return `${selectedMarker} ${String(index).padStart(2)} ${row.marker} ${row.size.padStart(9)} ${scope}${row.path} · ${pullRequest} · 💬 ${chat} · dirty=${row.dirtyCount ?? "?"} open=${row.openProcessCount ?? "?"}`;
}

export function renderInteractive(
  audit: Audit,
  {
    selected = new Set<string>(),
    filter = DEFAULT_FILTER,
  }: { selected?: Set<string>; filter?: Filter } = {},
): string {
  const rows = visibleRows(audit, filter);
  const safeCount = safeRows(audit.rows).length;
  const selectedCount = audit.rows.filter((row) =>
    selected.has(row.path),
  ).length;
  const lines = [
    `\n🧹 Worktree Audit · ${auditTitle(audit)}`,
    `${audit.rows.length} worktrees · ${safeCount} SAFE · ${selectedCount} selected · filter=${filter}`,
    "Commands: /help /safe /preview /delete /refresh /quit. SAFE rows can be deleted after double validation.",
    "",
  ];
  if (rows.length === 0) {
    lines.push("No rows for this filter.");
  } else {
    rows.forEach((row) =>
      lines.push(
        formatRow(
          row,
          audit.rows.findIndex((candidate) => candidate.path === row.path) + 1,
          selected,
        ),
      ),
    );
  }
  lines.push(
    "",
    "* selected · SAFE selectable · REVIEW/UNKNOWN kept by default",
  );
  if ("errors" in audit && audit.errors.length > 0) {
    lines.push(
      "",
      `⚠️ ${audit.errors.length} error(s): ${audit.errors
        .map((error) => error.path)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function parseIndexToken(token: string, maxIndex: number): number[] {
  const range = token.match(/^(\d+)-(\d+)$/u);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (start < 1 || end < start || end > maxIndex) return [];
    return Array.from(
      { length: end - start + 1 },
      (_, offset) => start + offset,
    );
  }
  const index = Number.parseInt(token, 10);
  return String(index) === token && index >= 1 && index <= maxIndex
    ? [index]
    : [];
}

export function parseSelection(
  value: unknown,
  maxIndex: number,
): { indexes: number[]; invalid: string[] } {
  const tokens = String(value ?? "")
    .split(/[\s,]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const indexes = new Set<number>();
  const invalid: string[] = [];
  for (const token of tokens) {
    const parsed = parseIndexToken(token, maxIndex);
    if (parsed.length === 0) invalid.push(token);
    for (const index of parsed) indexes.add(index);
  }
  return { indexes: [...indexes].sort((left, right) => left - right), invalid };
}

export function parseInteractiveCommand(line: unknown): {
  command: string;
  argument: string;
} {
  const value = String(line ?? "").trim();
  if (!value) return { command: "noop", argument: "" };
  const normalized = value.startsWith("/") ? value.slice(1) : value;
  const [command = "", ...rest] = normalized.split(/\s+/u);
  return { command: command.toLowerCase(), argument: rest.join(" ") };
}

function selectedRows(audit: Audit, selected: Set<string>): AuditRow[] {
  return audit.rows.filter((row) => selected.has(row.path));
}

function filterMergedOnly(audit: Audit): Audit {
  if (!("repositories" in audit)) {
    return {
      ...audit,
      rows: audit.rows.filter((row) => row.pr.kind === "MERGED_EXACT"),
    };
  }
  const repositories = audit.repositories.map((repository) => ({
    ...repository,
    rows: repository.rows.filter((row) => row.pr.kind === "MERGED_EXACT"),
  }));
  return {
    ...audit,
    repositories,
    rows: audit.rows.filter((row) => row.pr.kind === "MERGED_EXACT"),
  };
}

function printPreview(output: CliOutput, rows: AuditRow[]): void {
  output.write(`\nDeletion preview (${rows.length}):\n`);
  rows.slice(0, MAX_PREVIEW_ROWS).forEach((row) => {
    const scope = row.repository ?? row.repoRoot;
    output.write(
      `- ${scope ? `[${scope}] ` : ""}${row.path} (${row.size}) · ${row.head}\n`,
    );
  });
  if (rows.length > MAX_PREVIEW_ROWS) {
    output.write(`- ... ${rows.length - MAX_PREVIEW_ROWS} more row(s)\n`);
  }
}

async function collectAudit(
  args: AuditArgs,
  errorOutput: CliOutput,
  auditFn: AuditFunction = auditWorktrees,
  rootAuditFn: AuditRepositoriesFunction = auditRepositories,
): Promise<Audit> {
  const options: AuditWorktreeOptions = {
    cwd: args.cwd,
    noGithub: args.noGithub ?? false,
    noChat: args.noChat ?? false,
    deepProcessScan: args.deepProcessScan ?? false,
    onProgress: progressWriter(errorOutput),
  };
  return args.root
    ? rootAuditFn({
        ...options,
        root: args.root,
        maxDepth: args.maxDepth ?? DEFAULT_DISCOVERY_MAX_DEPTH,
      })
    : auditFn(options);
}

export async function executeDeletion({
  audit,
  paths,
  args,
  output,
  errorOutput,
  auditFn = auditWorktrees,
  rootAuditFn = auditRepositories,
  removeFn = removeWorktree,
  verifyFn = verifyRemovalTarget,
}: DeletionOptions): Promise<{ audit: Audit; removed: number }> {
  const latestAudit = await collectAudit(
    { ...args, deepProcessScan: true },
    errorOutput,
    auditFn,
    rootAuditFn,
  );
  const latestRows = new Map(latestAudit.rows.map((row) => [row.path, row]));
  let removed = 0;
  for (const path of paths) {
    const row = latestRows.get(path);
    const repoRoot =
      row?.repoRoot ?? ("repoRoot" in audit ? audit.repoRoot : undefined);
    if (
      !row ||
      row.decision !== DECISIONS.REMOVE_CANDIDATE ||
      !repoRoot ||
      !verifyFn({ repoRoot, row })
    ) {
      output.write(`Kept, insufficient evidence: ${path}\n`);
      continue;
    }
    const result = removeFn({ repoRoot, path: row.path });
    if (result.status === 0) {
      output.write(`Deleted: ${row.path}\n`);
      removed += 1;
    } else {
      output.write(`Deletion failed: ${row.path}\n`);
    }
  }
  return { audit: latestAudit, removed };
}

export async function runInteractiveSession({
  audit,
  args,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  auditFn = auditWorktrees,
  rootAuditFn = auditRepositories,
  removeFn = removeWorktree,
  verifyFn = verifyRemovalTarget,
}: InteractiveSessionOptions): Promise<number> {
  let currentAudit = audit;
  let filter = DEFAULT_FILTER;
  let selected = new Set<string>();
  let pendingDeletion: Set<string> | null = null;
  let closed = false;

  const show = () => {
    output.write(`${renderInteractive(currentAudit, { selected, filter })}\n`);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    output.write("\nSession ended.\n");
  };
  const readline = createInterface({
    input: input as NodeJS.ReadableStream,
    output: output as NodeJS.WritableStream,
    terminal: Boolean(input.isTTY && output.isTTY),
    prompt: PROMPT,
  });

  show();
  readline.prompt();

  return new Promise<number>((resolve) => {
    readline.on("close", () => {
      finish();
      resolve(0);
    });
    readline.on("line", async (line: string) => {
      readline.pause();
      try {
        const value = String(line ?? "").trim();
        if (pendingDeletion) {
          if (value === DELETE_CONFIRMATION) {
            const result = await executeDeletion({
              audit: currentAudit,
              paths: pendingDeletion,
              args,
              output,
              errorOutput,
              auditFn,
              rootAuditFn,
              removeFn,
              verifyFn,
            });
            currentAudit = result.audit;
            selected = new Set();
            output.write(`\n${result.removed} worktree(s) deleted.\n`);
          } else if (["/cancel", "cancel"].includes(value.toLowerCase())) {
            output.write("Deletion cancelled.\n");
          } else if (
            ["/q", "/quit", "/exit", "q", "quit", "exit"].includes(
              value.toLowerCase(),
            )
          ) {
            pendingDeletion = null;
            readline.close();
            return;
          } else {
            output.write("Deletion cancelled: exact confirmation required.\n");
          }
          pendingDeletion = null;
          show();
          return;
        }

        const parsed = parseInteractiveCommand(value);
        if (parsed.command === "noop") return;
        if (["q", "quit", "exit"].includes(parsed.command)) {
          readline.close();
          return;
        }
        if (parsed.command === "help" || parsed.command === "?") {
          output.write(`${HELP}\n`);
        } else if (parsed.command === "list" || parsed.command === "show") {
          show();
        } else if (parsed.command === "filter") {
          const nextFilter = parsed.argument || DEFAULT_FILTER;
          if (!isFilter(nextFilter)) {
            output.write(
              `Unknown filter: ${nextFilter}. Values: ${[...FILTERS].join(", ")}\n`,
            );
          } else {
            filter = nextFilter;
          }
        } else if (parsed.command === "safe") {
          selected = new Set(
            safeRows(currentAudit.rows).map((row) => row.path),
          );
          filter = SAFE_FILTER;
        } else if (
          ["clear", "unselect"].includes(parsed.command) &&
          !parsed.argument
        ) {
          selected = new Set();
        } else if (["select", "unselect"].includes(parsed.command)) {
          const rows = visibleRows(currentAudit, filter);
          const selection = parseSelection(
            parsed.argument,
            currentAudit.rows.length,
          );
          if (selection.invalid.length > 0) {
            output.write(`Invalid rows: ${selection.invalid.join(", ")}\n`);
          }
          for (const index of selection.indexes) {
            const row = rowIndexMap(currentAudit.rows).get(index);
            if (!row || !rows.includes(row)) {
              output.write(`Row not visible: ${index}\n`);
            } else if (row.decision !== DECISIONS.REMOVE_CANDIDATE) {
              output.write(`Row ${index} is not SAFE and was kept.\n`);
            } else if (parsed.command === "select") {
              selected.add(row.path);
            } else {
              selected.delete(row.path);
            }
          }
        } else if (parsed.command === "preview") {
          const chosen = selectedRows(currentAudit, selected);
          if (chosen.length === 0)
            output.write("No deletion selected.\n");
          else printPreview(output, chosen);
        } else if (parsed.command === "delete") {
          const chosen = selectedRows(currentAudit, selected);
          if (chosen.length === 0) {
            output.write(
              "No deletion selected. Use /safe or /select.\n",
            );
          } else {
            printPreview(output, chosen);
            output.write(
              `Type ${DELETE_CONFIRMATION} to confirm, or /cancel.\n`,
            );
            pendingDeletion = new Set(chosen.map((row) => row.path));
          }
        } else if (parsed.command === "cancel") {
          output.write("No deletion is pending.\n");
        } else if (parsed.command === "refresh") {
          currentAudit = await collectAudit(
            args,
            errorOutput,
            auditFn,
            rootAuditFn,
          );
          selected = new Set();
          output.write("Audit refreshed.\n");
        } else if (parsed.command === "json") {
          output.write(`${JSON.stringify(currentAudit, null, 2)}\n`);
        } else if (parsed.command === "plain") {
          output.write(`${renderAudit(currentAudit, { color: false })}\n`);
        } else {
          output.write(`Unknown command: ${parsed.command}. Type /help.\n`);
        }
        if (!closed && !["list", "show"].includes(parsed.command)) show();
      } catch (error) {
        output.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        if (!closed) {
          readline.resume();
          readline.prompt();
        }
      }
    });
  });
}

export async function runCli({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
}: RunCliOptions = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    output.write("Usage: worktree-audit [options]\n");
    output.write(
      "Options: --interactive --json --cwd PATH --root PATH (--repos-dir) --max-depth N --merged-only --no-github --no-chat --deep-process-scan --version\n",
    );
    output.write(
      "--cwd audits one repository. --root recursively discovers multiple repositories.\n",
    );
    output.write(
      "Without options in a TTY, interactive mode starts automatically.\n",
    );
    return 0;
  }
  if (args.version) {
    output.write(`${VERSION}\n`);
    return 0;
  }
  if (args.interactive && (!input.isTTY || !output.isTTY)) {
    throw new Error("--interactive requires an interactive terminal (TTY).");
  }
  const audit = await collectAudit(args, errorOutput);
  const filteredAudit = args.mergedOnly ? filterMergedOnly(audit) : audit;
  if (args.json) {
    output.write(`${JSON.stringify(filteredAudit, null, 2)}\n`);
    return 0;
  }
  const interactive = args.interactive || Boolean(input.isTTY && output.isTTY);
  if (!interactive) {
    output.write(`${renderAudit(filteredAudit, { color: false })}\n`);
    output.write(
      "Non-interactive mode. Use a TTY or --interactive for commands.\n",
    );
    return 0;
  }
  return runInteractiveSession({
    audit: filteredAudit,
    args,
    input,
    output,
    errorOutput,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        `worktree-audit: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
