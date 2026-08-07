import { spawn } from "node:child_process";

import type {
  ChatEvidence,
  ChatLookup,
  ChatThread,
  RawChatThread,
} from "./domain.js";

const CHAT_QUERY_TIMEOUT_MS = 5_000;
const INITIAL_REQUEST_ID = 1;
const THREAD_LIST_LIMIT = 100;
const ACTIVE_CHAT_STATUS = "active";

export function groupChatThreadsByCwd(
  paths: string[],
  chatResult: ChatEvidence,
): Map<string, ChatEvidence> {
  const chatsByPath = new Map<string, ChatEvidence>();
  for (const path of paths) {
    const threads =
      chatResult.threads?.filter((thread) => thread.cwd === path) ?? [];
    chatsByPath.set(path, {
      kind:
        chatResult.kind === "UNKNOWN_CHAT"
          ? "UNKNOWN_CHAT"
          : threads.length > 0
            ? "EXACT"
            : "NO_CHAT",
      threads,
    });
  }
  return chatsByPath;
}

function statusType(
  status: string | { type?: string | null } | null | undefined,
): string | null {
  return typeof status === "string" ? status : (status?.type ?? null);
}

function normalizeChatThreads(threads: RawChatThread[]): ChatThread[] {
  return threads.map((thread) => ({
    id: thread.id ?? thread.sessionId ?? null,
    title: thread.name ?? thread.title ?? "(untitled)",
    status: statusType(thread.status) ?? "unknown",
    updatedAt: thread.updatedAt ?? thread.updated_at ?? null,
    cwd: thread.cwd ?? null,
  }));
}

function parseProtocolLines(buffer: string): {
  complete: string[];
  remainder: string;
} {
  const lines = buffer.split("\n");
  return { complete: lines.slice(0, -1), remainder: lines.at(-1) ?? "" };
}

interface ProtocolResult {
  data?: RawChatThread[];
  nextCursor?: string | null;
}

interface ProtocolMessage {
  id?: number;
  result?: ProtocolResult | null;
  error?: unknown;
}

export function createCodexChatLookup({
  spawnImpl = spawn,
  timeoutMs = CHAT_QUERY_TIMEOUT_MS,
}: { spawnImpl?: typeof spawn; timeoutMs?: number } = {}): ChatLookup {
  return function lookup(cwd: string): Promise<ChatEvidence> {
    return new Promise<ChatEvidence>((resolveLookup) => {
      const child = spawnImpl("codex", ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      let finished = false;
      let requestId = INITIAL_REQUEST_ID;
      let threads: RawChatThread[] = [];
      let cursor: string | null = null;
      let archiveIndex = 0;
      const archiveFilters = [null, true];

      const finish = (result: ChatEvidence): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.stdin?.end();
        resolveLookup(result);
      };
      const timeout = setTimeout(
        () => finish({ kind: "UNKNOWN_CHAT", threads: [] }),
        timeoutMs,
      );
      const write = (message: unknown): void => {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      };
      const sendList = (): number => {
        const id = requestId++;
        write({
          id,
          method: "thread/list",
          params: {
            cwd,
            archived: archiveFilters[archiveIndex],
            limit: THREAD_LIST_LIMIT,
            cursor,
          },
        });
        return id;
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const parsed = parseProtocolLines(buffer);
        buffer = parsed.remainder;
        for (const line of parsed.complete) {
          if (!line.trim()) continue;
          let message: ProtocolMessage;
          try {
            message = JSON.parse(line) as ProtocolMessage;
          } catch {
            continue;
          }
          if (message.id === 1) {
            write({ method: "initialized", params: {} });
            sendList();
          } else if (message.id !== undefined && message.id >= 2) {
            const result = message.result;
            if (!result || message.error) {
              finish({ kind: "UNKNOWN_CHAT", threads: [] });
            } else {
              threads = threads.concat(
                Array.isArray(result.data) ? result.data : [],
              );
              cursor = result.nextCursor ?? null;
              if (cursor) sendList();
              else if (archiveIndex < archiveFilters.length - 1) {
                archiveIndex += 1;
                cursor = null;
                sendList();
              } else
                finish({
                  kind: threads.length > 0 ? "EXACT" : "NO_CHAT",
                  threads: normalizeChatThreads(threads),
                });
            }
          }
        }
      });
      child.on("error", () => finish({ kind: "UNKNOWN_CHAT", threads: [] }));
      child.on("close", () =>
        finish({
          kind: threads.length > 0 ? "EXACT" : "UNKNOWN_CHAT",
          threads: normalizeChatThreads(threads),
        }),
      );
      write({
        id: INITIAL_REQUEST_ID,
        method: "initialize",
        params: {
          clientInfo: {
            name: "worktree-cleaner",
            version: "0.1.0",
          },
        },
      });
    });
  };
}

export function hasActiveChat(chat: ChatEvidence): boolean {
  return (
    chat.kind !== "UNKNOWN_CHAT" &&
    chat.threads.some((thread) => thread.status === ACTIVE_CHAT_STATUS)
  );
}
