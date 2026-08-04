#!/usr/bin/env node

import { createInterface } from "node:readline";

import {
  type AggregateAudit,
  type Audit,
  type AuditRepositoriesFunction,
  type AuditWorktreeOptions,
  DECISIONS,
  auditRepositories,
  auditWorktrees,
  defaultWorkspaceRoot,
  type CliArgs,
  type CommandResult,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  parseArgs,
  removeWorktree,
  renderAudit,
  verifyRemovalTarget,
} from "./audit.js";
import {
  DELETE_CONFIRMATION,
  DEFAULT_FILTER,
  FILTERS,
  HELP,
  PROMPT,
  SAFE_FILTER,
  filterMergedOnly,
  isFilter,
  parseInteractiveCommand,
  parseSelection,
  printPreview,
  renderInteractive,
  rowIndexMap,
  safeRows,
  selectedRows,
  visibleRows,
} from "./interactive.js";
import type { CliOutput, Filter } from "./interactive.js";
import type {
  ProgressEvent,
  RemovalTargetOptions,
} from "./domain.js";

export {
  parseInteractiveCommand,
  parseSelection,
  renderInteractive,
} from "./interactive.js";

interface CliInput {
  isTTY?: boolean;
}

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

const VERSION = "0.2.0";

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
    worktreeConcurrency: args.concurrency,
    onProgress: progressWriter(errorOutput),
  };
  const root = args.root ?? (
    args.cwdExplicit && !args.all ? null : defaultWorkspaceRoot(args.cwd)
  );
  return root
    ? rootAuditFn({
        ...options,
        root,
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
  let filter: Filter = DEFAULT_FILTER;
  let selected = new Set<string>();
  let pendingDeletion: Set<string> | null = null;
  let closed = false;

  const show = (): void => {
    output.write(`${renderInteractive(currentAudit, { selected, filter })}\n`);
  };
  const finish = (): void => {
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
          if (chosen.length === 0) output.write("No deletion selected.\n");
          else printPreview(output, chosen);
        } else if (parsed.command === "delete") {
          const chosen = selectedRows(currentAudit, selected);
          if (chosen.length === 0) {
            output.write("No deletion selected. Use /safe or /select.\n");
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
      "Options: --all (-all) --interactive --json --cwd PATH --root PATH (--repos-dir) --max-depth N --concurrency N --merged-only --no-github --no-chat --deep-process-scan --version\n",
    );
    output.write(
      "--cwd audits one repository. Without a scope option, the parent of the current Git repository is scanned as a workspace. --all explicitly enables the same recursive workspace scan; --root sets its directory.\n",
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
