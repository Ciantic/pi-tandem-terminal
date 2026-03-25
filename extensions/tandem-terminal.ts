import type {
  AgentToolResult,
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Agent } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { TerminalSession } from "../utils/terminal-session.js";

// Force sequential tool execution
// https://github.com/badlogic/pi-mono/blob/05c17cfbfeedd8099dad88b342457bfeb261b458/packages/agent/src/agent.ts#L169
Object.defineProperty(Agent.prototype, "_toolExecution", {
  get() {
    return "sequential";
  },
  set(_v) {
    /* ignore — always sequential */
  },
  configurable: true,
});

export default function (pi: ExtensionAPI) {
  const session = new TerminalSession({
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    sessionName: "pi-bash",
  });

  pi.on("before_agent_start", async (e, ctx) => {
    return {
      systemPrompt: `You are a helpful assistant with access to an interactive terminal session. Be concise, and use the available tools to achieve the goal the user sets for you.`,
    };
  });

  async function getTerminalOutputContext(
    signal?: AbortSignal,
  ): Promise<AgentToolResult<{}>> {
    // Get scrollback buffer if any, otherwise get current terminal window contents
    let returnedString = await session.getScrollbackBufferDelta(null, signal);
    if (!returnedString) {
      returnedString = await session.readTerminalWindow();
    }

    return {
      content: [
        {
          type: "text",
          text: returnedString,
        },
      ],
      details: {},
    };
  }

  // Track timing of send-keys-to-terminal calls for fast-call detection
  let lastSendKeysCallTime = 0;

  // Check if this is a fast consecutive call, then ask for confirmation before allowing it to proceed
  pi.on("tool_call", async (e, ctx) => {
    if (e.toolName !== "send-keys-to-terminal") return;
    const now = Date.now();
    const timeSinceLastCall = now - lastSendKeysCallTime;
    // const inputKeys = "" + e.input.keys || "";

    // If called within 2 seconds of the previous call, ask for confirmation
    if (timeSinceLastCall < 2000) {
      const choice = await ctx.ui.select(
        `⚠️ Rapid keystrokes detected. Allow?`,
        ["Yes", "No"],
      );

      if (choice !== "Yes") {
        return {
          block: true,
          reason:
            "User blocked sending keys to terminal session, ask from user how to proceed.",
        };
      }
    }

    // Update the last call time
    lastSendKeysCallTime = now;
  });

  // Multiline input needs user confirmation
  // pi.on("tool_call", async (e, ctx) => {
  //   if (e.toolName !== "send-keys-to-terminal") return;
  //   const inputKeys = "" + e.input.keys || "";
  //   if (inputKeys.includes("\n")) {
  //     const choice = await ctx.ui.select(
  //       `⚠️ Dangerous command:\n\n  ${inputKeys}\n\nAllow?`,
  //       ["Yes", "No"],
  //     );
  //     if (choice !== "Yes") {
  //       return {
  //         block: true,
  //         reason:
  //           "User blocked sending keys to terminal session, ask from user how to proceed.",
  //       };
  //     }
  //   }
  // });

  pi.registerTool({
    name: "read-terminal-window",
    description:
      "Read terminal window contents of the interactive terminal session, or any new output since the last read.",
    label: "Read terminal contents",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await session.create(ctx.cwd);
      return await getTerminalOutputContext();
    },
  });

  pi.registerTool({
    name: "send-keys-to-terminal",
    promptSnippet:
      "Send keys to the open interactive terminal session, this advances the terminal cursor by the keys you send.",
    // promptGuidelines: [
    //   "Examples:",
    //   "send-keys-to-terminal ^M - sends an Enter keystroke",
    //   "send-keys-to-terminal ^C - sends Ctrl+C to e.g. stop a running process",
    // ],
    description:
      "Send keys to terminal session, returns terminal output after sending the keys.",
    label: "Send keys to terminal session",
    parameters: Type.Object({
      keys: Type.String({
        description: `The keys to send to the terminal session.`,
      }),
      appendEnter: Type.Boolean({
        description: `Whether to append an Enter keystroke after the provided keys. If you are doing interactive keyshortcuts, then set this to false.`,
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { keys, appendEnter } = params;
      await session.create(ctx.cwd);
      await session.sendKeys(keys + (appendEnter ? "^M" : ""), signal);
      return await getTerminalOutputContext(signal);
    },

    // Custom rendering to show tool name and parameters
    renderCall(args, theme) {
      const { keys, appendEnter } = args;
      let text =
        theme.fg("toolTitle", theme.bold("send-keys-to-terminal")) + " ";

      // Show keys parameter
      const keysDisplay = keys.length > 50 ? `${keys.slice(0, 50)}...` : keys;
      text += theme.fg("accent", `"${keysDisplay}"`) + " ";

      // Show appendEnter parameter
      text += theme.fg("dim", `appendEnter: ${appendEnter}`) + "\n";

      return new Text(text, 0, 0);
    },
  });

  pi.on("session_shutdown", async () => {
    await session.destroy();
  });
}
