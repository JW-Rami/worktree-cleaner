import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LINKED_BRANCH = "e2e-linked";
const KEY_DELAY_MS = 100;
const PTY_TIMEOUT_MS = 15_000;
const PTY_ACTIONS = Object.freeze({
  SELECT_AND_QUIT: "select-and-quit",
  SELECT_AND_DELETE: "select-and-delete",
} as const);
type PtyAction = (typeof PTY_ACTIONS)[keyof typeof PTY_ACTIONS];
const REPOSITORY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI_ENTRYPOINT = join(REPOSITORY_ROOT, "dist", "src", "cli.js");

interface PtyResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

interface GitFixture {
  repositoryRoot: string;
  tempRoot: string;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
  });
}

function createGitFixture(): GitFixture {
  const tempRoot = mkdtempSync(join(tmpdir(), "worktree-cleaner-cli-e2e-"));
  const root = join(tempRoot, "repo");
  mkdirSync(root);

  try {
    writeFileSync(join(root, "README.md"), "# CLI E2E fixture\n");
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.email", "cli-e2e@example.invalid"]);
    runGit(root, ["config", "user.name", "CLI E2E"]);
    runGit(root, ["config", "commit.gpgSign", "false"]);
    runGit(root, ["add", "README.md"]);
    runGit(root, ["commit", "--quiet", "-m", "fixture"]);
    runGit(root, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      LINKED_BRANCH,
      join(tempRoot, "linked"),
    ]);
    return { repositoryRoot: root, tempRoot };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

const PYTHON_PTY_RUNNER = String.raw`
import errno
import os
import pty
import select
import signal
import sys
import time

action = sys.argv[1]
command = sys.argv[2:]
if not command:
    raise SystemExit("missing command")

child_pid, master_fd = pty.fork()
if child_pid == 0:
    os.execvpe(command[0], command, os.environ)

deadline = time.monotonic() + ${PTY_TIMEOUT_MS / 1000}
buffer = bytearray()
sent_keys = False
sent_exit = False
child_status = None

try:
    while True:
        if time.monotonic() > deadline:
            os.kill(child_pid, signal.SIGKILL)
            os.waitpid(child_pid, 0)
            raise SystemExit(124)

        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if readable:
            try:
                data = os.read(master_fd, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
            buffer.extend(data)
            if not sent_keys and b"audit> " in buffer:
                sent_keys = True
                os.write(master_fd, b"\x1b[B")
                time.sleep(${KEY_DELAY_MS / 1000})
                os.write(master_fd, b" ")
                time.sleep(${KEY_DELAY_MS / 1000})
                if action == "${PTY_ACTIONS.SELECT_AND_DELETE}":
                    os.write(master_fd, b"/delete\r")
                else:
                    os.write(master_fd, b"q")
                    sent_exit = True

            if (
                action == "${PTY_ACTIONS.SELECT_AND_DELETE}"
                and sent_keys
                and not sent_exit
                and (
                    b"No SAFE selection can be deleted" in buffer
                    or b"Deletion preview" in buffer
                )
            ):
                os.write(master_fd, b"q")
                sent_exit = True

        if child_status is None:
            waited_pid, child_status = os.waitpid(child_pid, os.WNOHANG)
            if waited_pid == 0:
                child_status = None
        elif not readable:
            break
finally:
    os.close(master_fd)

if child_status is None:
    _, child_status = os.waitpid(child_pid, 0)
if os.WIFEXITED(child_status):
    raise SystemExit(os.WEXITSTATUS(child_status))
if os.WIFSIGNALED(child_status):
    raise SystemExit(128 + os.WTERMSIG(child_status))
raise SystemExit(1)
`;

function ptyArguments(fixtureRoot: string, action: string): string[] {
  return [
    "-c",
    PYTHON_PTY_RUNNER,
    action,
    process.execPath,
    CLI_ENTRYPOINT,
    "--cwd",
    fixtureRoot,
    "--no-github",
    "--no-chat",
  ];
}

function runCliInPty(
  fixtureRoot: string,
  action: PtyAction = PTY_ACTIONS.SELECT_AND_QUIT,
): Promise<PtyResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ptyArguments(fixtureRoot, action), {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    let settled = false;

    const output = (): string => chunks.join("");

    const settle = (result: PtyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const collect = (chunk: Buffer | string): void => {
      chunks.push(chunk.toString());
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      settle({ code, signal, output: output() });
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`CLI PTY timed out.\n${output()}`));
    }, PTY_TIMEOUT_MS);
  });
}

describe("CLI interaction E2E", () => {
  it(
    "moves to a linked worktree and visibly selects it with Space",
    {
      skip:
        process.platform === "win32"
          ? "A POSIX PTY and Python 3 are required for this test."
          : false,
      timeout: PTY_TIMEOUT_MS,
    },
    async () => {
      const fixture = createGitFixture();

      try {
        const result = await runCliInPty(fixture.repositoryRoot);

        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /▶\s+◆\s+1\s+MAIN/u);
        assert.match(result.output, /▶\s+⚠️\s+2\s+UNKNOWN/u);
        assert.match(result.output, /1 selected · 0 SAFE/u);
        assert.match(
          result.output,
          /Blocked: GitHub PR evidence unavailable/u,
        );
        assert.match(result.output, /Session ended\./u);
      } finally {
        rmSync(fixture.tempRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "keeps the delete refusal visible after Enter",
    {
      skip:
        process.platform === "win32"
          ? "A POSIX PTY and Python 3 are required for this test."
          : false,
      timeout: PTY_TIMEOUT_MS,
    },
    async () => {
      const fixture = createGitFixture();

      try {
        const result = await runCliInPty(
          fixture.repositoryRoot,
          PTY_ACTIONS.SELECT_AND_DELETE,
        );

        assert.equal(result.code, 0, result.output);
        const lastFrame = result.output.split("\u001b[2J\u001b[H").at(-1) ?? "";
        assert.match(
          lastFrame,
          /Status: ⚠️ No SAFE selection can be deleted\. Select a SAFE row\./u,
        );
      } finally {
        rmSync(fixture.tempRoot, { recursive: true, force: true });
      }
    },
  );
});
