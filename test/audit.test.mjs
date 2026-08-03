import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAuditRow,
  defaultSelection,
  groupChatThreadsByCwd,
  matchPullRequest,
  measureWorktreeSizes,
  parseArgs,
  parseWorktreeList,
  PROGRESS_STAGES,
  repositoryFromRemote,
  removeWorktree,
  renderAudit,
} from "../src/audit.mjs";
import {
  executeDeletion,
  parseInteractiveCommand,
  parseSelection,
  renderInteractive,
  runCli,
} from "../src/cli.mjs";

const mergedHead = "a".repeat(40);
const staleHead = "b".repeat(40);

function state(overrides = {}) {
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

function pullRequest(overrides = {}) {
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

  it("does not select a dirty or active worktree for removal", () => {
    const mergedChat = {
      kind: "EXACT",
      threads: [{ id: "chat-1", title: "Feature A", status: "idle" }],
    };
    const mergedPr = { kind: "MERGED_EXACT", pullRequest: pullRequest() };
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
      chats.get("/tmp/worktree-a").threads.map((thread) => thread.id),
      ["chat-a"],
    );
    assert.equal(chats.get("/tmp/worktree-b").kind, "NO_CHAT");
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
      { repository: "The-JW-Corp/Invisible", rows: [row] },
      { color: false },
    );

    assert.match(output, /SAFE/u);
    assert.match(output, /PR #42 MERGED/u);
    assert.match(output, /Feature A/u);
    assert.match(output, /dirty=0/u);
    assert.doesNotMatch(output, /dernier commit=/u);
  });

  it("parses safe CLI modes", () => {
    assert.deepEqual(
      parseArgs(["--interactive", "--merged-only", "--cwd", "/tmp/repo"]),
      {
        cwd: "/tmp/repo",
        json: false,
        interactive: true,
        mergedOnly: true,
        noGithub: false,
        noChat: false,
        deepProcessScan: false,
      },
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
      { repository: "The-JW-Corp/Invisible", rows: [row] },
      { selected: new Set([row.path]) },
    );

    assert.match(output, /Worktree Audit/u);
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
    const calls = [];
    const result = await executeDeletion({
      audit: { repoRoot: "/repo", rows: [row] },
      paths: [row.path],
      args: { cwd: "/repo", noGithub: false, noChat: false },
      output: { write() {} },
      errorOutput: { write() {} },
      auditFn: async () => ({ repoRoot: "/repo", rows: [row] }),
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

  it("fails clearly when interactive mode has no TTY", async () => {
    await assert.rejects(
      runCli({
        argv: ["--interactive"],
        input: { isTTY: false },
        output: { isTTY: false },
        errorOutput: { write() {} },
      }),
      /terminal interactif \(TTY\)/u,
    );
  });

  it("parses aggregate du output without requiring one command per worktree", () => {
    const progress = [];
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
    const calls = [];
    const result = removeWorktree({
      repoRoot: "/repo",
      path: "/tmp/worktree-a",
      runCommand(command, args) {
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
