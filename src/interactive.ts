import {
  DECISIONS,
  type ActivityEvidence,
  type Audit,
  type AuditRow,
} from "./domain.js";

export interface CliOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  color?: boolean;
  write(chunk: string): unknown;
}

export type Filter = "all" | "safe" | "review" | "unknown";

export type InputMode = "navigate" | "command" | "confirm";

export type InteractiveCommand = {
  command: string;
  argument: string;
};

export const DELETE_CONFIRMATION = "DELETE";
export const PROMPT = "audit> ";
export const COMMAND_PROMPT = "command> ";
export const CONFIRM_PROMPT = "confirm> ";
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
  | { kind: "redraw" }
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
const MIN_TERMINAL_COLUMNS = 40;
const INDEX_COLUMN_WIDTH = 3;
const STATUS_COLUMN_WIDTH = 7;
const MIN_REPOSITORY_COLUMN_WIDTH = 12;
const MIN_ACTIVITY_COLUMN_WIDTH = 10;
const MIN_PATH_COLUMN_WIDTH = 18;
const MIN_BRANCH_COLUMN_WIDTH = 10;
const ROW_FIXED_COLUMN_COUNT = 21;
const MIN_TERMINAL_ROWS = 8;
const DASHBOARD_SCROLL_LINE_COUNT = 1;
const DASHBOARD_FOCUS_HEADER_LINE_COUNT = 1;
const DASHBOARD_EVENT_LINE_COUNT = 3;
const DASHBOARD_ERROR_LINE_COUNT = 1;
const MIN_LIST_VIEWPORT_LINES = 1;
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";
const SELECTION_MARKERS = Object.freeze({
  selected: "[x]",
  unselected: "[ ]",
  warning: "!",
  blocked: "?",
  main: "M",
} as const);

export const HELP = `
Keyboard:
  ↑/↓      Move the focused row
  Space    Select or unselect the focused row
  Enter    Open the command input
  Esc      Cancel command input or confirmation
  ?        Show this help
  q        Quit from navigation mode

Commands:
  /help, /?                 Show this help
  /filter <all|safe|...>    Change the visible list
  /select <n,...>           Select visible rows by number or range
  /safe                    Select all SAFE rows
  /clear                   Clear the selection
  /details                 Show the focused row details
  /errors                  Show all scan errors
  /preview                 Preview the selected deletion
  /delete                  Confirm, revalidate, remove, and refresh
  /refresh                 Re-run the full audit
  /json                    Print the structured result
  /plain                   Print the non-interactive report
  /quit                    Exit

The left gutter is always explicit: [x] selected, [ ] unselected, ! warning,
? evidence unavailable, M protected main worktree. Local warnings do not make
a verified SAFE row undeletable. Missing PR or chat identity evidence is shown
separately as the reason a row is not SAFE.
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
    } else if (character === "\u000c") {
      keys.push({ kind: "redraw" });
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
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = maxLength - 1 - prefixLength;
  return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
}

function shortenPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path;
  if (maxLength <= 1) return "…";
  const segments = path.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/");
  const prefix = path.startsWith("/") ? "/" : "";
  return shortenText(`${prefix}…/${tail}`, maxLength);
}

function fitLine(value: string, width: number): string {
  return shortenText(value, Math.max(1, width));
}

function wrapContent(value: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = "";
  };

  for (const word of value.split(/\s+/u).filter(Boolean)) {
    if (word.length > maxWidth) {
      flush();
      for (let offset = 0; offset < word.length; offset += maxWidth) {
        lines.push(word.slice(offset, offset + maxWidth));
      }
      continue;
    }
    const next = current.length > 0 ? `${current} ${word}` : word;
    if (next.length > maxWidth) {
      flush();
      current = word;
    } else {
      current = next;
    }
  }
  flush();
  return lines.length > 0 ? lines : [""];
}

function wrapValue(label: string, value: string, width: number): string[] {
  const prefix = `${label}: `;
  const available = Math.max(1, width - prefix.length);
  const contentLines = wrapContent(value, available);
  return contentLines.map((line, index) =>
    fitLine(index === 0 ? `${prefix}${line}` : `  ${line}`, width),
  );
}

function statusLabel(row: AuditRow): string {
  if (row.decision === DECISIONS.REMOVE_CANDIDATE) return "SAFE";
  if (row.decision === DECISIONS.KEEP_MAIN) return "MAIN";
  if (row.decision === DECISIONS.KEEP_DIRTY) return "DIRTY";
  if (row.decision === DECISIONS.KEEP_ACTIVE_CHAT) return "ACTIVE";
  if (row.decision === DECISIONS.REVIEW) return "REVIEW";
  return "UNKNOWN";
}

function rowWarnings(row: AuditRow): AuditRow["warnings"] {
  return row.warnings ?? [];
}

function blockingReason(row: AuditRow): string | null {
  const reasons: string[] = [];
  if (row.decision === DECISIONS.KEEP_MAIN) {
    reasons.push("main worktree is protected");
  }
  if (row.pr.kind === "UNKNOWN_GITHUB") {
    reasons.push("GitHub PR evidence unavailable");
  } else if (row.pr.kind !== "MERGED_EXACT") {
    reasons.push(`PR evidence: ${compactPullRequest(row)}`);
  }
  if (row.chat.kind === "UNKNOWN_CHAT") {
    reasons.push("Codex chat evidence unavailable");
  }
  return reasons.length > 0 ? reasons.join(" · ") : null;
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

function branchLabel(row: AuditRow): string {
  return row.branch ?? (row.detached ? "detached" : "unknown");
}

function compactTimestamp(timestamp: string): string {
  const normalized = new Date(timestamp);
  if (Number.isNaN(normalized.valueOf())) return "?";
  const iso = normalized.toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

function activityLabel(activity: ActivityEvidence | undefined): string {
  if (!activity || activity.source === "unknown") return "activity ?";
  const source = activity.source === "chat" ? "C" : "F";
  return `${source} ${compactTimestamp(activity.timestamp)}`;
}

function fullActivityLabel(activity: ActivityEvidence | undefined): string {
  if (!activity || activity.source === "unknown") return "unknown";
  return `${activity.source} ${activity.timestamp}`;
}

function compactActivity(row: AuditRow): string {
  return activityLabel(row.activity);
}

interface RowFormatOptions {
  selected: Set<string>;
  cursorPath: string | null;
  columns: number;
  indexWidth: number;
  repositoryWidth: number;
  branchWidth: number;
  pathWidth: number;
  activityWidth: number;
  color: boolean;
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
    indexWidth,
    repositoryWidth,
    branchWidth,
    pathWidth,
    activityWidth,
    color,
  }: RowFormatOptions,
): string {
  const cursor = row.path === cursorPath ? "▶" : " ";
  const isSelected = selected.has(row.path);
  const hasWarnings = rowWarnings(row).length > 0;
  const isSafe = row.decision === DECISIONS.REMOVE_CANDIDATE;
  const isSafeSelected = isSafe && isSelected;
  const marker = row.decision === DECISIONS.KEEP_MAIN
    ? SELECTION_MARKERS.main
    : hasWarnings
      ? SELECTION_MARKERS.warning
      : isSafe
        ? " "
        : SELECTION_MARKERS.blocked;
  const selection = isSelected
    ? SELECTION_MARKERS.selected
    : SELECTION_MARKERS.unselected;
  const repositoryLabel = row.repository ?? row.repoRoot ?? "local";
  const repository = shortenText(repositoryLabel, repositoryWidth);
  const branch = shortenText(branchLabel(row), branchWidth);
  const path = shortenPath(row.path, pathWidth);
  const activity = shortenText(compactActivity(row), activityWidth);
  const indexLabel = String(index).padStart(indexWidth);
  const status = statusLabel(row).padEnd(STATUS_COLUMN_WIDTH);
  const rowText = [
    `${cursor} ${marker} ${selection} ${indexLabel} ${status}`,
    repository.padEnd(repositoryWidth),
    branch.padEnd(branchWidth),
    activity.padEnd(activityWidth),
    path,
  ].join(" ");
  const visibleRow = fitLine(rowText, columns);
  if (!color || !isSelected) return visibleRow;
  const ansiColor = isSafeSelected && !hasWarnings ? ANSI_GREEN : ANSI_YELLOW;
  return `${ansiColor}${ANSI_BOLD}${visibleRow}${ANSI_RESET}`;
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
  visibleEntries: DashboardEntry[],
): string {
  const cursorIndex = rows.findIndex((row) => row.path === cursorPath);
  const visibleRows = visibleEntries
    .filter((entry): entry is Extract<DashboardEntry, { kind: "row" }> =>
      entry.kind === "row",
    )
    .map((entry) => entry.index);
  const firstVisible = visibleRows[0] ?? 0;
  const lastVisible = visibleRows.at(-1) ?? 0;
  const position =
    cursorIndex < 0
      ? `focus 0/${rows.length}`
      : `focus ${cursorIndex + 1}/${rows.length}`;
  const viewport =
    firstVisible > 0
      ? `rows ${firstVisible}-${lastVisible} of ${rows.length}`
      : `rows 0 of ${rows.length}`;
  return `${position} · ${viewport}`;
}

function evidenceDetails(row: AuditRow): string {
  const pr = row.pr.pullRequest
    ? `PR #${row.pr.pullRequest.number} ${row.pr.pullRequest.state}`
    : `PR ${row.pr.kind.toLowerCase()}`;
  const chat = row.chat.threads[0]
    ? `chat ${row.chat.threads[0].status.toLowerCase()}`
    : `chat ${row.chat.kind.toLowerCase()}`;
  return `${pr} · ${chat}`;
}

function localDetails(row: AuditRow): string {
  const dirty = row.dirtyCount === null ? "dirty ?" : `dirty ${row.dirtyCount}`;
  const processes = row.openProcessCount === null
    ? "processes ?"
    : `processes ${row.openProcessCount}`;
  const ignored = row.ignoredUnknownCount === null
    ? "ignored ?"
    : `ignored unknown ${row.ignoredUnknownCount}`;
  return `${dirty} · ${processes} · ${ignored} · size ${row.size}`;
}

function focusedDetails(
  row: AuditRow,
  position: string,
  width: number,
  compact = false,
): string[] {
  if (compact) {
    const warningSummary = rowWarnings(row).length > 0
      ? ` · warnings: ${rowWarnings(row).map((warning) => warning.message).join("; ")}`
      : "";
    return [
      `FOCUS ${position} · ${statusLabel(row)} · ${row.repository ?? row.repoRoot ?? "local repository"}`,
      ...wrapValue("Path", row.path, width),
      ...wrapValue("Branch", branchLabel(row), width),
      ...wrapValue("Evidence", evidenceDetails(row), width),
      ...wrapValue(
        "Activity",
        `${fullActivityLabel(row.activity)} · ${localDetails(row)}`,
        width,
      ),
      ...wrapValue(
        "Decision",
        `${blockingReason(row) ?? "eligible for deletion after confirmation"}${warningSummary}`,
        width,
      ),
    ];
  }

  const lines = [
    `FOCUS ${position} · ${statusLabel(row)} · ${row.repository ?? row.repoRoot ?? "local repository"}`,
    ...wrapValue("Path", row.path, width),
    ...wrapValue("Branch", branchLabel(row), width),
    ...wrapValue("Evidence", evidenceDetails(row), width),
    ...wrapValue("Activity", fullActivityLabel(row.activity), width),
    ...wrapValue("Local", localDetails(row), width),
    ...wrapValue(
      "Decision",
      blockingReason(row) ?? "eligible for deletion after confirmation",
      width,
    ),
  ];
  const warnings = rowWarnings(row);
  if (warnings.length > 0) {
    lines.push(
      ...wrapValue(
        "Warnings",
        warnings.map((warning) => warning.message).join(" · "),
        width,
      ),
    );
  }
  return lines;
}

function modeHint(mode: InputMode): string {
  if (mode === "command") {
    return "COMMAND MODE · type /help, /delete, /refresh · Enter run · Esc cancel";
  }
  if (mode === "confirm") {
    return "CONFIRMATION · type DELETE to continue · Esc cancels and clears selection";
  }
  return "NAVIGATION · ↑/↓ move · Space select · Enter commands · ? help · q quit";
}

export function renderInteractive(
  audit: Audit,
  {
    selected = new Set<string>(),
    filter = DEFAULT_FILTER,
    cursorPath = null,
    columns,
    rows: terminalRowValue,
    additionalLines = 0,
    status = "",
    events = [],
    mode = "navigate",
    commandBuffer = "",
    updatedAt,
    busy = false,
    color = false,
  }: {
    selected?: Set<string>;
    filter?: Filter;
    cursorPath?: string | null;
    columns?: number;
    rows?: number;
    additionalLines?: number;
    status?: string;
    events?: string[];
    mode?: InputMode;
    commandBuffer?: string;
    updatedAt?: string | null;
    busy?: boolean;
    color?: boolean;
  } = {},
): string {
  const width = terminalColumns(columns);
  const height = terminalRows(terminalRowValue);
  const rows = navigationRows(audit, filter);
  const activeCursorPath = cursorPath ?? rows[0]?.path ?? null;
  const mainRows = rows.filter((row) => row.decision === DECISIONS.KEEP_MAIN);
  const linkedRows = rows.filter((row) => row.decision !== DECISIONS.KEEP_MAIN);
  const rowNumbers = new Map(
    rows.map((row, index) => [row.path, index + 1]),
  );
  const safeCount = safeRows(audit.rows).length;
  const selectedCount = audit.rows.filter((row) =>
    selected.has(row.path),
  ).length;
  const safeSelectedCount = selectedRows(audit, selected).length;
  const warningCount = audit.rows.filter(
    (row) => rowWarnings(row).length > 0,
  ).length;
  const variableColumns = Math.max(10, width - ROW_FIXED_COLUMN_COUNT);
  const repositoryWidth = Math.max(
    MIN_REPOSITORY_COLUMN_WIDTH,
    Math.min(24, Math.floor(variableColumns * 0.24)),
  );
  const branchWidth = Math.max(
    MIN_BRANCH_COLUMN_WIDTH,
    Math.min(24, Math.floor(variableColumns * 0.24)),
  );
  const activityWidth = Math.max(
    MIN_ACTIVITY_COLUMN_WIDTH,
    Math.min(18, Math.floor(variableColumns * 0.17)),
  );
  const pathWidth = Math.max(
    MIN_PATH_COLUMN_WIDTH,
    variableColumns - repositoryWidth - branchWidth - activityWidth - 3,
  );
  const mainCount = audit.rows.filter(
    (row) => row.decision === DECISIONS.KEEP_MAIN,
  ).length;
  const indexWidth = Math.max(INDEX_COLUMN_WIDTH, String(rows.length).length);
  const formatOptions: RowFormatOptions = {
    selected,
    cursorPath: activeCursorPath,
    columns: width,
    indexWidth,
    repositoryWidth,
    branchWidth,
    pathWidth,
    activityWidth,
    color,
  };
  const entries = buildDashboardEntries(mainRows, linkedRows, rowNumbers);
  const cursorRow = rows.find((row) => row.path === activeCursorPath);
  const hasErrors = "errors" in audit && audit.errors.length > 0;
  const compactLayout = height !== null && height < 28;
  const focusPosition = cursorRow
    ? `${rows.findIndex((row) => row.path === cursorRow.path) + 1}/${rows.length}`
    : `0/${rows.length}`;
  const scope = fitLine(`Scope: ${auditTitle(audit)}`, width);
  const updated = updatedAt
    ? `updated ${new Date(updatedAt).toISOString()}`
    : "updated after audit";
  const overviewLine = [
    `View: ${filter.toUpperCase()}`,
    `${audit.rows.length} worktrees`,
    `${mainCount} main`,
    `${safeCount} safe`,
    `${warningCount} warnings`,
  ].join(" · ");
  const viewLines = [
    overviewLine,
    `Selected: ${selectedCount} · deletable: ${safeSelectedCount}`,
  ].flatMap((line) => wrapContent(line, width));
  const stateLines = wrapContent(
    `State: ${busy ? "working" : "ready"} · ${updated}`,
    width,
  );
  const modeLines = wrapContent(modeHint(mode), width);
  const statusLines = status
    ? wrapContent(`Status: ${status}`, width)
    : [];
  const headerLines = [
    fitLine("Worktree Cleaner", width),
    scope,
    ...viewLines,
    ...stateLines,
    ...modeLines,
  ];
  const details = cursorRow
    ? focusedDetails(cursorRow, focusPosition, width, compactLayout)
    : [];
  const eventLines = compactLayout
    ? []
    : events
        .filter((event) => event.trim().length > 0)
        .slice(-DASHBOARD_EVENT_LINE_COUNT)
        .map((event) => fitLine(`• ${event}`, width));
  const footerLines = compactLayout || mode !== "navigate"
    ? []
    : [
        fitLine(
          "Actions: /safe selects candidates · /preview explains deletion · /delete removes after validation",
          width,
        ),
      ];
  const promptLineCount = additionalLines > 0 ? additionalLines + 3 : 2;
  const reservedLines =
    headerLines.length +
    statusLines.length +
    (height ? DASHBOARD_SCROLL_LINE_COUNT : 0) +
    2 +
    DASHBOARD_FOCUS_HEADER_LINE_COUNT +
    (details.length > 0 ? details.length : 1) +
    (eventLines.length > 0 ? 1 + eventLines.length : 0) +
    (hasErrors ? DASHBOARD_ERROR_LINE_COUNT : 0) +
    footerLines.length +
    promptLineCount;
  const viewportLines = height
    ? Math.max(MIN_LIST_VIEWPORT_LINES, height - reservedLines)
    : entries.length;
  const viewport = viewportForEntries(entries, activeCursorPath, viewportLines);
  const lines = [...headerLines];
  lines.push(...statusLines);
  if (height) {
    lines.push(
      scrollStatus(
        rows,
        activeCursorPath,
        entries.slice(viewport.start, viewport.end),
      ),
    );
  }
  lines.push("-".repeat(Math.min(width, 80)));
  if (entries.length === 0) {
    lines.push("No rows for this filter.");
  } else {
    lines.push(
      ...entries
        .slice(viewport.start, viewport.end)
        .map((entry) => dashboardEntryText(entry, formatOptions)),
    );
  }
  lines.push("-".repeat(Math.min(width, 80)), "FOCUSED WORKTREE");
  lines.push(...(details.length > 0 ? details : ["No worktree is focused."]));
  if (eventLines.length > 0) lines.push("EVENTS", ...eventLines);
  if ("errors" in audit && audit.errors.length > 0) {
    lines.push(fitLine(`ERRORS: ${audit.errors.length} · run /errors for details`, width));
  }
  const inputLine = mode === "command"
    ? `Input: ${commandBuffer || "(empty)"} · Enter run · Esc cancel`
    : mode === "confirm"
      ? "Input: type DELETE exactly, then press Enter"
      : null;
  if (inputLine) lines.push(fitLine(inputLine, width));
  lines.push(...footerLines);
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
    const warnings = rowWarnings(row);
    if (warnings.length > 0) {
      output.write(
        `  ⚠️ ${warnings.map((warning) => warning.message).join(" · ")}\n`,
      );
    }
  });
  if (rows.length > MAX_PREVIEW_ROWS) {
    output.write(`- ... ${rows.length - MAX_PREVIEW_ROWS} more row(s)\n`);
  }
}
