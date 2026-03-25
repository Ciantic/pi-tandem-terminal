import { describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalSession } from "../utils/terminal-session.js";

const DEFAULT_TIMEOUT = 2000;

// vtAnsiToText is a real xterm-based renderer — stub it to just return the raw input.
vi.mock("../utils/vtansi-to-text", () => ({
  vtAnsiToText: (raw: string) => Promise.resolve(raw),
}));

const ok = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr });
const fail = (stderr = "", stdout = "") => ({ code: 1, stdout, stderr });

function makeExec(
  responses: Record<
    string,
    { code: number; stdout: string; stderr: string }
  > = {},
) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    return responses[key] ?? ok();
  });
}

function makeSession(
  overrides: Partial<ConstructorParameters<typeof TerminalSession>[0]> = {},
) {
  return new TerminalSession({
    exec: makeExec(),
    sessionName: "test-session",
    sleep: () => Promise.resolve(),
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      ),
    ...overrides,
  });
}

// ─── ready getter ──────────────────────────────────────────────────────────────

describe("ready", () => {
  it("is false before create()", () => {
    const session = makeSession();
    expect(session.ready).toBe(false);
  });

  it("is true after create() succeeds", async () => {
    const exec = makeExec({ "screen -ls": ok("test-session") });
    const session = makeSession({ exec });
    await session.create("/tmp");
    expect(session.ready).toBe(true);
  });
});

// ─── create ───────────────────────────────────────────────────────────────────

describe("create()", () => {
  it("writes screenrc and starts a detached screen session", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const exec = makeExec();
    const session = makeSession({ exec, writeFile });

    await session.create("/home/user");

    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/test-session.screenrc",
      expect.stringContaining("logfile flush 0"),
      "utf8",
    );
    expect(exec).toHaveBeenCalledWith(
      "screen",
      expect.arrayContaining(["-dmSq", "test-session"]),
      expect.objectContaining({ cwd: "/home/user" }),
    );
  });

  it("throws when screen fails to start", async () => {
    const exec = makeExec({
      "screen -S test-session -X quit": ok(),
      "screen -dmSq test-session -c /tmp/test-session.screenrc -L -s /bin/bash":
        fail("oops"),
    });
    const session = makeSession({ exec });

    await expect(session.create("/tmp")).rejects.toThrow(
      "Failed to start screen session",
    );
  });

  it("is a no-op when session is already alive", async () => {
    const exec = makeExec({ "screen -ls": ok("test-session") });
    const session = makeSession({ exec });
    await session.create("/tmp");

    const callCount = exec.mock.calls.length;
    await session.create("/tmp");

    expect(exec.mock.calls.length).toBe(callCount + 1); // only -ls check, no restart
  });

  it("restarts when session is dead", async () => {
    const exec = makeExec({ "screen -ls": ok("something-else") });
    const session = makeSession({ exec });
    await session.create("/tmp");

    await session.create("/tmp");

    const startCalls = exec.mock.calls.filter(
      ([, args]) => args[0] === "-dmSq",
    );
    expect(startCalls.length).toBe(2);
  });
});

// ─── captureNewOutput ─────────────────────────────────────────────────────────

describe("captureNewOutput()", () => {
  it("returns empty string when log file does not exist", async () => {
    const session = makeSession();
    expect(await session.captureNewOutput()).toBe("");
  });

  it("returns decoded log content on first read", async () => {
    const logContent = Buffer.from("hello world\n");
    const readFile = vi.fn().mockResolvedValue(logContent);
    const session = makeSession({ readFile });

    const output = await session.captureNewOutput();
    expect(output).toBe("hello world");
  });

  it("returns only new content on subsequent reads", async () => {
    const first = Buffer.from("first\n");
    const second = Buffer.from("first\nsecond\n");
    const readFile = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const session = makeSession({ readFile });

    await session.captureNewOutput();
    const output = await session.captureNewOutput();
    expect(output).toBe("second");
  });

  it("returns empty string when no new content since last read", async () => {
    const logContent = Buffer.from("hello\n");
    const readFile = vi.fn().mockResolvedValue(logContent);
    const session = makeSession({ readFile });

    await session.captureNewOutput();
    const output = await session.captureNewOutput();
    expect(output).toBe("");
  });
});

// ─── readTerminalWindow ───────────────────────────────────────────────────────

describe("readTerminalWindow()", () => {
  it("returns trimmed hardcopy content", async () => {
    const exec = makeExec();
    const readFile = vi
      .fn()
      .mockResolvedValue("  line one  \n  line two  \n\n");
    const session = makeSession({ exec, readFile });

    const result = await session.readTerminalWindow();
    expect(result).toBe("  line one\n  line two");
  });

  it("throws when hardcopy command fails", async () => {
    const exec = makeExec({
      "screen -S test-session -X hardcopy /tmp/test-session-hardcopy":
        fail("permission denied"),
    });
    const session = makeSession({ exec });

    await expect(session.readTerminalWindow()).rejects.toThrow(
      "hardcopy failed",
    );
  });
});

// ─── sendKeys ─────────────────────────────────────────────────────────────────

describe("sendKeys()", () => {
  it("throws when screen stuff command fails", async () => {
    const exec = makeExec({
      "screen -S test-session -X stuff ^C": fail("no session"),
    });
    const session = makeSession({ exec });

    await expect(session.sendKeys("^C")).rejects.toThrow(
      "Could not send keys to screen session",
    );
  });

  it("sends keys successfully", async () => {
    const exec = makeExec();
    const session = makeSession({ exec });

    await session.sendKeys("ls");
    expect(exec).toHaveBeenCalledWith(
      "screen",
      ["-S", "test-session", "-X", "stuff", "ls"],
      expect.any(Object),
    );
  });

  it("replaces newlines with carriage returns", async () => {
    const exec = makeExec();
    const session = makeSession({ exec });

    await session.sendKeys("echo hi\nworld");

    expect(exec).toHaveBeenCalledWith(
      "screen",
      ["-S", "test-session", "-X", "stuff", "echo hi^Mworld"],
      expect.any(Object),
    );
  });
});

// ─── writeCommand ─────────────────────────────────────────────────────────────

describe("writeCommand()", () => {
  it("appends carriage return and delegates to sendKeys", async () => {
    const exec = makeExec();
    const session = makeSession({ exec });

    await session.writeCommand("echo hi");

    const stuffCall = exec.mock.calls.find(([, args]) =>
      args.includes("stuff"),
    );
    expect(stuffCall![1][4]).toBe("echo hi^M");
  });
});

// ─── destroy ──────────────────────────────────────────────────────────────────

describe("destroy()", () => {
  it("does nothing when session was never started", async () => {
    const exec = makeExec();
    const session = makeSession({ exec });

    await session.destroy();

    const quitCalls = exec.mock.calls.filter(([, args]) =>
      args.includes("quit"),
    );
    expect(quitCalls.length).toBe(0);
  });

  it("sends quit and sets ready to false", async () => {
    const exec = makeExec({ "screen -ls": ok("test-session") });
    const session = makeSession({ exec });
    await session.create("/tmp");
    expect(session.ready).toBe(true);

    await session.destroy();

    expect(session.ready).toBe(false);
    const quitCalls = exec.mock.calls.filter(
      ([, args]) => args[0] === "-S" && args.includes("quit"),
    );
    expect(quitCalls.length).toBeGreaterThan(0);
  });
});

// ─── timeout ─────────────────────────────────────────────────────────────────

describe("timeout", () => {
  it("sendKeys does not handle timeout (timeout is in getScrollbackBufferDelta)", async () => {
    const exec = makeExec();
    const session = makeSession({ exec });

    // sendKeys should complete immediately without waiting for timeout
    await session.sendKeys("ls");
    expect(exec).toHaveBeenCalled();
  });
});

// ─── AbortSignal cancellation ─────────────────────────────────────────────────

describe("cancellation", () => {
  it("sendKeys does not handle abort signals (timeout is in getScrollbackBufferDelta)", async () => {
    const exec = makeExec();
    const session = makeSession({ exec });

    const controller = new AbortController();
    controller.abort();

    // sendKeys should complete without checking the signal
    await session.sendKeys("ls", controller.signal);
    expect(exec).toHaveBeenCalled();
  });
});
