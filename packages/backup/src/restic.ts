import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResticCommandRunner {
  run(args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

export class SystemResticRunner implements ResticCommandRunner {
  async run(args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    try {
      const result = await execFileAsync("restic", args, { env: { ...process.env, ...options.env }, timeout: options.timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", code: typeof value.code === "number" ? value.code : 1 };
    }
  }
}

export function summarizeResticOutput(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-3).join(" | ").slice(0, 500);
}
