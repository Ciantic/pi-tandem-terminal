import { readFile, writeFile, rm } from "node:fs/promises";
import { setTimeout as nodeSetTimeout } from "node:timers/promises";
import { vtAnsiToText } from "./vtansi-to-text.js";

const POLL_INTERVAL_MS = 200;
const INIT_WAIT_MS = 800;
const DEFAULT_TIMEOUT = 2000;
const PROMPT_RE = /[$#]\s*$/;

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (
  cmd: string,
  args: string[],
  opts?: {
    /** AbortSignal to cancel the command */
    signal?: AbortSignal;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Working directory */
    cwd?: string;
  },
) => Promise<ExecResult>;
type ReadFileFn = {
  (path: string): Promise<Buffer>;
  (path: string, encoding: BufferEncoding): Promise<string>;
};

type WriteFileFn = (
  path: string,
  data: string,
  encoding: BufferEncoding,
) => Promise<void>;
type RmFn = (path: string, options?: { force?: boolean }) => Promise<void>;
type SleepFn = (ms: number) => Promise<void>;

export interface TerminalSessionOptions {
  exec: ExecFn;
  sessionName?: string;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  rm?: RmFn;
  sleep?: SleepFn;
  getTime?: () => number;
}

export class TerminalSession {
  private sessionReady = false;
  private logCursor = 0;
  private readonly sessionName: string;
  private readonly rcFile: string;
  private readonly logFile: string;
  private readonly exec: ExecFn;
  private readonly readFile: ReadFileFn;
  private readonly writeFile: WriteFileFn;
  private readonly rm: RmFn;
  private readonly sleep: SleepFn;
  private readonly getTime: () => number;

  constructor(options: TerminalSessionOptions) {
    this.exec = options.exec;
    this.readFile = options.readFile ?? readFile;
    this.writeFile = options.writeFile ?? writeFile;
    this.rm = options.rm ?? rm;
    this.sleep = options.sleep ?? ((ms) => nodeSetTimeout(ms));
    this.getTime = options.getTime ?? Date.now;
    this.sessionName = options.sessionName ?? `pi-bash-${this.getTime()}`;
    this.rcFile = `/tmp/${this.sessionName}.screenrc`;
    this.logFile = `/tmp/${this.sessionName}.log`;
  }

  get ready(): boolean {
    return this.sessionReady;
  }

  private async isAlive(): Promise<boolean> {
    const r = await this.exec("screen", ["-ls"]);
    return (r.stdout + r.stderr).includes(this.sessionName);
  }

  private async start(cwd: string): Promise<void> {
    await this.exec("screen", ["-S", this.sessionName, "-X", "quit"]).catch(
      () => {},
    );
    await this.rm(this.logFile, { force: true });
    this.logCursor = 0;

    await this.writeFile(
      this.rcFile,
      `logfile flush 0\nlogfile ${this.logFile}\n`,
      "utf8",
    );

    const r = await this.exec(
      "screen",
      ["-dmSq", this.sessionName, "-c", this.rcFile, "-L", "-s", "/bin/bash"],
      { cwd } as Record<string, unknown>,
    );
    if (r.code !== 0) {
      throw new Error(
        `Failed to start screen session: ${r.stderr || r.stdout}`,
      );
    }

    this.sessionReady = true;
    await this.sleep(INIT_WAIT_MS);
  }

  public async create(cwd: string): Promise<void> {
    if (this.sessionReady && (await this.isAlive())) return;
    await this.start(cwd);
  }

  private async readLogLines(): Promise<string[]> {
    let buf: Buffer;
    try {
      buf = await this.readFile(this.logFile);
    } catch {
      return [];
    }
    if (buf.length <= this.logCursor) return [];
    const slice = buf.subarray(this.logCursor);
    this.logCursor += slice.length;
    return slice.toString("utf8").split("\n");
  }

  public async captureNewOutput(): Promise<string> {
    const newLines = await this.readLogLines();
    if (newLines.length === 0) return "";
    return (await vtAnsiToText(newLines.join("\n"))).trim();
  }

  /**
   * Get scrollback buffer since the last prompt, or until timeout if no prompt is seen.
   *
   * @param timeoutMs
   * @param signal
   * @returns
   */
  public async getScrollbackBufferDelta(
    timeoutMs: number | null,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let accumulated: string[] = [];
    let lastChangeTime: number | null = this.getTime();

    while (true) {
      if (signal?.aborted) throw new Error("Command was cancelled.");

      const newLines = await this.readLogLines();
      if (newLines.length > 0) {
        accumulated.push(...newLines);
        lastChangeTime = this.getTime();
      }

      const output = (await vtAnsiToText(accumulated.join("\n"))).trim();

      const lastLine = output.split("\n").slice(-1)[0] ?? "";
      if (lastLine && PROMPT_RE.test(lastLine)) {
        return output;
      }

      if (this.getTime() - lastChangeTime >= (timeoutMs ?? DEFAULT_TIMEOUT)) {
        return "";
      }

      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  public async readTerminalWindow(): Promise<string> {
    const HARDCOPY_FILE = `/tmp/${this.sessionName}-hardcopy`;

    const r = await this.exec("screen", [
      "-S",
      this.sessionName,
      "-X",
      "hardcopy",
      HARDCOPY_FILE,
    ]);
    if (r.code !== 0) {
      throw new Error(`hardcopy failed: ${r.stderr || r.stdout}`);
    }

    const raw = await this.readFile(HARDCOPY_FILE, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .trimEnd();
  }

  public async sendKeys(keys: string, signal?: AbortSignal): Promise<void> {
    const r = await this.exec(
      "screen",
      ["-S", this.sessionName, "-X", "stuff", keys.replaceAll("\n", "^M")],
      { signal } as { signal?: AbortSignal },
    );
    if (r.code !== 0) {
      throw new Error(`Could not send keys to screen session: ${r.stderr}`);
    }
  }

  public async writeCommand(
    command: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sendKeys(
      command.replaceAll("^", "\\^").replaceAll("\n", "^M") + "^M",
      signal,
    );
  }

  public async destroy(): Promise<void> {
    if (this.sessionReady) {
      await this.exec("screen", ["-S", this.sessionName, "-X", "quit"]).catch(
        () => {},
      );
      this.sessionReady = false;
    }
  }
}
