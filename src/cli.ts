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
  DEFAULT_TERMINAL_ROWS,
  DEFAULT_FILTER,
  FILTERS,
  HELP,
  PROMPT,
  SAFE_FILTER,
  filterMergedOnly,
  isFilter,
  moveCursor,
  navigationRows,
  parseTerminalKeys,
  parseInteractiveCommand,
  parseSelection,
  printPreview,
  renderInteractive,
  rowIndexMap,
  safeRows,
  selectedRows,
} from "./interactive.js";
import type {
  CliOutput,
  Filter,
  TerminalKey,
} from "./interactive.js";
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
  force?: boolean;
}) => CommandResult;
type VerifyFunction = (options: RemovalTargetOptions) => boolean;
type StatusHandler = (message: string) => void;

interface SharedExecutionOptions {
  args: AuditArgs;
  output: CliOutput;
  errorOutput: CliOutput;
  auditFn?: AuditFunction;
  rootAuditFn?: AuditRepositoriesFunction;
  removeFn?: RemoveFunction;
  verifyFn?: VerifyFunction;
  onStatus?: StatusHandler;
}

interface DeletionOptions extends SharedExecutionOptions {
  audit: Audit;
  paths: Iterable<string>;
}

interface DeletionResult {
  audit: Audit;
  removed: number;
  kept: number;
  failed: number;
}

function withoutDeletedRows(audit: Audit, deletedPaths: Set<string>): Audit {
  if ("repositories" in audit) {
    return {
      ...audit,
      repositories: audit.repositories.map((repository) => ({
        ...repository,
        rows: repository.rows.filter((row) => !deletedPaths.has(row.path)),
      })),
      rows: audit.rows.filter((row) => !deletedPaths.has(row.path)),
    };
  }
  return {
    ...audit,
    rows: audit.rows.filter((row) => !deletedPaths.has(row.path)),
  };
}

interface InteractiveSessionOptions extends SharedExecutionOptions {
  audit: Audit;
  input?: CliInput;
  onUpdate?: () => void;
}

interface RunCliOptions {
  argv?: string[];
  input?: CliInput;
  output?: CliOutput;
  errorOutput?: CliOutput;
}

const VERSION = "0.2.0";
const CONFIRMATION_ALIASES = new Set([
  "delete",
  "confirm",
]);
const STATUS_PATH_MAX_LENGTH = 64;

function statusPath(path: string): string {
  if (path.length <= STATUS_PATH_MAX_LENGTH) return path;
  return `…${path.slice(-(STATUS_PATH_MAX_LENGTH - 1))}`;
}

function confirmationAccepted(value: string): boolean {
  return CONFIRMATION_ALIASES.has(value.replace(/^\/+/, "").toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progressWriter(
  errorOutput: CliOutput,
  onStatus?: StatusHandler,
): (progress: ProgressEvent) => void {
  const report =
    onStatus ?? ((message: string) => errorOutput.write(`${message}\n`));
  return (progress: ProgressEvent): void => {
    const scope = progress.repositoryIndex
      ? `[${progress.repositoryIndex}/${progress.repositoryTotal}] ${progress.repositoryRoot} · `
      : "";
    if (progress.stage === "worktrees") {
      report(
        `🔎 ${scope}${progress.total} worktrees found. Analyzing...`,
      );
    } else if (progress.stage === "processes") {
      report("⚙️ Scanning processes...");
    } else if (progress.stage === "sizes") {
      report(`📦 Measuring sizes: ${progress.completed}/${progress.total}`);
    } else if (progress.stage === "github") {
      report("🔗 Checking GitHub PRs...");
    } else if (progress.stage === "chats") {
      report("💬 Matching Codex chats...");
    }
  };
}

async function collectAudit(
  args: AuditArgs,
  errorOutput: CliOutput,
  auditFn: AuditFunction = auditWorktrees,
  rootAuditFn: AuditRepositoriesFunction = auditRepositories,
  onStatus?: StatusHandler,
): Promise<Audit> {
  const options: AuditWorktreeOptions = {
    cwd: args.cwd,
    noGithub: args.noGithub ?? false,
    noChat: args.noChat ?? false,
    deepProcessScan: args.deepProcessScan ?? false,
    worktreeConcurrency: args.concurrency,
    onProgress: progressWriter(errorOutput, onStatus),
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
  onStatus,
}: DeletionOptions): Promise<DeletionResult> {
  const targetPaths = [...paths];
  const report = (message: string): void => {
    output.write(`${message}\n`);
    onStatus?.(message);
  };
  onStatus?.(`⏳ Revalidating ${targetPaths.length} selected worktree(s)...`);
  const latestAudit = await collectAudit(
    { ...args, deepProcessScan: true },
    errorOutput,
    auditFn,
    rootAuditFn,
    onStatus,
  );
  const latestRows = new Map(latestAudit.rows.map((row) => [row.path, row]));
  let removed = 0;
  let kept = 0;
  let failed = 0;
  const deletedPaths = new Set<string>();
  for (const [index, path] of targetPaths.entries()) {
    const progress = `[${index + 1}/${targetPaths.length}]`;
    onStatus?.(`🔍 ${progress} Validating ${statusPath(path)}...`);
    const row = latestRows.get(path);
    const repoRoot =
      row?.repoRoot ?? ("repoRoot" in audit ? audit.repoRoot : undefined);
    if (!row) {
      report(`⚠️ ${progress} Kept ${statusPath(path)}: no longer found`);
      kept += 1;
      continue;
    }
    if (row.decision !== DECISIONS.REMOVE_CANDIDATE) {
      report(
        `⚠️ ${progress} Kept ${statusPath(path)}: latest status is ${row.decision}`,
      );
      kept += 1;
      continue;
    }
    if (!repoRoot) {
      report(`⚠️ ${progress} Kept ${statusPath(path)}: repository is unknown`);
      kept += 1;
      continue;
    }
    if (
      !verifyFn({
        repoRoot,
        row,
        allowWarnings: row.warnings.length > 0,
      })
    ) {
      report(`⚠️ ${progress} Kept ${statusPath(path)}: validation failed`);
      kept += 1;
      continue;
    }
    onStatus?.(`🗑️ ${progress} Removing ${statusPath(path)}...`);
    const result = removeFn({
      repoRoot,
      path: row.path,
      force: row.warnings.length > 0,
    });
    if (result.status === 0) {
      report(`✅ ${progress} Deleted ${statusPath(row.path)}`);
      deletedPaths.add(row.path);
      removed += 1;
    } else {
      const detail = result.stderr.trim() || `exit status ${result.status}`;
      report(`❌ ${progress} Failed ${statusPath(row.path)}: ${detail}`);
      failed += 1;
    }
  }
  const summary =
    `✅ Deletion finished: ${removed} deleted · ${kept} kept · ${failed} failed`;
  report(summary);
  return {
    audit: withoutDeletedRows(latestAudit, deletedPaths),
    removed,
    kept,
    failed,
  };
}

interface RawCliInput extends CliInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
  pause(): unknown;
  resume(): unknown;
  setRawMode(mode: boolean): unknown;
}

interface SessionCommandResult {
  closed: boolean;
  render: boolean;
}

interface InteractiveController {
  getState(): {
    audit: Audit;
    filter: Filter;
    selected: Set<string>;
    cursorPath: string | null;
    pendingDeletion: Set<string> | null;
    status: string;
    busy: boolean;
  };
  move(direction: "up" | "down"): void;
  toggleSelection(): void;
  submit(value: string): Promise<SessionCommandResult>;
}

function createInteractiveController({
  audit,
  args,
  output,
  errorOutput,
  auditFn,
  rootAuditFn,
  removeFn,
  verifyFn,
  onUpdate,
}: InteractiveSessionOptions): InteractiveController {
  let currentAudit = audit;
  let filter: Filter = DEFAULT_FILTER;
  let selected = new Set<string>();
  let cursorPath: string | null =
    navigationRows(currentAudit, filter)[0]?.path ?? null;
  let pendingDeletion: Set<string> | null = null;
  let status = "";
  let busy = false;
  let closed = false;

  const notify = (): void => {
    onUpdate?.();
  };
  const setStatus = (message: string): void => {
    status = message;
    notify();
  };

  const normalizeCursor = (): void => {
    const rows = navigationRows(currentAudit, filter);
    if (rows.some((row) => row.path === cursorPath)) return;
    cursorPath = rows[0]?.path ?? null;
  };

  const controller: InteractiveController = {
    getState: () => ({
      audit: currentAudit,
      filter,
      selected,
      cursorPath,
      pendingDeletion,
      status,
      busy,
    }),
    move(direction) {
      cursorPath = moveCursor(currentAudit, filter, cursorPath, direction);
    },
    toggleSelection() {
      const row = navigationRows(currentAudit, filter).find(
        (candidate) => candidate.path === cursorPath,
      );
      if (!row) {
        setStatus("⚠️ No worktree is focused.");
      } else if (selected.has(row.path)) {
        selected.delete(row.path);
        setStatus(`↩️ Unselected ${statusPath(row.path)}`);
      } else {
        selected.add(row.path);
        setStatus(`✅ Selected ${statusPath(row.path)}`);
      }
    },
    async submit(value) {
      const line = String(value ?? "").trim();
      if (pendingDeletion) {
        if (confirmationAccepted(line)) {
          const pathsToDelete = [...pendingDeletion];
          pendingDeletion = null;
          selected = new Set();
          busy = true;
          setStatus(
            `⏳ Starting deletion of ${pathsToDelete.length} worktree(s)...`,
          );
          try {
            const result = await executeDeletion({
              audit: currentAudit,
              paths: pathsToDelete,
              args,
              output,
              errorOutput,
              auditFn,
              rootAuditFn,
              removeFn,
              verifyFn,
              onStatus: setStatus,
            });
            currentAudit = result.audit;
            normalizeCursor();
            setStatus(
              `✅ Finished: ${result.removed} deleted · ${result.kept} kept · ${result.failed} failed`,
            );
          } catch (error) {
            setStatus(`❌ Deletion failed: ${errorMessage(error)}`);
            throw error;
          } finally {
            busy = false;
            notify();
          }
        } else if (["/cancel", "cancel"].includes(line.toLowerCase())) {
          pendingDeletion = null;
          selected = new Set();
          setStatus("↩️ Deletion cancelled. Selection cleared.");
        } else if (
          ["/q", "/quit", "/exit", "q", "quit", "exit"].includes(
            line.toLowerCase(),
          )
        ) {
          pendingDeletion = null;
          selected = new Set();
          closed = true;
          return { closed: true, render: false };
        } else {
          pendingDeletion = null;
          selected = new Set();
          setStatus(
            "⚠️ Deletion cancelled: type DELETE or confirm next time. Selection cleared.",
          );
        }
        return { closed, render: true };
      }

      const parsed = parseInteractiveCommand(line);
      if (parsed.command === "noop") return { closed, render: false };
      if (["q", "quit", "exit"].includes(parsed.command)) {
        closed = true;
        return { closed: true, render: false };
      }
      if (parsed.command === "help" || parsed.command === "?") {
        output.write(`${HELP}\n`);
      } else if (parsed.command === "list" || parsed.command === "show") {
        return { closed, render: true };
      } else if (parsed.command === "filter") {
        const nextFilter = parsed.argument || DEFAULT_FILTER;
        if (!isFilter(nextFilter)) {
          setStatus(
            `❌ Unknown filter: ${nextFilter}. Values: ${[...FILTERS].join(", ")}`,
          );
        } else {
          filter = nextFilter;
          normalizeCursor();
          setStatus(`🔎 Filter: ${filter}`);
        }
      } else if (parsed.command === "safe") {
        selected = new Set(
          safeRows(currentAudit.rows).map((row) => row.path),
        );
        filter = SAFE_FILTER;
        normalizeCursor();
        setStatus(`✅ Selected ${selected.size} SAFE worktree(s).`);
      } else if (
        ["clear", "unselect"].includes(parsed.command) &&
        !parsed.argument
      ) {
        selected = new Set();
        setStatus("↩️ Selection cleared.");
      } else if (["select", "unselect"].includes(parsed.command)) {
        const rows = navigationRows(currentAudit, filter);
        const selection = parseSelection(
          parsed.argument,
          rows.length,
        );
        if (selection.invalid.length > 0) {
          output.write(`Invalid rows: ${selection.invalid.join(", ")}\n`);
        }
        for (const index of selection.indexes) {
          const row = rowIndexMap(currentAudit.rows).get(index);
          if (!row || !rows.includes(row)) {
            output.write(`Row not visible: ${index}\n`);
          } else if (parsed.command === "select") {
            selected.add(row.path);
          } else {
            selected.delete(row.path);
          }
        }
      } else if (parsed.command === "preview") {
        const chosen = selectedRows(currentAudit, selected);
        if (chosen.length === 0) {
          setStatus(
            selected.size > 0
              ? "⚠️ No SAFE selection can be deleted."
              : "ℹ️ No deletion selected.",
          );
        } else {
          printPreview(output, chosen);
          setStatus(`👀 Preview ready: ${chosen.length} SAFE worktree(s).`);
        }
      } else if (parsed.command === "delete") {
        const chosen = selectedRows(currentAudit, selected);
        if (chosen.length === 0) {
          setStatus(
            selected.size > 0
              ? "⚠️ No SAFE selection can be deleted. Select a SAFE row."
              : "ℹ️ No deletion selected. Use /safe or /select.",
          );
        } else {
          printPreview(output, chosen);
          if (chosen.some((row) => row.warnings.length > 0)) {
            output.write(
              "Warning: selected worktree(s) have local risk warnings. Forced removal will be used after confirmation.\n",
            );
          }
          output.write(
            `Type ${DELETE_CONFIRMATION} or confirm to continue, or /cancel.\n`,
          );
          pendingDeletion = new Set(chosen.map((row) => row.path));
          setStatus(
            `⚠️ Confirmation required: ${chosen.length} worktree(s) queued for deletion.`,
          );
        }
      } else if (parsed.command === "cancel") {
        setStatus("ℹ️ No deletion is pending.");
      } else if (parsed.command === "refresh") {
        busy = true;
        setStatus("⏳ Refreshing the audit...");
        try {
          currentAudit = await collectAudit(
            args,
            errorOutput,
            auditFn,
            rootAuditFn,
            setStatus,
          );
          selected = new Set();
          normalizeCursor();
          setStatus(
            `✅ Audit refreshed: ${currentAudit.rows.length} worktree(s).`,
          );
        } catch (error) {
          setStatus(`❌ Refresh failed: ${errorMessage(error)}`);
          throw error;
        } finally {
          busy = false;
          notify();
        }
      } else if (parsed.command === "json") {
        output.write(`${JSON.stringify(currentAudit, null, 2)}\n`);
      } else if (parsed.command === "plain") {
        output.write(`${renderAudit(currentAudit, { color: false })}\n`);
      } else {
        output.write(`Unknown command: ${parsed.command}. Type /help.\n`);
      }
      return { closed, render: true };
    },
  };

  return controller;
}

function canUseRawInteractiveSession(
  input: CliInput,
  output: CliOutput,
): input is RawCliInput {
  return Boolean(
    input.isTTY &&
      output.isTTY &&
      typeof (input as Partial<RawCliInput>).setRawMode === "function" &&
      typeof (input as Partial<RawCliInput>).on === "function",
  );
}

function renderSession(
  controller: InteractiveController,
  output: CliOutput,
  additionalLines = 0,
): string {
  const state = controller.getState();
  return renderInteractive(state.audit, {
    selected: state.selected,
    filter: state.filter,
    cursorPath: state.cursorPath,
    status: state.status,
    columns: output.columns,
    rows: output.rows ?? (output.isTTY ? DEFAULT_TERMINAL_ROWS : undefined),
    additionalLines,
    color:
      output.color ??
      Boolean(output.isTTY && process.env.NO_COLOR === undefined),
  });
}

async function runLineInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<number> {
  const { input = process.stdin, output = process.stdout } = options;
  let requestRender = (): void => {};
  const controller = createInteractiveController({
    ...options,
    onUpdate: () => requestRender(),
  });
  let closed = false;
  const show = (): void => {
    output.write(`${renderSession(controller, output)}\n`);
  };
  requestRender = show;
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
        const result = await controller.submit(line);
        if (result.closed) {
          readline.close();
          return;
        }
        if (result.render) show();
      } catch (error) {
        output.write(`Error: ${errorMessage(error)}\n`);
      } finally {
        if (!closed) {
          readline.resume();
          readline.prompt();
        }
      }
    });
  });
}

const ANSI_CLEAR_SCREEN = "\u001b[2J\u001b[H";
const ANSI_HIDE_CURSOR = "\u001b[?25l";
const ANSI_SHOW_CURSOR = "\u001b[?25h";

async function runRawInteractiveSession(
  options: InteractiveSessionOptions & { input: RawCliInput },
): Promise<number> {
  const { input, output = process.stdout } = options;
  let lastMessage = "";
  const messageOutput: CliOutput = {
    isTTY: true,
    columns: output.columns,
    rows: output.rows,
    color: options.output?.color,
    write(chunk) {
      lastMessage += String(chunk);
      return true;
    },
  };
  let requestRender = (): void => {};
  const controller = createInteractiveController({
    ...options,
    output: messageOutput,
    errorOutput: messageOutput,
    onUpdate: () => requestRender(),
  });
  let pendingEscape = "";
  let commandBuffer = "";
  let closed = false;
  let keyQueue = Promise.resolve();
  let resolveSession: ((code: number) => void) | null = null;

  const render = (): void => {
    const state = controller.getState();
    const prompt = state.busy
      ? "working> "
      : state.pendingDeletion
        ? "confirm> "
        : PROMPT;
    const message = lastMessage.trimEnd();
    const messageLines = message.length > 0 ? message.split(/\r?\n/u).length : 0;
    const messageBlock = message.length > 0 ? `\n${message}` : "";
    output.write(
      `${ANSI_CLEAR_SCREEN}${ANSI_HIDE_CURSOR}${renderSession(controller, output, messageLines)}${messageBlock}\n\n${prompt}${commandBuffer}`,
    );
  };
  requestRender = render;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    input.removeListener("data", onData);
    input.setRawMode(false);
    input.pause();
    output.write(`${ANSI_SHOW_CURSOR}\nSession ended.\n`);
    resolveSession?.(0);
    resolveSession = null;
  };
  const submit = async (): Promise<void> => {
    const value = commandBuffer.trim();
    if (!value) {
      render();
      return;
    }
    lastMessage = "";
    commandBuffer = "";
    const result = await controller.submit(value);
    if (result.closed) {
      finish();
      return;
    }
    render();
  };
  const handleKey = async (key: TerminalKey): Promise<void> => {
    if (closed) return;
    if (controller.getState().busy) return;
    if (key.kind === "interrupt") {
      finish();
    } else if (key.kind === "up" || key.kind === "down") {
      commandBuffer = "";
      controller.move(key.kind);
      render();
    } else if (key.kind === "space" && commandBuffer.length === 0) {
      lastMessage = "";
      controller.toggleSelection();
      render();
    } else if (key.kind === "space") {
      commandBuffer += " ";
      render();
    } else if (key.kind === "backspace") {
      commandBuffer = Array.from(commandBuffer).slice(0, -1).join("");
      render();
    } else if (key.kind === "escape") {
      commandBuffer = "";
      render();
    } else if (key.kind === "enter") {
      await submit();
    } else if (key.kind === "character") {
      if (commandBuffer.length === 0 && key.value.toLowerCase() === "q") {
        await controller.submit("/quit");
        finish();
      } else if (commandBuffer.length === 0 && key.value === "?") {
        lastMessage = "";
        await controller.submit("/help");
        render();
      } else {
        commandBuffer += key.value;
        render();
      }
    }
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parsed = parseTerminalKeys(text, pendingEscape);
    pendingEscape = parsed.pendingEscape;
    for (const key of parsed.keys) {
      keyQueue = keyQueue.then(() => handleKey(key));
    }
    keyQueue = keyQueue.catch((error: unknown) => {
      lastMessage = `Error: ${error instanceof Error ? error.message : String(error)}\n`;
      render();
    });
  };

  input.setRawMode(true);
  input.on("data", onData);
  input.resume();
  render();
  return new Promise<number>((resolve) => {
    resolveSession = resolve;
    if (closed) resolve(0);
  });
}

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<number> {
  const { input = process.stdin, output = process.stdout } = options;
  if (canUseRawInteractiveSession(input, output)) {
    return runRawInteractiveSession({ ...options, input });
  }
  return runLineInteractiveSession(options);
}

export async function runCli({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
}: RunCliOptions = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    output.write("Usage: worktree-cleaner [options]\n");
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
        `worktree-cleaner: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
