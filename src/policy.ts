import {
  DECISIONS,
  type AuditRow,
  type ChatEvidence,
  type Decision,
  type PullRequestEvidence,
  type WorktreeState,
} from "./domain.js";
import { hasActiveChat } from "./chat.js";

const KIB_PER_GIB = 1024 * 1024;

function chatDecision(chat: ChatEvidence): { kind: string; active: boolean } {
  if (chat.kind === "UNKNOWN_CHAT") return { kind: "UNKNOWN", active: false };
  if (hasActiveChat(chat)) return { kind: "ACTIVE", active: true };
  return { kind: chat.kind, active: false };
}

function decisionFor({
  isMain,
  state,
  pr,
  chat,
}: {
  isMain: boolean;
  state: WorktreeState;
  pr: PullRequestEvidence;
  chat: ChatEvidence;
}): Decision {
  if (isMain) return DECISIONS.KEEP_MAIN;
  if (state.dirtyCount !== null && state.dirtyCount > 0)
    return DECISIONS.KEEP_DIRTY;
  if (state.openProcessCount === null || state.openProcessCount > 0)
    return DECISIONS.REVIEW;
  if (state.ignoredUnknownCount !== null && state.ignoredUnknownCount > 0)
    return DECISIONS.REVIEW;
  if (chatDecision(chat).active) return DECISIONS.KEEP_ACTIVE_CHAT;
  if (pr.kind === "MERGED_EXACT" && chat.kind === "EXACT")
    return DECISIONS.REMOVE_CANDIDATE;
  if (pr.kind === "UNKNOWN_GITHUB" || chat.kind === "UNKNOWN_CHAT")
    return DECISIONS.UNKNOWN;
  return DECISIONS.REVIEW;
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
  const decision = decisionFor({ isMain, state, pr, chat });
  return {
    ...state,
    pr,
    chat,
    decision,
    marker: markerFor(decision),
    size: formatGib(state.sizeKib),
  };
}
