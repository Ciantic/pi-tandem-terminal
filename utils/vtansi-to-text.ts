import { Terminal } from "@xterm/headless";

/**
 * Converts a Linux `script` command log file to plain text by replaying
 * the ANSI/VT sequences through a headless terminal and reading back the buffer.
 *
 * Essentially this replays the terminal output as if it were being displayed in a real terminal, allowing us to strip out all the control characters.
 */
export async function vtAnsiToText(raw: string): Promise<string> {
  // Parse terminal dimensions from the script header line
  let content = raw;
  let cols = 80;
  let rows = 24;
  const dimMatch = raw.match(/COLUMNS="(\d+)".*?LINES="(\d+)"/);
  if (dimMatch && dimMatch[1] && dimMatch[2]) {
    cols = parseInt(dimMatch[1], 10);
    rows = parseInt(dimMatch[2], 10);
  }

  // Strip the script header ("Script started on ...") and footer ("Script done on ...")
  content = content.replace(/^Script started on[^\n]*\n/, "");
  content = content.replace(/\nScript done on[^\n]*\n?$/, "");

  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 100_000,
    allowProposedApi: true,
  });

  // Replay ANSI sequences - callback fires when all data has been processed
  await new Promise<void>((resolve) => terminal.write(content, resolve));

  // Extract plain text from the entire buffer (scrollback + active viewport)
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }

  terminal.dispose();

  // Drop leading empty lines that precede any real content
  while (lines.length > 0 && lines[0] === "") {
    lines.shift();
  }

  return lines.join("\n");
}
