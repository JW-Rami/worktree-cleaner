import {
  DECISIONS,
  WARNING_CODES,
  type AuditWarning,
  type AuditRow,
  type ActivityEvidence,
  type ChatEvidence,
  type Decision,
  type PullRequestEvidence,
  type WorktreeState,
} from "./domain.js";
import { hasActiveChat } from "./chat.js";

const KIB_PER_GIB = 1024 * 1024;

function hasActiveCodexChat(chat: ChatEvidence): boolean {
  return chat.kind !== "UNKNOWN_CHAT" && hasActiveChat(chat);
}

function decisionFor({
  isMain,
  pr,
  chat,
}: {
  isMain: boolean;
  pr: PullRequestEvidence;
  chat: ChatEvidence;
}): Decision {
  if (isMain) return DECISIONS.KEEP_MAIN;
  if (pr.kind === "MERGED_EXACT" && chat.kind !== "UNKNOWN_CHAT")
    return DECISIONS.REMOVE_CANDIDATE;
  if (pr.kind === "UNKNOWN_GITHUB" || chat.kind === "UNKNOWN_CHAT")
    return DECISIONS.UNKNOWN;
  return DECISIONS.REVIEW;
}

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function localWarnings(
  state: WorktreeState,
  chat: ChatEvidence,
): AuditWarning[] {
  const warnings: AuditWarning[] = [];

  if (state.dirtyCount === null) {
    warnings.push({
      code: WARNING_CODES.DIRTY_STATUS_UNAVAILABLE,
      message: "Working-tree status unavailable",
    });
  } else if (state.dirtyCount > 0) {
    warnings.push({
      code: WARNING_CODES.DIRTY_WORKTREE,
      message: countLabel(state.dirtyCount, "uncommitted change"),
    });
  }

  if (state.openProcessCount === null) {
    warnings.push({
      code: WARNING_CODES.PROCESS_SCAN_UNAVAILABLE,
      message: "Open-process scan unavailable",
    });
  } else if (state.openProcessCount > 0) {
    warnings.push({
      code: WARNING_CODES.OPEN_PROCESSES,
      message: countLabel(
        state.openProcessCount,
        "process is using this worktree",
        "processes are using this worktree",
      ),
    });
  }

  if (state.ignoredUnknownCount === null) {
    warnings.push({
      code: WARNING_CODES.IGNORED_SCAN_UNAVAILABLE,
      message: "Ignored-file scan unavailable",
    });
  } else if (state.ignoredUnknownCount > 0) {
    warnings.push({
      code: WARNING_CODES.IGNORED_FILES_UNVERIFIED,
      message: countLabel(
        state.ignoredUnknownCount,
        "ignored file is not classified as rebuildable",
        "ignored files are not classified as rebuildable",
      ),
    });
  }

  if (hasActiveCodexChat(chat)) {
    warnings.push({
      code: WARNING_CODES.ACTIVE_CODEX_CHAT,
      message: "Codex chat is active",
    });
  }

  return warnings;
}

function formatGib(sizeKib: number | null): string {
  if (sizeKib === null) return "?";
  return `${(sizeKib / KIB_PER_GIB).toFixed(2)} GiB`;
}

function markerFor(decision: Decision): string {
  if (decision === DECISIONS.REMOVE_CANDIDATE) return "🟢";
  if (decision === DECISIONS.REVIEW) return "🟡";
  if (decision === DECISIONS.UNKNOWN) return "⚪";
  return "🔴";
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function latestChatTimestamp(chat: ChatEvidence): string | null {
  return chat.threads.reduce<string | null>((latest, thread) => {
    const timestamp = normalizeTimestamp(thread.updatedAt);
    if (!timestamp) return latest;
    if (!latest || timestamp > latest) return timestamp;
    return latest;
  }, null);
}

function activityEvidence(
  state: WorktreeState,
  chat: ChatEvidence,
): ActivityEvidence {
  const chatTimestamp = latestChatTimestamp(chat);
  if (chatTimestamp) return { source: "chat", timestamp: chatTimestamp };
  const fileTimestamp = normalizeTimestamp(state.lastFileModifiedAt);
  if (fileTimestamp) return { source: "file", timestamp: fileTimestamp };
  return { source: "unknown" };
}

export function buildAuditRow({
  state,
  pr,
  chat,
  mainPath,
}: {
  state: WorktreeState;
  pr: PullRequestEvidence;
  chat: ChatEvidence;
  mainPath: string;
}): AuditRow {
  const isMain = state.path === mainPath;
  const decision = decisionFor({ isMain, pr, chat });
  return {
    ...state,
    pr,
    chat,
    activity: activityEvidence(state, chat),
    decision,
    marker: markerFor(decision),
    size: formatGib(state.sizeKib),
    warnings: localWarnings(state, chat),
  };
}
