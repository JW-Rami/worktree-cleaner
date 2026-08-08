import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
  auditRepositories,
  auditWorktrees,
  buildAuditRow,
  collectWorktreeState,
  createCodexChatLookup,
  defaultSelection,
  DEFAULT_DISCOVERY_MAX_DEPTH,
  DEFAULT_WORKTREE_CONCURRENCY,
  defaultWorkspaceRoot,
  discoverRepositoryRoots,
  groupChatThreadsByCwd,
  matchPullRequest,
  measureWorktreeSizes,
  parseArgs,
  parseWorktreeList,
  PROGRESS_STAGES,
  repositoryFromRemote,
  removeWorktree,
  renderAudit,
  verifyRemovalTarget,
  type AggregateAudit,
  type AuditRow,
  type ChatEvidence,
  type CommandResult,
  type ProgressEvent,
  type PullRequest,
  type PullRequestEvidence,
  type WorktreeState,
  WARNING_CODES,
} from "../src/audit.js";
import {
  executeDeletion,
  runInteractiveSession,
  parseInteractiveCommand,
  parseSelection,
  renderInteractive,
  runCli,
} from "../src/cli.js";
import {
  moveCursor,
  parseTerminalKeys,
  printPreview,
  selectedRows,
} from "../src/interactive.js";

const mergedHead = "a".repeat(40);
const staleHead = "b".repeat(40);
const AUDIT_CONCURRENCY_TEST_DELAY_MS = 10;
const WORKTREE_CONCURRENCY_TEST_DELAY_MS = 10;

function state(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    path: "/tmp/worktree-a",
    branch: "rami/feature-a",
    head: mergedHead,
    detached: false,
    dirtyCount: 0,
    ignoredCount: 1,
    ignoredRebuildableCount: 1,
    ignoredUnknownCount: 0,
    sizeKib: 1024 * 1024,
    lastCommit: { date: "2026-07-20T10:00:00Z", subject: "feature" },
    openProcessCount: 0,
    ...overrides,
    lastFileModifiedAt: overrides.lastFileModifiedAt ?? null,
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    state: "MERGED",
    title: "Feature A",
    headRefName: "rami/feature-a",
    headRefOid: mergedHead,
    mergedAt: "2026-07-19T10:00:00Z",
    ...overrides,
  };
}

describe("worktree-cleaner", () => {
  it("parses registered worktrees without inferring a branch for detached HEADs", () => {
    const parsed = parseWorktreeList(`
worktree /repo
HEAD ${mergedHead}
branch refs/heads/dev

worktree /tmp/detached
HEAD ${staleHead}
detached
`);

    assert.deepEqual(parsed, [
      { path: "/repo", head: mergedHead, branch: "dev", detached: false },
      { path: "/tmp/detached", head: staleHead, branch: null, detached: true },
    ]);
  });

  it("identifies a PR only when branch and current HEAD both match", () => {
    assert.deepEqual(
      matchPullRequest({
        branch: "rami/feature-a",
        head: mergedHead,
        pullRequests: [pullRequest()],
      }),
      { kind: "MERGED_EXACT", pullRequest: pullRequest() },
    );
    assert.equal(
      matchPullRequest({
        branch: "rami/feature-a",
        head: staleHead,
        pullRequests: [pullRequest()],
      }).kind,
      "MERGED_STALE",
    );
  });

  it("recognizes GitHub SSH aliases used by local remotes", () => {
    assert.equal(
      repositoryFromRemote("git@github.com-jwcorp:The-JW-Corp/Invisible.git"),
      "The-JW-Corp/Invisible",
    );
    assert.equal(
      repositoryFromRemote("https://github.com/The-JW-Corp/Invisible"),
      "The-JW-Corp/Invisible",
    );
  });

  it("loads the Codex thread index once for multiple worktree lookups", async () => {
    const inputMessages: Array<{ id?: number; method?: string }> = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const input = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)) as {
          id?: number;
          method?: string;
        };
        inputMessages.push(message);
        if (message.id === 1) {
          stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        } else if (message.method === "thread/list") {
          stdout.write(
            `${JSON.stringify({
              id: message.id,
              result: {
                data: [
                  { id: "chat-a", cwd: "/repo/a", status: "idle" },
                ],
                nextCursor: null,
              },
            })}\n`,
          );
        }
        callback();
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin: input,
      stdout,
      stderr,
      kill() {
        return true;
      },
    }) as unknown as ChildProcess;
    const lookup = createCodexChatLookup({
      spawnImpl: (() => child) as typeof import("node:child_process").spawn,
    });

    const [repoA, repoB] = await Promise.all([
      lookup("/repo/a"),
      lookup("/repo/b"),
    ]);
    lookup.close?.();

    assert.equal(repoA.kind, "EXACT");
    assert.equal(repoB.kind, "NO_CHAT");
    assert.equal(
      inputMessages.filter((message) => message.method === "thread/list")
        .length,
      1,
    );
  });

  it("discovers nested repositories and deduplicates linked worktrees", async () => {
    const root = realpathSync(
        mkdtempSync(join(tmpdir(), "worktree-cleaner-discovery-")),
    );
    const repoA = join(root, "repo-a");
    const repoAWorktree = join(root, "repo-a-worktree");
    const repoB = join(root, "nested", "repo-b");
    const ignoredRepo = join(repoA, "node_modules", "ignored-repo");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(repoAWorktree, { recursive: true });
    writeFileSync(join(repoAWorktree, ".git"), "gitdir: ../repo-a/.git");
    mkdirSync(join(repoB, ".git"), { recursive: true });
    mkdirSync(join(ignoredRepo, ".git"), { recursive: true });

    const metadata = new Map([
      [repoA, { repoRoot: repoA, commonDir: join(repoA, ".git") }],
      [repoAWorktree, { repoRoot: repoA, commonDir: join(repoA, ".git") }],
      [repoB, { repoRoot: repoB, commonDir: join(repoB, ".git") }],
      [
        ignoredRepo,
        { repoRoot: ignoredRepo, commonDir: join(ignoredRepo, ".git") },
      ],
    ]);
    const runCommand = (_command: string, args: string[]): CommandResult => {
      const candidate = metadata.get(args[1]);
      if (!candidate) return { status: 1, stdout: "", stderr: "not a repo" };
      return {
        status: 0,
        stdout: args.includes("--show-toplevel")
          ? `${candidate.repoRoot}\n`
          : `${candidate.commonDir}\n`,
        stderr: "",
      };
    };

    try {
      const discovery = discoverRepositoryRoots(root, { runCommand });
      assert.deepEqual(discovery.roots, [repoA, repoB].sort());
      assert.deepEqual(discovery.errors, []);

      const aggregate = await auditRepositories({
        root,
        runCommand,
        noGithub: true,
        noChat: true,
        auditRepository: async ({ cwd = "" }) => ({
          repoRoot: cwd,
          repository: null,
          rows: [
            {
              path: join(cwd, "worktree"),
              decision: "UNKNOWN",
            } as AuditRow,
          ],
        }),
      });
      assert.deepEqual(
        aggregate.repositories.map((repository) => repository.repoRoot),
        [repoA, repoB].sort(),
      );
      assert.deepEqual(
        aggregate.rows.map((row) => row.repoRoot),
        [repoA, repoB].sort(),
      );
      assert.deepEqual(aggregate.errors, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local risk as warnings while preserving deletion evidence", () => {
    const mergedChat: ChatEvidence = {
      kind: "EXACT",
      threads: [{ id: "chat-1", title: "Feature A", status: "idle" }],
    };
    const mergedPr: PullRequestEvidence = {
      kind: "MERGED_EXACT",
      pullRequest: pullRequest(),
    };
    const candidate = buildAuditRow({
      state: state(),
      pr: mergedPr,
      chat: mergedChat,
      mainPath: "/repo",
    });
    const dirty = buildAuditRow({
      state: state({ dirtyCount: 1 }),
      pr: mergedPr,
      chat: mergedChat,
      mainPath: "/repo",
    });
    const active = buildAuditRow({
      state: state(),
      pr: mergedPr,
      chat: {
        kind: "EXACT",
        threads: [{ id: "chat-1", title: "Feature A", status: "active" }],
      },
      mainPath: "/repo",
    });

    assert.equal(candidate.decision, "REMOVE_CANDIDATE");
    assert.equal(dirty.decision, "REMOVE_CANDIDATE");
    assert.equal(active.decision, "REMOVE_CANDIDATE");
    assert.deepEqual(dirty.warnings.map((warning) => warning.code), [
      WARNING_CODES.DIRTY_WORKTREE,
    ]);
    assert.deepEqual(active.warnings.map((warning) => warning.code), [
      WARNING_CODES.ACTIVE_CODEX_CHAT,
    ]);
    assert.deepEqual(
      defaultSelection([candidate, dirty, active]),
      new Set([candidate.path, dirty.path, active.path]),
    );
  });

  it("shows unclassified ignored files as a deletion warning", () => {
    const row = buildAuditRow({
      state: state({ ignoredUnknownCount: 1 }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });

    assert.equal(row.decision, "REMOVE_CANDIDATE");
    assert.deepEqual(row.warnings, [
      {
        code: WARNING_CODES.IGNORED_FILES_UNVERIFIED,
        message: "1 ignored file is not classified as rebuildable",
      },
    ]);
  });

  it("treats a verified absence of a Codex chat as safe evidence", () => {
    const row = buildAuditRow({
      state: state(),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "NO_CHAT", threads: [] },
      mainPath: "/repo",
    });

    assert.equal(row.decision, "REMOVE_CANDIDATE");
    assert.deepEqual(row.warnings, []);
  });

  it("uses the latest chat update and falls back to file mtime", () => {
    const chatRow = buildAuditRow({
      state: state({ lastFileModifiedAt: "2026-08-07T18:00:00Z" }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: {
        kind: "EXACT",
        threads: [
          {
            id: "chat-old",
            title: "Old",
            status: "idle",
            updatedAt: "2026-08-07T17:00:00Z",
          },
          {
            id: "chat-new",
            title: "New",
            status: "idle",
            updatedAt: "2026-08-07T19:00:00Z",
          },
        ],
      },
      mainPath: "/repo",
    });
    assert.deepEqual(chatRow.activity, {
      source: "chat",
      timestamp: "2026-08-07T19:00:00.000Z",
    });

    const fileRow = buildAuditRow({
      state: state({ lastFileModifiedAt: "2026-08-07T18:00:00Z" }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "NO_CHAT", threads: [] },
      mainPath: "/repo",
    });
    assert.deepEqual(fileRow.activity, {
      source: "file",
      timestamp: "2026-08-07T18:00:00.000Z",
    });
  });

  it("looks up chats for worktrees without GitHub PR evidence", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "worktree-cleaner-chat-scope-")),
    );
    const linked = join(root, "linked");
    const runGit = (args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };

    try {
      writeFileSync(join(root, "README.md"), "fixture\n");
      runGit(["init", "--quiet"]);
      runGit(["config", "user.email", "cli-e2e@example.invalid"]);
      runGit(["config", "user.name", "CLI E2E"]);
      runGit(["config", "commit.gpgSign", "false"]);
      runGit(["add", "README.md"]);
      runGit(["commit", "--quiet", "-m", "fixture"]);
      runGit(["worktree", "add", "--quiet", "-b", "linked", linked]);

      const queriedPaths: string[] = [];
      await auditWorktrees({
        cwd: root,
        noGithub: true,
        chatLookup: async (cwd) => {
          queriedPaths.push(cwd);
          return { kind: "NO_CHAT", threads: [] };
        },
      });

      assert.deepEqual(queriedPaths.sort(), [root, linked].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the latest tracked or non-ignored file modification", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "worktree-cleaner-file-mtime-")),
    );
    const older = join(root, "older.txt");
    const newer = join(root, "newer.txt");
    const ignored = join(root, "ignored.log");
    const runGit = (args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    const olderTime = new Date("2026-08-07T17:00:00Z");
    const newerTime = new Date("2026-08-07T19:00:00Z");

    try {
      writeFileSync(older, "older\n");
      writeFileSync(newer, "newer\n");
      writeFileSync(join(root, ".gitignore"), "*.log\n");
      writeFileSync(ignored, "ignored\n");
      runGit(["init", "--quiet"]);
      runGit(["config", "user.email", "cli-e2e@example.invalid"]);
      runGit(["config", "user.name", "CLI E2E"]);
      runGit(["config", "commit.gpgSign", "false"]);
      runGit(["add", "."]);
      runGit(["commit", "--quiet", "-m", "fixture"]);
      utimesSync(older, olderTime, olderTime);
      utimesSync(newer, newerTime, newerTime);
      utimesSync(join(root, ".gitignore"), olderTime, olderTime);
      utimesSync(ignored, new Date("2026-08-08T00:00:00Z"), new Date("2026-08-08T00:00:00Z"));

      const stateResult = collectWorktreeState({ path: root, head: "" });

      assert.equal(stateResult.lastFileModifiedAt, newerTime.toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unavailable local checks as warnings", () => {
    const row = buildAuditRow({
      state: state({
        dirtyCount: null,
        ignoredUnknownCount: null,
        openProcessCount: null,
      }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });

    assert.equal(row.decision, "REMOVE_CANDIDATE");
    assert.deepEqual(
      row.warnings.map((warning) => warning.code),
      [
        WARNING_CODES.DIRTY_STATUS_UNAVAILABLE,
        WARNING_CODES.PROCESS_SCAN_UNAVAILABLE,
        WARNING_CODES.IGNORED_SCAN_UNAVAILABLE,
      ],
    );
  });

  it("associates chats by exact cwd and ignores unrelated PR mentions", () => {
    const chats = groupChatThreadsByCwd(
      ["/tmp/worktree-a", "/tmp/worktree-b"],
      {
        kind: "EXACT",
        threads: [
          {
            id: "chat-a",
            cwd: "/tmp/worktree-a",
            name: "Review PR #407",
            status: "notLoaded",
          },
          {
            id: "chat-b",
            cwd: "/repo",
            name: "Mention PR #407",
            status: "active",
          },
        ],
      },
    );

    assert.deepEqual(
      chats.get("/tmp/worktree-a")!.threads.map((thread) => thread.id),
      ["chat-a"],
    );
    assert.equal(chats.get("/tmp/worktree-b")!.kind, "NO_CHAT");
  });

  it("renders the evidence fields needed to review a deletion", () => {
    const row = buildAuditRow({
      state: state(),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: {
        kind: "EXACT",
        threads: [{ id: "chat-1", title: "Feature A", status: "idle" }],
      },
      mainPath: "/repo",
    });
    const output = renderAudit(
      {
        repoRoot: "/repo",
        repository: "The-JW-Corp/Invisible",
        rows: [row],
      },
      { color: false },
    );

    assert.match(output, /SAFE/u);
    assert.match(output, /PR #42 MERGED/u);
    assert.match(output, /Feature A/u);
    assert.match(output, /dirty=0/u);
    assert.doesNotMatch(output, /last commit=/u);
  });

  it("parses safe CLI modes", () => {
    assert.deepEqual(
      parseArgs(["--interactive", "--merged-only", "--cwd", "/tmp/repo"]),
      {
        cwd: "/tmp/repo",
        cwdExplicit: true,
        root: null,
        all: false,
        maxDepth: DEFAULT_DISCOVERY_MAX_DEPTH,
        concurrency: DEFAULT_WORKTREE_CONCURRENCY,
        json: false,
        interactive: true,
        mergedOnly: true,
        noGithub: false,
        noChat: false,
        deepProcessScan: false,
      },
    );
    assert.deepEqual(
      parseArgs(["--root", "/tmp/projects", "--max-depth", "3"]),
      {
        cwd: process.cwd(),
        cwdExplicit: false,
        root: "/tmp/projects",
        all: false,
        maxDepth: 3,
        concurrency: DEFAULT_WORKTREE_CONCURRENCY,
        json: false,
        interactive: false,
        mergedOnly: false,
        noGithub: false,
        noChat: false,
        deepProcessScan: false,
      },
    );
    assert.throws(
      () => parseArgs(["--cwd", "/tmp/repo", "--root", "/tmp/projects"]),
      /Use either --cwd or --root, not both/u,
    );
    assert.deepEqual(parseArgs(["--all", "--cwd", "/tmp/projects"]), {
      cwd: "/tmp/projects",
      cwdExplicit: true,
      root: null,
      all: true,
      maxDepth: DEFAULT_DISCOVERY_MAX_DEPTH,
      concurrency: DEFAULT_WORKTREE_CONCURRENCY,
      json: false,
      interactive: false,
      mergedOnly: false,
      noGithub: false,
      noChat: false,
      deepProcessScan: false,
    });
    assert.equal(parseArgs(["-all"]).all, true);
    assert.equal(parseArgs(["--concurrency", "16"]).concurrency, 16);
    assert.equal(
      parseArgs(["--worktree-concurrency", "16"]).concurrency,
      16,
    );
    assert.throws(
      () => parseArgs(["--concurrency", "0"]),
      /--concurrency must be an integer/u,
    );
    assert.throws(
      () => parseArgs(["--worktree-concurrency", "0"]),
      /--concurrency must be an integer/u,
    );
  });

  it("uses the parent of the current repository as the automatic workspace root", () => {
    const runCommand = (_command: string, args: string[]): CommandResult => {
      assert.deepEqual(args, [
        "-C",
        "/workspace/projects/repository",
        "rev-parse",
        "--show-toplevel",
      ]);
      return {
        status: 0,
        stdout: "/workspace/projects/repository\n",
        stderr: "",
      };
    };

    assert.equal(
      defaultWorkspaceRoot("/workspace/projects/repository", runCommand),
      "/workspace/projects",
    );
  });

  it("audits repositories in parallel with bounded concurrency and stable ordering", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "worktree-cleaner-concurrency-")),
    );
    const repoRoots = [
      join(root, "repo-a"),
      join(root, "repo-b"),
      join(root, "repo-c"),
      join(root, "repo-d"),
    ];
    const orderedRoots = [...repoRoots].sort();
    const metadata = new Map(
      repoRoots.map((repoRoot) => [
        repoRoot,
        { repoRoot, commonDir: join(repoRoot, ".git") },
      ]),
    );
    for (const repoRoot of repoRoots) {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
    }

    const runCommand = (_command: string, args: string[]): CommandResult => {
      const candidate = metadata.get(args[1]);
      if (!candidate) return { status: 1, stdout: "", stderr: "not a repo" };
      return {
        status: 0,
        stdout: args.includes("--show-toplevel")
          ? `${candidate.repoRoot}\n`
          : `${candidate.commonDir}\n`,
        stderr: "",
      };
    };
    let active = 0;
    let maxActive = 0;

    try {
      const aggregate = await auditRepositories({
        root,
        runCommand,
        noGithub: true,
        noChat: true,
        concurrency: 2,
        auditRepository: async ({ cwd = "" }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) =>
            setTimeout(resolve, AUDIT_CONCURRENCY_TEST_DELAY_MS),
          );
          active -= 1;
          if (cwd === orderedRoots[1]) throw new Error("simulated failure");
          return {
            repoRoot: cwd,
            repository: null,
            rows: [],
          };
        },
      });

      assert.equal(maxActive, 2);
      assert.deepEqual(
        aggregate.repositories.map((repository) => repository.repoRoot),
        orderedRoots.filter((repoRoot) => repoRoot !== orderedRoots[1]),
      );
      assert.deepEqual(aggregate.errors, [
        {
          stage: "audit",
          path: orderedRoots[1],
          message: "simulated failure",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parallelizes evidence searches inside a large repository", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "worktree-cleaner-worktree-concurrency-")),
    );
    const worktreePaths = [
      join(root, "main"),
      join(root, "worktree-a"),
      join(root, "worktree-b"),
      join(root, "worktree-c"),
    ];
    for (const path of worktreePaths) mkdirSync(path, { recursive: true });
    const worktreeList = worktreePaths
      .map(
        (path, index) => {
          const branch = index === 0 ? "main" : `worktree-${index}`;
          return [
            `worktree ${path}`,
            `HEAD ${String(index).repeat(40)}`,
            `branch refs/heads/${branch}`,
            "",
          ].join("\n");
        },
      )
      .join("\n");
    const runCommand = (command: string, args: string[]): CommandResult => {
      if (command === "lsof") return { status: 0, stdout: "", stderr: "" };
      if (args.includes("--show-toplevel")) {
        return { status: 0, stdout: `${root}\n`, stderr: "" };
      }
      if (args.includes("worktree")) {
        return { status: 0, stdout: worktreeList, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unsupported command" };
    };
    let activeStatusSearches = 0;
    let maxActiveStatusSearches = 0;
    const asyncRunCommand = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => {
      if (command === "du") {
        return {
          status: 0,
          stdout: args
            .slice(1)
            .map((path) => `1\t${path}`)
            .join("\n"),
          stderr: "",
        };
      }
      if (
        command === "git" &&
        args.includes("status") &&
        !args.includes("--ignored")
      ) {
        activeStatusSearches += 1;
        maxActiveStatusSearches = Math.max(
          maxActiveStatusSearches,
          activeStatusSearches,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, WORKTREE_CONCURRENCY_TEST_DELAY_MS),
        );
        activeStatusSearches -= 1;
      }
      return {
        status: 0,
        stdout: args.includes("show")
          ? "2026-08-04T00:00:00Z\tworktree\n"
          : "",
        stderr: "",
      };
    };

    try {
      const audit = await auditWorktrees({
        cwd: root,
        runCommand,
        asyncRunCommand,
        noGithub: true,
        noChat: true,
        worktreeConcurrency: 2,
      });

      assert.equal(audit.rows.length, worktreePaths.length);
      assert.equal(maxActiveStatusSearches, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports slash commands and compact range selection", () => {
    assert.deepEqual(parseInteractiveCommand("/select 2-4"), {
      command: "select",
      argument: "2-4",
    });
    assert.deepEqual(parseSelection("2, 4-5", 8), {
      indexes: [2, 4, 5],
      invalid: [],
    });
  });

  it("decodes split arrow sequences and wraps the dashboard cursor", () => {
    const partial = parseTerminalKeys("\u001b[");
    assert.deepEqual(partial.keys, []);
    assert.equal(partial.pendingEscape, "\u001b[");
    assert.deepEqual(parseTerminalKeys("A", partial.pendingEscape).keys, [
      { kind: "up" },
    ]);

    const first = buildAuditRow({
      state: state({ path: "/tmp/first" }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const second = buildAuditRow({
      state: state({ path: "/tmp/second" }),
      pr: {
        kind: "MERGED_EXACT",
        pullRequest: pullRequest({ number: 43 }),
      },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const audit = { repoRoot: "/repo", repository: null, rows: [first, second] };
    assert.equal(moveCursor(audit, "all", first.path, "down"), second.path);
    assert.equal(moveCursor(audit, "all", first.path, "up"), second.path);
  });

  it("renders an actionable interactive dashboard", () => {
    const row = buildAuditRow({
      state: state(),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: {
        kind: "EXACT",
        threads: [{ id: "chat-1", title: "Feature A", status: "idle" }],
      },
      mainPath: "/repo",
    });
    const output = renderInteractive(
      {
        repoRoot: "/repo",
        repository: "The-JW-Corp/Invisible",
        rows: [row],
      },
      { selected: new Set([row.path]) },
    );

    assert.match(output, /Worktree Cleaner/u);
    assert.match(output, /↑\/↓ move/u);
    assert.match(output, /\/delete/u);
    assert.match(output, /✅\s+1\s+SAFE/u);
    assert.match(output, /✅ SAFE selected/u);
  });

  it("does not present a verified absence of a Codex chat as a blocker", () => {
    const row = buildAuditRow({
      state: state(),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "NO_CHAT", threads: [] },
      mainPath: "/repo",
    });
    const output = renderInteractive(
      {
        repoRoot: "/repo",
        repository: "The-JW-Corp/Invisible",
        rows: [row],
      },
      { cursorPath: row.path },
    );

    assert.match(output, /branch=rami\/feature-a/u);
    assert.doesNotMatch(output, /Blocked: Codex chat: nochat/u);
  });

  it("shows the branch when PR and chat identity are unavailable", () => {
    const row = buildAuditRow({
      state: state({
        branch: "rami/no-pr-no-chat",
        lastFileModifiedAt: "2026-08-07T18:00:00Z",
      }),
      pr: { kind: "NO_PR", pullRequest: null },
      chat: { kind: "NO_CHAT", threads: [] },
      mainPath: "/repo",
    });
    const output = renderInteractive(
      { repoRoot: "/repo", repository: null, rows: [row] },
      { columns: 120, cursorPath: row.path },
    );

    assert.match(output, /branch:ra…r-no-chat/u);
    assert.match(output, /F 08-07 18:00Z/u);
    assert.match(output, /Activity: file 2026-08-07T18:00:00\.000Z/u);
  });

  it("separates primary worktrees and shortens rows to the terminal width", () => {
    const main = buildAuditRow({
      state: state({ path: "/Users/rami/Dev/very-long-primary-repository-name" }),
      pr: { kind: "NO_PR", pullRequest: null },
      chat: { kind: "NO_CHAT", threads: [] },
      mainPath: "/Users/rami/Dev/very-long-primary-repository-name",
    });
    const linked = buildAuditRow({
      state: state({
        path: "/Users/rami/Dev/very-long-primary-repository-name-linked-worktree",
      }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: main.path,
    });
    const output = renderInteractive(
      {
        repoRoot: main.path,
        repository: "The-JW-Corp/very-long-primary-repository-name",
        rows: [linked, main],
      },
      {
        columns: 80,
        cursorPath: linked.path,
        selected: new Set([main.path, linked.path]),
      },
    );

    assert.match(output, /2 selected · 1 SAFE/u);
    assert.match(output, /MAIN WORKTREES \(1\)/u);
    assert.match(output, /LINKED WORKTREES \(1\)/u);
    assert.match(output, /⚠️\s+1\s+MAIN/u);
    assert.match(output, /✅\s+2\s+SAFE/u);
    assert.match(output, /…/u);
    for (const line of output.split("\n")) {
      assert.ok(line.length <= 80, line);
    }
  });

  it("shows local risk rows as warnings in the selection gutter", () => {
    const dirty = buildAuditRow({
      state: state({ path: "/tmp/dirty", dirtyCount: 1 }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const output = renderInteractive(
      { repoRoot: "/repo", repository: null, rows: [dirty] },
      { columns: 80, cursorPath: dirty.path },
    );

    assert.match(output, /▶\s+⚠️\s+1\s+SAFE/u);
    assert.match(output, /Warnings: 1 uncommitted change/u);
  });

  it("shows local warnings in the deletion preview", () => {
    const dirty = buildAuditRow({
      state: state({ dirtyCount: 1 }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const chunks: string[] = [];

    printPreview(
      { write(chunk: string) { chunks.push(chunk); } },
      [dirty],
    );

    assert.match(chunks.join(""), /Deletion preview \(1\)/u);
    assert.match(chunks.join(""), /⚠️ 1 uncommitted change/u);
  });

  it("scrolls the terminal viewport to keep the focused row visible", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      buildAuditRow({
        state: state({ path: `/tmp/worktree-${index + 1}` }),
        pr: {
          kind: "MERGED_EXACT",
          pullRequest: pullRequest({ number: index + 1 }),
        },
        chat: { kind: "EXACT", threads: [] },
        mainPath: "/repo",
      }),
    );
    const output = renderInteractive(
      { repoRoot: "/repo", repository: null, rows },
      { columns: 80, rows: 16, cursorPath: rows[8].path },
    );

    assert.match(output, /row 9\/12 · ↑ more · ↓ more/u);
    assert.match(output, /▶\s+○\s+  9\s+SAFE/u);
    assert.doesNotMatch(output, /worktree-1/u);
    assert.equal(output.match(/▶/gu)?.length, 1);
  });

  it("adds terminal color to the selected row without hiding its marker", () => {
    const row = buildAuditRow({
      state: state(),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const output = renderInteractive(
      { repoRoot: "/repo", repository: null, rows: [row] },
      { selected: new Set([row.path]), columns: 80, color: true },
    );

    assert.match(output, /✅\s+1\s+SAFE/u);
    assert.match(output, /\u001b\[32m\u001b\[1m/u);
    assert.match(output, /\u001b\[0m/u);
  });

  it("moves the cursor and selects a safe row with terminal keys", async () => {
    const first = buildAuditRow({
      state: state({ path: "/tmp/first" }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const second = buildAuditRow({
      state: state({ path: "/tmp/second" }),
      pr: {
        kind: "MERGED_EXACT",
        pullRequest: pullRequest({ number: 43 }),
      },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const rows = [
      first,
      second,
      ...Array.from({ length: 10 }, (_, index) =>
        buildAuditRow({
          state: state({ path: `/tmp/worktree-${index + 3}` }),
          pr: {
            kind: "MERGED_EXACT",
            pullRequest: pullRequest({ number: index + 44 }),
          },
          chat: { kind: "EXACT", threads: [] },
          mainPath: "/repo",
        }),
      ),
    ];
    const rawModes: boolean[] = [];
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode(mode: boolean) {
        rawModes.push(mode);
        return input;
      },
      pause() {
        return input;
      },
      resume() {
        return input;
      },
    });
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      columns: 80,
      rows: 16,
      color: true,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };
    const session = runInteractiveSession({
      audit: { repoRoot: "/repo", repository: null, rows },
      args: { cwd: "/repo", cwdExplicit: true, noGithub: true, noChat: true },
      input,
      output,
      errorOutput: output,
    });

    for (let index = 0; index < 9; index += 1) {
      input.emit("data", "\u001b[B");
    }
    input.emit("data", " ");
    input.emit("data", "q");

    assert.equal(await session, 0);
    assert.deepEqual(rawModes, [true, false]);
    assert.match(chunks.join(""), /row 10\/12 · ↑ more · ↓ more/u);
    assert.match(chunks.join(""), /▶\s+✅\s+10\s+SAFE/u);
    assert.match(chunks.join(""), /\u001b\[32m\u001b\[1m/u);
  });

  it("visibly selects a dirty row as a warning candidate", async () => {
    const dirty = buildAuditRow({
      state: state({ path: "/tmp/dirty", dirtyCount: 1 }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode() {
        return input;
      },
      pause() {
        return input;
      },
      resume() {
        return input;
      },
    });
    const chunks: string[] = [];
    const output = {
      isTTY: true,
      columns: 80,
      rows: 16,
      color: false,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };
    const session = runInteractiveSession({
      audit: { repoRoot: "/repo", repository: null, rows: [dirty] },
      args: { cwd: "/repo", cwdExplicit: true, noGithub: true, noChat: true },
      input,
      output,
      errorOutput: output,
    });

    input.emit("data", " ");
    input.emit("data", "q");

    assert.equal(await session, 0);
    const rendered = chunks.join("");
    const initialMarker = rendered.indexOf("▶ ⚠️");
    const selectedMarker = rendered.indexOf("▶ ✅");
    assert.ok(initialMarker >= 0);
    assert.ok(selectedMarker > initialMarker);
    assert.match(rendered, /1 selected · 1 SAFE/u);
    assert.match(rendered, /uncommitted change/u);
    assert.deepEqual(
      selectedRows(
        { repoRoot: "/repo", repository: null, rows: [dirty] },
        new Set([dirty.path]),
      ),
      [dirty],
    );
  });

  it("force-removes a warning candidate only after fresh explicit confirmation", async () => {
    const dirty = buildAuditRow({
      state: state({ dirtyCount: 1 }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });
    const calls: Array<Record<string, unknown>> = [];
    const result = await executeDeletion({
      audit: { repoRoot: "/repo", repository: null, rows: [dirty] },
      paths: [dirty.path],
      args: {
        cwd: "/repo",
        cwdExplicit: true,
        noGithub: false,
        noChat: false,
      },
      output: { write() {} },
      errorOutput: { write() {} },
      auditFn: async () => ({
        repoRoot: "/repo",
        repository: null,
        rows: [dirty],
      }),
      verifyFn({ allowWarnings }) {
        calls.push({ action: "verify", allowWarnings });
        return true;
      },
      removeFn({ force }) {
        calls.push({ action: "remove", force });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.removed, 1);
    assert.deepEqual(calls, [
      { action: "verify", allowWarnings: true },
      { action: "remove", force: true },
    ]);
  });

  it("re-audits and removes only a still-safe exact worktree", async () => {
    const row = buildAuditRow({
      state: state(),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: {
        kind: "EXACT",
        threads: [{ id: "chat-1", title: "Feature A", status: "idle" }],
      },
      mainPath: "/repo",
    });
    const calls: Array<Record<string, unknown>> = [];
    const result = await executeDeletion({
      audit: { repoRoot: "/repo", repository: null, rows: [row] },
      paths: [row.path],
      args: {
        cwd: "/repo",
        cwdExplicit: true,
        noGithub: false,
        noChat: false,
      },
      output: { write() {} },
      errorOutput: { write() {} },
      auditFn: async () => ({
        repoRoot: "/repo",
        repository: null,
        rows: [row],
      }),
      verifyFn({ repoRoot, row: verifiedRow }) {
        calls.push({
          repoRoot,
          path: verifiedRow.path,
          head: verifiedRow.head,
        });
        return true;
      },
      removeFn({ repoRoot, path }) {
        calls.push({ repoRoot, path, removed: true });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.removed, 1);
    assert.deepEqual(calls, [
      { repoRoot: "/repo", path: row.path, head: row.head },
      { repoRoot: "/repo", path: row.path, removed: true },
    ]);
  });

  it("uses each repository root when deleting from an aggregate audit", async () => {
    const firstRow = buildAuditRow({
      state: state({ path: "/tmp/repo-a-worktree" }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo-a",
    });
    const secondRow = buildAuditRow({
      state: state({ path: "/tmp/repo-b-worktree", branch: "rami/feature-b" }),
      pr: {
        kind: "MERGED_EXACT",
        pullRequest: pullRequest({ headRefName: "rami/feature-b" }),
      },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo-b",
    });
    const rows = [
      { ...firstRow, repoRoot: "/repo-a", repository: null },
      { ...secondRow, repoRoot: "/repo-b", repository: null },
    ];
    const calls: Array<Record<string, unknown>> = [];
    const result = await executeDeletion({
      audit: {
        root: "/workspace",
        repositories: [],
        rows,
        errors: [],
      },
      paths: rows.map((row) => row.path),
      args: {
        cwd: process.cwd(),
        root: "/workspace",
        maxDepth: DEFAULT_DISCOVERY_MAX_DEPTH,
        noGithub: true,
        noChat: true,
      },
      output: { write() {} },
      errorOutput: { write() {} },
      rootAuditFn: async (): Promise<AggregateAudit> => ({
        root: "/workspace",
        repositories: [],
        rows,
        errors: [],
      }),
      verifyFn({ repoRoot, row }) {
        calls.push({ action: "verify", repoRoot, path: row.path });
        return true;
      },
      removeFn({ repoRoot, path }) {
        calls.push({ action: "remove", repoRoot, path });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.removed, 2);
    assert.deepEqual(calls, [
      {
        action: "verify",
        repoRoot: "/repo-a",
        path: "/tmp/repo-a-worktree",
      },
      {
        action: "remove",
        repoRoot: "/repo-a",
        path: "/tmp/repo-a-worktree",
      },
      {
        action: "verify",
        repoRoot: "/repo-b",
        path: "/tmp/repo-b-worktree",
      },
      {
        action: "remove",
        repoRoot: "/repo-b",
        path: "/tmp/repo-b-worktree",
      },
    ]);
  });

  it("fails clearly when interactive mode has no TTY", async () => {
    await assert.rejects(
      runCli({
        argv: ["--interactive"],
        input: { isTTY: false },
        output: { isTTY: false, write: () => true },
        errorOutput: { write() {} },
      }),
      /interactive terminal \(TTY\)/u,
    );
  });

  it("parses aggregate du output without requiring one command per worktree", () => {
    const progress: ProgressEvent[] = [];
    const sizes = measureWorktreeSizes(
      [{ path: process.cwd() }, { path: "/missing" }],
      () => ({
        status: 0,
        stdout: `2048\t${process.cwd()}\n`,
        stderr: "",
      }),
      (event) => progress.push(event),
    );

    assert.equal(sizes.get(process.cwd()), 2048);
    assert.equal(sizes.has("/missing"), false);
    assert.deepEqual(progress, [
      { stage: PROGRESS_STAGES.SIZES, completed: 1, total: 1 },
    ]);
  });

  it("removes only the exact selected worktree through Git", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = removeWorktree({
      repoRoot: "/repo",
      path: "/tmp/worktree-a",
      runCommand(command: string, args: string[]) {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(calls, [
      {
        command: "git",
        args: ["-C", "/repo", "worktree", "remove", "--", "/tmp/worktree-a"],
      },
    ]);
  });

  it("uses force only when removing a warning worktree", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = removeWorktree({
      repoRoot: "/repo",
      path: "/tmp/worktree-a",
      force: true,
      runCommand(command: string, args: string[]) {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(calls[0]?.args, [
      "-C",
      "/repo",
      "worktree",
      "remove",
      "--force",
      "--",
      "/tmp/worktree-a",
    ]);
  });

  it("removes a dirty linked worktree through the real forced Git path", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "worktree-cleaner-force-remove-")),
    );
    const linked = join(root, "linked");
    const runGit = (args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };

    try {
      writeFileSync(join(root, "README.md"), "fixture\n");
      runGit(["init", "--quiet"]);
      runGit(["config", "user.email", "cli-e2e@example.invalid"]);
      runGit(["config", "user.name", "CLI E2E"]);
      runGit(["config", "commit.gpgSign", "false"]);
      runGit(["add", "README.md"]);
      runGit(["commit", "--quiet", "-m", "fixture"]);
      runGit(["worktree", "add", "--quiet", "-b", "dirty", linked]);
      writeFileSync(join(linked, "uncommitted.txt"), "keep warning\n");
      const linkedHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: linked,
        encoding: "utf8",
      }).trim();

      const row = buildAuditRow({
        state: state({
          path: linked,
          branch: "dirty",
          head: linkedHead,
          dirtyCount: 1,
          ignoredUnknownCount: 0,
          openProcessCount: 0,
        }),
        pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
        chat: { kind: "EXACT", threads: [] },
        mainPath: root,
      });

      assert.equal(
        verifyRemovalTarget({
          repoRoot: root,
          row,
          allowWarnings: true,
        }),
        true,
      );
      const result = removeWorktree({
        repoRoot: root,
        path: linked,
        force: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(linked), false);
      assert.doesNotMatch(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }),
        /worktree .*linked/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
