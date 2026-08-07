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
      !verifyFn({
        repoRoot,
        row,
        allowWarnings: row.warnings.length > 0,
      })
    ) {
      output.write(`Kept, insufficient evidence: ${path}\n`);
      continue;
    }
    const result = removeFn({
      repoRoot,
      path: row.path,
      force: row.warnings.length > 0,
    });
    if (result.status === 0) {
      output.write(`Deleted: ${row.path}\n`);
      removed += 1;
    } else {
      output.write(`Deletion failed: ${row.path}\n`);
    }
  }
  return { audit: latestAudit, removed };
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
}: InteractiveSessionOptions): InteractiveController {
  let currentAudit = audit;
  let filter: Filter = DEFAULT_FILTER;
  let selected = new Set<string>();
  let cursorPath: string | null =
    navigationRows(currentAudit, filter)[0]?.path ?? null;
  let pendingDeletion: Set<string> | null = null;
  let closed = false;

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
    }),
    move(direction) {
      cursorPath = moveCursor(currentAudit, filter, cursorPath, direction);
    },
    toggleSelection() {
      const row = navigationRows(currentAudit, filter).find(
        (candidate) => candidate.path === cursorPath,
      );
      if (!row) {
        output.write("No worktree is focused.\n");
      } else if (selected.has(row.path)) {
        selected.delete(row.path);
      } else {
        selected.add(row.path);
      }
    },
    async submit(value) {
      const line = String(value ?? "").trim();
      if (pendingDeletion) {
        if (line === DELETE_CONFIRMATION) {
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
          pendingDeletion = null;
          normalizeCursor();
          output.write(`\n${result.removed} worktree(s) deleted.\n`);
        } else if (["/cancel", "cancel"].includes(line.toLowerCase())) {
          pendingDeletion = null;
          output.write("Deletion cancelled.\n");
        } else if (
          ["/q", "/quit", "/exit", "q", "quit", "exit"].includes(
            line.toLowerCase(),
          )
        ) {
          pendingDeletion = null;
          closed = true;
          return { closed: true, render: false };
        } else {
          pendingDeletion = null;
          output.write("Deletion cancelled: exact confirmation required.\n");
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
          output.write(
            `Unknown filter: ${nextFilter}. Values: ${[...FILTERS].join(", ")}\n`,
          );
        } else {
          filter = nextFilter;
          normalizeCursor();
        }
      } else if (parsed.command === "safe") {
        selected = new Set(
          safeRows(currentAudit.rows).map((row) => row.path),
        );
        filter = SAFE_FILTER;
        normalizeCursor();
      } else if (
        ["clear", "unselect"].includes(parsed.command) &&
        !parsed.argument
      ) {
        selected = new Set();
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
          output.write(
            selected.size > 0
              ? "No SAFE selection can be deleted.\n"
              : "No deletion selected.\n",
          );
        } else {
          printPreview(output, chosen);
        }
      } else if (parsed.command === "delete") {
        const chosen = selectedRows(currentAudit, selected);
        if (chosen.length === 0) {
          output.write(
            selected.size > 0
              ? "No SAFE selection can be deleted. Select a SAFE row.\n"
              : "No deletion selected. Use /safe or /select.\n",
          );
        } else {
          printPreview(output, chosen);
          if (chosen.some((row) => row.warnings.length > 0)) {
            output.write(
              "Warning: selected worktree(s) have local risk warnings. Forced removal will be used after confirmation.\n",
            );
          }
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
        normalizeCursor();
        output.write("Audit refreshed.\n");
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
): string {
  const state = controller.getState();
  return renderInteractive(state.audit, {
    selected: state.selected,
    filter: state.filter,
    cursorPath: state.cursorPath,
    columns: output.columns,
    rows: output.rows ?? (output.isTTY ? DEFAULT_TERMINAL_ROWS : undefined),
    color:
      output.color ??
      Boolean(output.isTTY && process.env.NO_COLOR === undefined),
  });
}

async function runLineInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<number> {
  const { input = process.stdin, output = process.stdout } = options;
  const controller = createInteractiveController(options);
  let closed = false;
  const show = (): void => {
    output.write(`${renderSession(controller, output)}\n`);
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
        const result = await controller.submit(line);
        if (result.closed) {
          readline.close();
          return;
        }
        if (result.render) show();
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
  const controller = createInteractiveController({
    ...options,
    output: messageOutput,
    errorOutput: messageOutput,
  });
  let pendingEscape = "";
  let commandBuffer = "";
  let closed = false;
  let keyQueue = Promise.resolve();
  let resolveSession: ((code: number) => void) | null = null;

  const render = (): void => {
    const state = controller.getState();
    const prompt = state.pendingDeletion ? "confirm> " : PROMPT;
    output.write(
      `${ANSI_CLEAR_SCREEN}${ANSI_HIDE_CURSOR}${lastMessage}${renderSession(controller, output)}\n\n${prompt}${commandBuffer}`,
    );
  };
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
