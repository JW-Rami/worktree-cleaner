import { spawn, type ChildProcess } from "node:child_process";

import type {
  ChatEvidence,
  ChatLookup,
  ChatThread,
  RawChatThread,
} from "./domain.js";

const CHAT_QUERY_TIMEOUT_MS = 15_000;
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

interface PendingRequest {
  resolve: (result: ProtocolResult | null) => void;
  timeout: NodeJS.Timeout | null;
}

export function createCodexChatLookup({
  spawnImpl = spawn,
  timeoutMs = CHAT_QUERY_TIMEOUT_MS,
}: { spawnImpl?: typeof spawn; timeoutMs?: number } = {}): ChatLookup {
  // Read the current thread index once per audit and match paths locally.
  // Calling thread/list once per worktree makes large repositories needlessly
  // rescan the same Codex history over and over.
  let child: ChildProcess | null = null;
  let buffer = "";
  let requestId = INITIAL_REQUEST_ID + 1;
  let initialized: Promise<void> | null = null;
  let resolveInitialized: (() => void) | null = null;
  const pending = new Map<number, PendingRequest>();
  let currentThreads: Promise<RawChatThread[] | null> | null = null;

  const failPending = (): void => {
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) {
      if (request.timeout) clearTimeout(request.timeout);
      request.resolve(null);
    }
  };

  const write = (message: unknown): boolean => {
    if (!child?.stdin || child.stdin.destroyed) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };

  function sendList(cursor: string | null): Promise<ProtocolResult | null> {
    return new Promise((resolve) => {
      const id = requestId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { resolve, timeout });
      if (
        !write({
          id,
          method: "thread/list",
          params: {
            // Archived threads cannot be active, so only current threads are
            // relevant to deletion safety.
            archived: null,
            limit: THREAD_LIST_LIMIT,
            cursor,
          },
        })
      ) {
        clearTimeout(timeout);
        pending.delete(id);
        resolve(null);
      }
    });
  }

  async function fetchCurrentThreads(): Promise<RawChatThread[] | null> {
    const threads: RawChatThread[] = [];
    let cursor: string | null = null;
    do {
      const result = await sendList(cursor);
      if (!result) return null;
      if (Array.isArray(result.data)) threads.push(...result.data);
      cursor = result.nextCursor ?? null;
    } while (cursor);
    return threads;
  }

  const handleResponse = (message: ProtocolMessage): void => {
    if (message.id === INITIAL_REQUEST_ID) {
      write({ method: "initialized", params: {} });
      resolveInitialized?.();
      resolveInitialized = null;
      return;
    }

    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (request.timeout) clearTimeout(request.timeout);
    request.resolve(message.error ? null : (message.result ?? null));
  };

  const start = (): Promise<void> => {
    if (initialized) return initialized;
    initialized = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
      try {
        child = spawnImpl("codex", ["app-server", "--stdio"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        resolveInitialized?.();
        resolveInitialized = null;
        failPending();
        return;
      }
      child.stderr?.resume();
      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const parsed = parseProtocolLines(buffer);
        buffer = parsed.remainder;
        for (const line of parsed.complete) {
          if (!line.trim()) continue;
          try {
            handleResponse(JSON.parse(line) as ProtocolMessage);
          } catch {
            continue;
          }
        }
      });
      child.on("error", () => {
        resolveInitialized?.();
        resolveInitialized = null;
        failPending();
      });
      child.on("close", () => {
        child = null;
        initialized = null;
        currentThreads = null;
        resolveInitialized?.();
        resolveInitialized = null;
        failPending();
      });
      write({
        id: INITIAL_REQUEST_ID,
        method: "initialize",
        params: {
          clientInfo: {
            name: "worktree-cleaner",
            version: "0.2.0",
          },
        },
      });
    });
    return initialized;
  };

  const getCurrentThreads = (): Promise<RawChatThread[] | null> => {
    if (!currentThreads) {
      currentThreads = start().then(fetchCurrentThreads).catch(() => null);
    }
    return currentThreads;
  };

  const lookup: ChatLookup = (cwd: string): Promise<ChatEvidence> =>
    getCurrentThreads().then((threads) => {
      if (!threads) return { kind: "UNKNOWN_CHAT", threads: [] };
      const matchingThreads = normalizeChatThreads(
        threads.filter((thread) => thread.cwd === cwd),
      );
      return {
        kind: matchingThreads.length > 0 ? "EXACT" : "NO_CHAT",
        threads: matchingThreads,
      };
    });

  lookup.close = (): void => {
    failPending();
    currentThreads = null;
    initialized = null;
    resolveInitialized = null;
    const currentChild = child;
    child = null;
    if (!currentChild) return;
    currentChild.stdin?.end();
    currentChild.kill();
  };

  return lookup;
}

export function hasActiveChat(chat: ChatEvidence): boolean {
  return (
    chat.kind !== "UNKNOWN_CHAT" &&
    chat.threads.some((thread) => thread.status === ACTIVE_CHAT_STATUS)
  );
}
