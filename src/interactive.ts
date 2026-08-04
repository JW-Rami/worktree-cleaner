import { DECISIONS, type Audit, type AuditRow } from "./domain.js";

export interface CliOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): unknown;
}

export type Filter = "all" | "safe" | "review" | "unknown";

export type InteractiveCommand = {
  command: string;
  argument: string;
};

export const DELETE_CONFIRMATION = "DELETE";
export const PROMPT = "audit> ";
export const DEFAULT_FILTER: Filter = "all";
export const SAFE_FILTER: Filter = "safe";
export const FILTERS: ReadonlySet<Filter> = new Set([
  DEFAULT_FILTER,
  SAFE_FILTER,
  "review",
  "unknown",
]);

export type CursorDirection = "up" | "down";

export type TerminalKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "enter" }
  | { kind: "space" }
  | { kind: "backspace" }
  | { kind: "escape" }
  | { kind: "interrupt" }
  | { kind: "character"; value: string };

const ANSI_ESCAPE = "\u001b";
const TERMINAL_KEY_SEQUENCES: ReadonlyArray<readonly [string, TerminalKey]> = [
  [`${ANSI_ESCAPE}[A`, { kind: "up" }],
  [`${ANSI_ESCAPE}OA`, { kind: "up" }],
  [`${ANSI_ESCAPE}[1;5A`, { kind: "up" }],
  [`${ANSI_ESCAPE}[B`, { kind: "down" }],
  [`${ANSI_ESCAPE}OB`, { kind: "down" }],
  [`${ANSI_ESCAPE}[1;5B`, { kind: "down" }],
  [`${ANSI_ESCAPE}[D`, { kind: "left" }],
  [`${ANSI_ESCAPE}OD`, { kind: "left" }],
  [`${ANSI_ESCAPE}[C`, { kind: "right" }],
  [`${ANSI_ESCAPE}OC`, { kind: "right" }],
];

const DEFAULT_TERMINAL_COLUMNS = 100;
export const DEFAULT_TERMINAL_ROWS = 24;
const MIN_TERMINAL_COLUMNS = 80;
const INDEX_COLUMN_WIDTH = 3;
const STATUS_COLUMN_WIDTH = 7;
const SIZE_COLUMN_WIDTH = 6;
const MIN_REPOSITORY_COLUMN_WIDTH = 12;
const MIN_EVIDENCE_COLUMN_WIDTH = 14;
const MIN_ACTIVITY_COLUMN_WIDTH = 10;
const MIN_PATH_COLUMN_WIDTH = 18;
const MIN_TERMINAL_ROWS = 8;
const DASHBOARD_HEADER_LINE_COUNT = 3;
const DASHBOARD_SCROLL_LINE_COUNT = 1;
const DASHBOARD_FOOTER_LINE_COUNT = 5;
const DASHBOARD_FOCUS_LINE_COUNT = 2;
const DASHBOARD_ERROR_LINE_COUNT = 2;
const DASHBOARD_PROMPT_LINE_COUNT = 2;
const MIN_LIST_VIEWPORT_LINES = 1;

export const HELP = `
Commands:
  /help                  Show this help
  /list                  Show visible worktrees
  /filter <name>         Filter: all, safe, review, unknown
  /select <n,...>        Select visible SAFE rows by number
  /safe                  Select all SAFE rows
  /clear                 Clear the selection
  /preview               Preview deletion
  /delete                Request confirmation, then revalidate before deletion
  /refresh               Re-run the full audit
  /json                  Print the structured result
  /plain                 Print the non-interactive report
  /cancel                Cancel the pending confirmation
  /quit                  Exit

Keyboard:
  ↑/↓                    Move the focused row
  Space                  Toggle the focused SAFE row
  Enter                  Edit and run a command
  q                      Exit

SAFE rows are the only selectable rows. Deletion requires the exact DELETE
confirmation and a second Git/process validation.
`;

const MAX_PREVIEW_ROWS = 20;

function rowMatchesFilter(row: AuditRow, filter: Filter): boolean {
  if (filter === DEFAULT_FILTER) return true;
  if (filter === SAFE_FILTER)
    return row.decision === DECISIONS.REMOVE_CANDIDATE;
  if (filter === "review") return row.decision === DECISIONS.REVIEW;
  return row.decision === DECISIONS.UNKNOWN;
}

export function visibleRows(audit: Audit, filter: Filter): AuditRow[] {
  return audit.rows.filter((row) => rowMatchesFilter(row, filter));
}

export function navigationRows(audit: Audit, filter: Filter): AuditRow[] {
  const rows = visibleRows(audit, filter);
  return [
    ...rows.filter((row) => row.decision === DECISIONS.KEEP_MAIN),
    ...rows.filter((row) => row.decision !== DECISIONS.KEEP_MAIN),
  ];
}

export function moveCursor(
  audit: Audit,
  filter: Filter,
  cursorPath: string | null,
  direction: CursorDirection,
): string | null {
  const rows = navigationRows(audit, filter);
  if (rows.length === 0) return null;
  const currentIndex = rows.findIndex((row) => row.path === cursorPath);
  if (currentIndex === -1) {
    return direction === "up" ? rows.at(-1)!.path : rows[0].path;
  }
  const offset = direction === "up" ? -1 : 1;
  return rows[(currentIndex + offset + rows.length) % rows.length].path;
}

export function rowIndexMap(rows: AuditRow[]): Map<number, AuditRow> {
  return new Map(rows.map((row, index) => [index + 1, row]));
}

export function safeRows(rows: AuditRow[]): AuditRow[] {
  return rows.filter((row) => row.decision === DECISIONS.REMOVE_CANDIDATE);
}

export function isFilter(value: string): value is Filter {
  return FILTERS.has(value as Filter);
}

function auditTitle(audit: Audit): string {
  if ("root" in audit) return `workspace: ${audit.root}`;
  return audit.repository ?? "local Git repository";
}

export function parseTerminalKeys(
  chunk: string,
  pendingEscape = "",
): { keys: TerminalKey[]; pendingEscape: string } {
  let input = `${pendingEscape}${chunk}`;
  const keys: TerminalKey[] = [];

  while (input.length > 0) {
    const sequence = TERMINAL_KEY_SEQUENCES.find(([value]) =>
      input.startsWith(value),
    );
    if (sequence) {
      keys.push(sequence[1]);
      input = input.slice(sequence[0].length);
      continue;
    }

    if (input.startsWith(ANSI_ESCAPE)) {
      const isPartialSequence = TERMINAL_KEY_SEQUENCES.some(([value]) =>
        value.startsWith(input),
      );
      if (isPartialSequence) break;
      keys.push({ kind: "escape" });
      input = input.slice(ANSI_ESCAPE.length);
      continue;
    }

    const character = input[0];
    input = input.slice(1);
    if (character === "\r" || character === "\n") {
      keys.push({ kind: "enter" });
    } else if (character === "\u007f" || character === "\b") {
      keys.push({ kind: "backspace" });
    } else if (character === " ") {
      keys.push({ kind: "space" });
    } else if (character === "\u0003" || character === "\u0004") {
      keys.push({ kind: "interrupt" });
    } else {
      keys.push({ kind: "character", value: character });
    }
  }

  return { keys, pendingEscape: input };
}

function terminalColumns(columns: number | undefined): number {
  const numericColumns = columns ?? 0;
  return Number.isFinite(numericColumns) && numericColumns > 0
    ? Math.max(MIN_TERMINAL_COLUMNS, Math.floor(numericColumns))
    : DEFAULT_TERMINAL_COLUMNS;
}

function shortenText(value: unknown, maxLength: number): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = maxLength - 1 - prefixLength;
  return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
}

function shortenPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  const segments = path.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/");
  const prefix = path.startsWith("/") ? "/" : "";
  return shortenText(`${prefix}…/${tail}`, maxLength);
}

function statusLabel(row: AuditRow): string {
  if (row.decision === DECISIONS.REMOVE_CANDIDATE) return "SAFE";
  if (row.decision === DECISIONS.KEEP_MAIN) return "MAIN";
  if (row.decision === DECISIONS.KEEP_DIRTY) return "DIRTY";
  if (row.decision === DECISIONS.KEEP_ACTIVE_CHAT) return "ACTIVE";
  if (row.decision === DECISIONS.REVIEW) return "REVIEW";
  return "UNKNOWN";
}

function compactSize(size: string): string {
  return size.replace(/\s*GiB$/u, "G");
}

function compactPullRequest(row: AuditRow): string {
  if (row.pr.pullRequest) {
    return `#${row.pr.pullRequest.number} ${row.pr.pullRequest.state.toLowerCase()}`;
  }
  const labels: Record<string, string> = {
    NO_BRANCH: "no branch",
    NO_PR: "no PR",
    UNKNOWN_GITHUB: "PR ?",
    AMBIGUOUS: "PR ambiguous",
    MERGED_STALE: "stale PR",
    BRANCH_STALE: "stale branch",
  };
  return labels[row.pr.kind] ?? row.pr.kind.toLowerCase();
}

function compactChat(row: AuditRow): string {
  const thread = row.chat.threads[0];
  if (thread) {
    return thread.status.toLowerCase() === "active" ? "chat*" : "chat";
  }
  if (row.chat.kind === "NO_CHAT") return "nochat";
  return "chat?";
}

function compactEvidence(row: AuditRow): string {
  const pullRequest = compactPullRequest(row);
  return row.chat.kind === "EXACT" && row.chat.threads.length === 0
    ? pullRequest
    : `${pullRequest}·${compactChat(row)}`;
}

function compactActivity(row: AuditRow): string {
  const dirty = `d=${row.dirtyCount ?? "?"}`;
  const open = `o=${row.openProcessCount ?? "?"}`;
  return `${dirty} ${open}`;
}

interface RowFormatOptions {
  selected: Set<string>;
  cursorPath: string | null;
  columns: number;
  repositoryWidth: number;
  pathWidth: number;
  evidenceWidth: number;
  activityWidth: number;
}

type DashboardEntry =
  | { kind: "section"; text: string }
  | { kind: "spacer"; text: "" }
  | { kind: "row"; row: AuditRow; index: number };

function formatRow(
  row: AuditRow,
  index: number,
  {
    selected,
    cursorPath,
    columns,
    repositoryWidth,
    pathWidth,
    evidenceWidth,
    activityWidth,
  }: RowFormatOptions,
): string {
  const cursor = row.path === cursorPath ? "▶" : " ";
  const selection =
    row.decision === DECISIONS.KEEP_MAIN
      ? "◆"
      : row.decision === DECISIONS.REMOVE_CANDIDATE
        ? selected.has(row.path)
          ? "●"
          : "○"
        : "·";
  const repositoryLabel = row.repository ?? row.repoRoot ?? "local";
  const repository = shortenText(repositoryLabel, repositoryWidth);
  const path = shortenPath(row.path, pathWidth);
  const evidence = shortenText(compactEvidence(row), evidenceWidth);
  const activity = shortenText(compactActivity(row), activityWidth);
  const indexLabel = String(index).padStart(INDEX_COLUMN_WIDTH);
  const size = compactSize(row.size).padStart(SIZE_COLUMN_WIDTH);
  const status = statusLabel(row).padEnd(STATUS_COLUMN_WIDTH);
  const rowText = `${cursor} ${selection} ${indexLabel} ${status} ${size} ${repository.padEnd(repositoryWidth)} ${path.padEnd(pathWidth)} ${evidence.padEnd(evidenceWidth)} ${activity}`;
  return rowText.slice(0, columns).trimEnd();
}

function terminalRows(rows: number | undefined): number | null {
  const numericRows = rows ?? 0;
  return Number.isFinite(numericRows) && numericRows > 0
    ? Math.max(MIN_TERMINAL_ROWS, Math.floor(numericRows))
    : null;
}

function buildDashboardEntries(
  mainRows: AuditRow[],
  linkedRows: AuditRow[],
  rowNumbers: Map<string, number>,
): DashboardEntry[] {
  const entries: DashboardEntry[] = [];
  if (mainRows.length > 0) {
    entries.push({
      kind: "section",
      text: `MAIN WORKTREES (${mainRows.length})`,
    });
    entries.push(
      ...mainRows.map((row) => ({
        kind: "row" as const,
        row,
        index: rowNumbers.get(row.path) ?? 0,
      })),
    );
    entries.push({ kind: "spacer", text: "" });
  }
  if (linkedRows.length > 0) {
    const linkedSectionLabel = mainRows.length > 0 ? "LINKED" : "";
    entries.push({
      kind: "section",
      text: `${linkedSectionLabel} WORKTREES (${linkedRows.length})`.trim(),
    });
    entries.push(
      ...linkedRows.map((row) => ({
        kind: "row" as const,
        row,
        index: rowNumbers.get(row.path) ?? 0,
      })),
    );
  }
  return entries;
}

function dashboardEntryText(
  entry: DashboardEntry,
  formatOptions: RowFormatOptions,
): string {
  if (entry.kind !== "row") return entry.text;
  return formatRow(entry.row, entry.index, formatOptions);
}

function viewportForEntries(
  entries: DashboardEntry[],
  cursorPath: string | null,
  viewportLines: number,
): { start: number; end: number } {
  if (entries.length <= viewportLines) return { start: 0, end: entries.length };
  const cursorIndex = entries.findIndex(
    (entry) => entry.kind === "row" && entry.row.path === cursorPath,
  );
  if (cursorIndex < 0) return { start: 0, end: viewportLines };
  const start = Math.min(
    Math.max(0, cursorIndex - viewportLines + 1),
    entries.length - viewportLines,
  );
  return { start, end: start + viewportLines };
}

function scrollStatus(
  rows: AuditRow[],
  cursorPath: string | null,
  start: number,
  end: number,
  totalEntries: number,
): string {
  const cursorIndex = rows.findIndex((row) => row.path === cursorPath);
  const position =
    cursorIndex < 0
      ? `rows 0/${rows.length}`
      : `row ${cursorIndex + 1}/${rows.length}`;
  const hints = [
    start > 0 ? "↑ more" : "",
    end < totalEntries ? "↓ more" : "",
  ].filter(Boolean);
  return hints.length > 0 ? `${position} · ${hints.join(" · ")}` : position;
}

export function renderInteractive(
  audit: Audit,
  {
    selected = new Set<string>(),
    filter = DEFAULT_FILTER,
    cursorPath = null,
    columns,
    rows: terminalRowValue,
  }: {
    selected?: Set<string>;
    filter?: Filter;
    cursorPath?: string | null;
    columns?: number;
    rows?: number;
  } = {},
): string {
  const width = terminalColumns(columns);
  const height = terminalRows(terminalRowValue);
  const rows = navigationRows(audit, filter);
  const mainRows = rows.filter((row) => row.decision === DECISIONS.KEEP_MAIN);
  const linkedRows = rows.filter((row) => row.decision !== DECISIONS.KEEP_MAIN);
  const rowNumbers = new Map(
    rows.map((row, index) => [row.path, index + 1]),
  );
  const safeCount = safeRows(audit.rows).length;
  const selectedCount = selectedRows(audit, selected).length;
  const variableColumns = width - 23;
  const repositoryWidth = Math.max(
    MIN_REPOSITORY_COLUMN_WIDTH,
    Math.min(24, Math.floor(variableColumns * 0.22)),
  );
  const evidenceWidth = Math.max(
    MIN_EVIDENCE_COLUMN_WIDTH,
    Math.min(22, Math.floor(variableColumns * 0.2)),
  );
  const activityWidth = Math.max(
    MIN_ACTIVITY_COLUMN_WIDTH,
    Math.min(18, Math.floor(variableColumns * 0.16)),
  );
  const pathWidth = Math.max(
    MIN_PATH_COLUMN_WIDTH,
    variableColumns - repositoryWidth - evidenceWidth - activityWidth - 3,
  );
  const mainCount = audit.rows.filter(
    (row) => row.decision === DECISIONS.KEEP_MAIN,
  ).length;
  const formatOptions: RowFormatOptions = {
    selected,
    cursorPath,
    columns: width,
    repositoryWidth,
    pathWidth,
    evidenceWidth,
    activityWidth,
  };
  const entries = buildDashboardEntries(mainRows, linkedRows, rowNumbers);
  const cursorRow = rows.find((row) => row.path === cursorPath);
  const hasErrors = "errors" in audit && audit.errors.length > 0;
  const reservedLines =
    DASHBOARD_HEADER_LINE_COUNT +
    DASHBOARD_SCROLL_LINE_COUNT +
    DASHBOARD_FOOTER_LINE_COUNT +
    (cursorRow ? DASHBOARD_FOCUS_LINE_COUNT : 0) +
    (hasErrors ? DASHBOARD_ERROR_LINE_COUNT : 0) +
    (height ? DASHBOARD_PROMPT_LINE_COUNT : 0);
  const viewportLines = height
    ? Math.max(MIN_LIST_VIEWPORT_LINES, height - reservedLines)
    : entries.length;
  const viewport = viewportForEntries(entries, cursorPath, viewportLines);
  const lines = [
    `Worktree Audit  ${shortenText(auditTitle(audit), width - 16)}`,
    `${audit.rows.length} worktrees · ${mainCount} main · ${safeCount} safe · ${selectedCount} selected · filter=${filter}`,
    "",
  ];
  if (height) {
    lines.push(
      scrollStatus(
        rows,
        cursorPath,
        viewport.start,
        viewport.end,
        entries.length,
      ),
    );
  }
  if (entries.length === 0) {
    lines.push("No rows for this filter.");
  } else {
    lines.push(
      ...entries
        .slice(viewport.start, viewport.end)
        .map((entry) => dashboardEntryText(entry, formatOptions)),
    );
  }
  lines.push(
    "",
    "↑/↓ move · space select · enter command · /help · q quit",
    "Commands: /safe /preview /delete /refresh /quit",
    "○ SAFE selectable · ◆ MAIN protected",
    "· REVIEW/UNKNOWN kept · d=dirty · o=open",
  );
  if (cursorRow) {
    lines.push(
      "",
      shortenText(
        `Focus: ${shortenPath(cursorRow.path, width - 7)} · branch=${shortenText(cursorRow.branch ?? "detached", 24)}`,
        width,
      ),
    );
  }
  if ("errors" in audit && audit.errors.length > 0) {
    lines.push(
      "",
      shortenText(
        `⚠️ ${audit.errors.length} error(s): ${audit.errors
          .map((error) => shortenPath(error.path, 28))
          .join(", ")}`,
        width,
      ),
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

export function parseInteractiveCommand(line: unknown): InteractiveCommand {
  const value = String(line ?? "").trim();
  if (!value) return { command: "noop", argument: "" };
  const normalized = value.startsWith("/") ? value.slice(1) : value;
  const [command = "", ...rest] = normalized.split(/\s+/u);
  return { command: command.toLowerCase(), argument: rest.join(" ") };
}

export function selectedRows(audit: Audit, selected: Set<string>): AuditRow[] {
  return audit.rows.filter(
    (row) =>
      row.decision === DECISIONS.REMOVE_CANDIDATE && selected.has(row.path),
  );
}

export function filterMergedOnly(audit: Audit): Audit {
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

export function printPreview(output: CliOutput, rows: AuditRow[]): void {
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
