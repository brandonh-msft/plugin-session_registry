# Session Registry

Capture the real session, keep the private parts private, and publish only what you intend to share.

Session Registry is a portable Agent Plugin for native AI agent sessions. It reads the host's native session data instead of relying on a generated transcript, scans for secrets before upload, and gives you controlled sharing with audience and expiration policy.

## Why this plugin exists

When an agent session is useful to others, the raw chat transcript is rarely the right artifact. It is often incomplete, may omit the real context the host used, and can leak secrets that never belonged in the final share.

Session Registry fixes that by:

- capturing the native session from the host runtime
- scanning locally before anything leaves the machine
- publishing only approved session content
- enforcing access policy and expiry controls
- keeping lifecycle actions explicit: publish, import, delete, and purge

## What you can do

### Publish a session

Use the `publish-session` skill to publish a native session to the registry and receive a collaborator share link.

### Import a session

Use `import-session` to restore a previously published session into a local or host-managed flow when you need to review, compare, or rehydrate it.

### Clean up safely

Use `delete-session` and `purge-session`/`purge-sessions` to remove sessions or purge stored captures when they are no longer needed.

## Supported hosts

The plugin is designed for the native capture targets that matter most:

- GitHub Copilot CLI
- Claude Code
- Codex CLI

VS Code and the Copilot app are treated as projection targets, not the primary native-capture path.

## Quick start

1. Install the plugin in a supported host.
2. Provide the registry endpoint and credentials through the host's secret store or environment.
3. Start a native agent session.
4. Run `/publish-session` or the matching skill in the client.
5. Review the auto-generated metadata and audience policy.
6. Confirm the publish action and copy the returned share URL.

## Configuration

The MCP server expects these environment values at runtime:

```bash
SESSION_REGISTRY_API_URL=https://sessionregistry.io
SESSION_REGISTRY_TOKEN=your-token
```

For local work, use the same pattern with a local API URL and a host-managed secret source. Avoid hardcoding credentials in portable config files.

## Security model

This plugin is built to be explicit about trust boundaries:

- native capture is preferred over synthetic transcript generation
- local scanning happens before upload
- secret findings must be accepted or resolved before publication
- audience policy and expiry are part of the publication flow
- publishing is an explicit, owner-reviewed action

## Repository layout

This plugin package is intentionally portable and self-contained:

- `skills/` contains the user-facing skills
- `packages/` holds the plugin runtime and shared logic
- `scripts/` contains the MCP server launcher
- `mcp.json` defines the stdio server wiring
- `plugin.json` defines the portable plugin manifest

## A simple workflow

```text
Install plugin
  -> start agent session
  -> capture native session
  -> scan for secrets
  -> review title, summary, and policy
  -> publish
  -> share a collaborator link
```

## Why it matters

Session Registry is meant for teams that want to preserve operational context without turning every session into an uncontrolled public artifact. It keeps the provenance of a session, makes the review step intentional, and gives the owner a clear control point over who can view the content and for how long.

If you want to preserve what happened in an agent session and share it deliberately, this plugin gives you a safer path than uploading a raw transcript by accident.
