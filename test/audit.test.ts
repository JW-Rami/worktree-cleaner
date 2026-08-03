import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditRepositories,
  buildAuditRow,
  defaultSelection,
  DEFAULT_DISCOVERY_MAX_DEPTH,
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
  type AggregateAudit,
  type AuditRow,
  type ChatEvidence,
  type CommandResult,
  type ProgressEvent,
  type PullRequest,
  type PullRequestEvidence,
  type WorktreeState,
} from "../src/audit.js";
import {
  executeDeletion,
  parseInteractiveCommand,
  parseSelection,
  renderInteractive,
  runCli,
} from "../src/cli.js";

const mergedHead = "a".repeat(40);
const staleHead = "b".repeat(40);

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

describe("worktree-audit", () => {
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

  it("discovers nested repositories and deduplicates linked worktrees", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "worktree-audit-discovery-")),
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

  it("does not select a dirty or active worktree for removal", () => {
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
    assert.equal(dirty.decision, "KEEP_DIRTY");
    assert.equal(active.decision, "KEEP_ACTIVE_CHAT");
    assert.deepEqual(
      defaultSelection([candidate, dirty, active]),
      new Set([candidate.path]),
    );
  });

  it("keeps ambiguous ignored data in review", () => {
    const row = buildAuditRow({
      state: state({ ignoredUnknownCount: 1 }),
      pr: { kind: "MERGED_EXACT", pullRequest: pullRequest() },
      chat: { kind: "EXACT", threads: [] },
      mainPath: "/repo",
    });

    assert.equal(row.decision, "REVIEW");
    assert.equal(row.marker, "🟡");
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
        root: null,
        maxDepth: DEFAULT_DISCOVERY_MAX_DEPTH,
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
        root: "/tmp/projects",
        maxDepth: 3,
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

    assert.match(output, /Worktree Audit/u);
    assert.match(output, /Commands:/u);
    assert.match(output, /\/delete/u);
    assert.match(output, /\*  1/u);
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
      args: { cwd: "/repo", noGithub: false, noChat: false },
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
});
