import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import type { CommandOptions, CommandResult } from "./domain.js";

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return property in error ? error[property as keyof typeof error] : undefined;
}

export function commandResult(
  command: string,
  args: string[],
  { cwd, timeoutMs = COMMAND_TIMEOUT_MS }: CommandOptions = {},
): CommandResult {
  try {
    return {
      status: 0,
      stdout: String(execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      })),
      stderr: "",
    };
  } catch (error) {
    const status = errorProperty(error, "status");
    const stdout = errorProperty(error, "stdout");
    const stderr = errorProperty(error, "stderr");
    const message = error instanceof Error ? error.message : undefined;
    return {
      status:
        typeof status === "number" && Number.isInteger(status) ? status : 1,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? message ?? ""),
    };
  }
}

export async function commandResultAsync(
  command: string,
  args: string[],
  { cwd, timeoutMs = COMMAND_TIMEOUT_MS }: CommandOptions = {},
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    return {
      status: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    const status = errorProperty(error, "status");
    const stdout = errorProperty(error, "stdout");
    const stderr = errorProperty(error, "stderr");
    const message = error instanceof Error ? error.message : undefined;
    return {
      status:
        typeof status === "number" && Number.isInteger(status) ? status : 1,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? message ?? ""),
    };
  }
}

export function nonEmptyLines(value: unknown): string[] {
  return String(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function getErrorProperty(error: unknown, property: string): unknown {
  return errorProperty(error, property);
}
