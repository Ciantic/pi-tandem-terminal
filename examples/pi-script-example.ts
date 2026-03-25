// This file exists purely to test that node_modules still workish, as I used overrides in package.json

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

// const authStorage = AuthStorage.create("./");

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  //   authStorage: AuthStorage.create(),
  //   modelRegistry: new ModelRegistry(authStorage),
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
