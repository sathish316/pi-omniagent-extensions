# Pi Agent Extensions

This directory contains loose Pi extension files. Pi auto-discovers `*.ts` files here, but external npm dependencies are not bundled into those files.

After copying this directory to another machine or Pi profile, install the extension dependencies:

```bash
cd ~/.pi/agent/extensions
npm install
npm run check:claude-code-acp-deps
```

The `claude-code-acp.ts` extension needs:

- `@agentclientprotocol/sdk`
- `@agentclientprotocol/claude-agent-acp`

The Pi API packages imported by the extensions are provided by the running Pi installation.
