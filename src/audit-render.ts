import { DECISIONS } from "./domain.js";
import type { Audit, AuditRow, Decision } from "./domain.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const MAX_PATH_DISPLAY_LENGTH = 52;

const DECISION_LABELS: Record<Decision, string> = Object.freeze({
  [DECISIONS.REMOVE_CANDIDATE]: "SAFE",
  [DECISIONS.KEEP_MAIN]: "MAIN",
  [DECISIONS.KEEP_DIRTY]: "DIRTY",
  [DECISIONS.KEEP_ACTIVE_CHAT]: "ACTIVE",
  [DECISIONS.REVIEW]: "REVIEW",
  [DECISIONS.UNKNOWN]: "UNKNOWN",
});

function colorize(value: string, color: "bold", enabled: boolean): string {
  return enabled && color === "bold"
    ? `${ANSI_BOLD}${value}${ANSI_RESET}`
    : value;
}

function shortenText(value: unknown, maxLength: number): string {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = maxLength - 1 - prefixLength;
  return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
}

function decisionLabel(decision: Decision): string {
  return DECISION_LABELS[decision] ?? decision;
}

function pullRequestLabel(row: AuditRow): string {
  return row.pr.pullRequest
    ? `PR #${row.pr.pullRequest.number} ${row.pr.pullRequest.state}`
    : row.pr.kind;
}

function chatLabel(row: AuditRow): string {
  const chat = row.chat.threads[0];
  return chat ? `${chat.title} [${chat.status}]` : `chat ${row.chat.kind}`;
}

function branchLabel(row: AuditRow): string {
  return row.branch ?? (row.detached ? "detached" : "unknown");
}

function evidenceLabel(row: AuditRow): string {
  const evidence: string[] = [];
  if (row.pr.pullRequest) evidence.push(pullRequestLabel(row));
  if (row.chat.threads.length > 0) evidence.push(chatLabel(row));
  if (!row.pr.pullRequest || row.chat.threads.length === 0) {
    evidence.push(`branch ${branchLabel(row)}`);
  }
  return evidence.join(" · ") || `branch ${branchLabel(row)}`;
}

function activityLabel(row: AuditRow): string {
  if (!row.activity || row.activity.source === "unknown") {
    return "activity unknown";
  }
  return `${row.activity.source} ${row.activity.timestamp}`;
}

function auditSummary(rows: AuditRow[]): string {
  const counts = rows.reduce<Record<string, number>>((summary, row) => {
    const label = decisionLabel(row.decision);
    summary[label] = (summary[label] ?? 0) + 1;
    return summary;
  }, {});
  return [
    `${rows.length} worktrees`,
    `${counts.SAFE ?? 0} safe`,
    `${rows.filter((row) => (row.warnings ?? []).length > 0).length} warnings`,
    `${counts.REVIEW ?? 0} review`,
    `${counts.UNKNOWN ?? 0} unknown`,
  ].join(" · ");
}

function compactAuditLine(row: AuditRow): string {
  const repositoryLabel = row.repository ?? row.repoRoot;
  const scope = repositoryLabel ? `[${shortenText(repositoryLabel, 28)}] ` : "";
  const warningLabel = (row.warnings ?? []).length > 0
    ? ` · ⚠️ ${(row.warnings ?? []).map((warning) => warning.message).join(" · ")}`
    : "";
  return `${row.marker} ${row.size.padStart(9)} ${decisionLabel(row.decision).padEnd(7)} ${scope}${shortenText(row.path, MAX_PATH_DISPLAY_LENGTH)} · ${shortenText(evidenceLabel(row), 40)} · ${shortenText(activityLabel(row), 28)} · dirty=${row.dirtyCount ?? "?"} open=${row.openProcessCount ?? "?"}${warningLabel}`;
}

export function renderAudit(
  audit: Audit,
  { color = Boolean(process.stdout.isTTY) }: { color?: boolean } = {},
): string {
  const title = "root" in audit
    ? `workspace: ${audit.root}`
    : (audit.repository ?? "local Git repository");
  const lines = [
    colorize(`\n💾 Worktree cleaner: ${title}`, "bold", color),
    auditSummary(audit.rows),
    "",
  ];
  for (const row of audit.rows) {
    lines.push(compactAuditLine(row));
  }
  lines.push(
    "",
    "🟢 SAFE | 🟡 REVIEW | 🔴 KEEP | ⚪ UNKNOWN · --json keeps all details",
  );
  if ("errors" in audit && audit.errors.length > 0) {
    lines.push(
      "",
      `⚠️ ${audit.errors.length} discovery or audit error(s):`,
      ...audit.errors.map((error) => `- ${error.path}: ${error.message}`),
    );
  }
  return lines.join("\n");
}
