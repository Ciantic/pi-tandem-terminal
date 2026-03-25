# Run a terminal session in tandem with your agent!

This provides two tools, and I recommend disabling all other tools while using this, so the agent won't get confused about which tool to use:

- `send-keys-to-terminal`
- `read-terminal-window`

This way pi agent can interact with an interactive terminal session.

First of all, you probably should run these sessions in a container. I do that myself.

However you can start it dangerously without containers like this:

```bash
pi --no-tools --extension "$HOME/path-to-the/pi-tandem-terminal"
```

Then if you want to see the session in action as you prompt the pi, you can run the example script:

```bash
screen -R -S pi-bash
```

## Prerequisites

- `screen` installed on your system
