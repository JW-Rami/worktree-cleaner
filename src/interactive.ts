import { DECISIONS, type Audit, type AuditRow } from "./domain.js";

export interface CliOutput {
  isTTY?: boolean;
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

export const HELP = `
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

export function parseInteractiveCommand(line: unknown): InteractiveCommand {
  const value = String(line ?? "").trim();
  if (!value) return { command: "noop", argument: "" };
  const normalized = value.startsWith("/") ? value.slice(1) : value;
  const [command = "", ...rest] = normalized.split(/\s+/u);
  return { command: command.toLowerCase(), argument: rest.join(" ") };
}

export function selectedRows(audit: Audit, selected: Set<string>): AuditRow[] {
  return audit.rows.filter((row) => selected.has(row.path));
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
