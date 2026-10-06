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
- keeping lifecycle actions explicit: publish, import, restore, delete, and purge

## What you can do

### Publish a session

Run `/publish-session` to capture, scan, and publish the current agent session. You'll confirm an auto-generated title and summary, choose who can view it (public, GitHub organization, GitHub team, or specific GitHub users), set an expiration (default 14 days, a different duration, or never), and receive a private share link.

The server returns a complete success receipt using the API's original share URL. Copy the raw URL as shown; the server does not rebuild or shorten it. The host may make that line clickable. An agent can still rewrite its final chat response, so use the raw URL in the tool receipt if the chat link is missing or changed.

### Import and review a shared session

When a teammate shares a session with you, run `/import-session` with the downloaded ZIP file to extract and review it in a private, read-only workspace. You can browse the full conversation, attachments, and context the agent had without executing anything.

### Manage published sessions

- Get the markdown share card for pasting into PRs, etc. with `/get-session-card`
- Restore a session you previously deleted with `/restore-session`
- Take a published session offline with `/delete-session` (reversible)
- Permanently remove a session with `/purge-session` after deleting it (irreversible)
- Permanently remove all your deleted sessions with `/purge-sessions` in one step

## Supported hosts

The plugin works best with CLI tools that capture sessions natively:

- **GitHub Copilot CLI** — Full support
- **Claude Code** — Full support
- **Codex CLI** — Full support
- **VS Code Copilot Chat** (local chats, stable and Insiders) — Publish the current chat, including from the PR share-card prompt, with no setup

Other VS Code session kinds (Agent Host and remote windows) and GitHub Copilot Desktop have limited support; use one of the CLI tools for the best experience.

In VS Code, the server reads the current chat's ID from each tool call and
finds VS Code's local chat store automatically. VS Code keeps its own
copy of the plugin, so update the plugin in VS Code too after you update it
elsewhere.

The MCP server selects CLI sessions from native state. Copilot uses its
profile-guarded runtime session ID. Supported Codex requests carry a
request-scoped thread ID that the server verifies in the configured Codex
profile. Claude Code's plugin hook supplies the current session ID, transcript
path, and working directory for each publish-tool call. It signs those values
with a short-lived, one-use proof tied to the tool operation. The server checks
the proof and journal ID before selecting the source. Claude does not need to
copy recent conversation turns into the tool request when the proof is valid.
If the proof is missing or invalid, the server treats any supplied ID or path
as a hint and requires an exact, unique match against the newest recent
conversation turns instead.

## Quick start

1. Install the plugin (see [Installation](#installation) below).
2. Start an agent session and run `/publish-session`.
3. The plugin captures your session and scans it locally for secrets.
4. Review the findings and decide what to redact.
5. Confirm the auto-generated title, summary, audience, and expiration.
6. Get back a server-authored receipt with the share URL — send the raw URL to anyone who needs to review your session.

## Installation

Session Registry is a full agent plugin: it ships the slash-command skills *and* the MCP server that backs them. Install it as a plugin, not as a bare MCP server, or the `/publish-session` style commands won't show up.

All three clients pull from the same marketplace repo, `brandonh-msft/ghcp-plugins`, which registers under the name `brandonh-msft-plugins`. That's why the install target is `session-registry@brandonh-msft-plugins` and not the repo name.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add brandonh-msft/ghcp-plugins
copilot plugin install session-registry@brandonh-msft-plugins
```

To skip the marketplace and install straight from this repo:

```bash
copilot plugin install brandonh-msft/plugin-session_registry
```

Verify:

```bash
copilot plugin list
copilot mcp get session-registry
```

Then start a new session and run `/mcp` to confirm the server is connected.
Seeing the plugin or its skills listed does not prove its MCP server loaded.

### Claude Code

From your shell:

```bash
claude plugin marketplace add brandonh-msft/ghcp-plugins
claude plugin install session-registry@brandonh-msft-plugins
```

Or from inside a Claude Code session:

```text
/plugin marketplace add brandonh-msft/ghcp-plugins
/plugin install session-registry@brandonh-msft-plugins
```

Add `--scope project` to the shell commands to install for one repo instead of your user account.

### Codex CLI

Register the marketplace from your shell:

```bash
codex plugin marketplace add brandonh-msft/ghcp-plugins
```

Then open the plugin browser inside Codex:

```text
/plugins
```

Pick **session-registry** and install it, then start a new session — bundled skills and MCP tools only load at session start.

Verify the MCP side is up with `/mcp`; you should see `session-registry` listed.

### After installing

Use Node.js 24 or later on your `PATH`. The plugin includes the ready-to-run MCP server;
there is no dependency install or build step. Sessions publish to `https://sessionregistry.io`,
and your first publish registers you automatically. If you're signed in to the GitHub CLI (`gh`)
and have published from another machine, that first publish connects you to your existing
publisher instead of creating a new one, so you can manage those sessions here too.

### How the CLI selects your session

Keep using `/publish-session`. In Copilot CLI, Codex CLI, and Claude Code CLI,
the plugin publishes the current conversation, not a manually selected older
session. Copilot and supported Codex connections supply active native IDs.
Claude's plugin hook supplies the current ID and journal path on each call;
the server also verifies recent conversation content rather than trusting
an arbitrary ID argument.

When automatic identity is unavailable, the agent supplies 3–6 recent
verbatim user and assistant turns from its current context, ending with the
latest user prompt. The server compares the entire window with the latest
eligible native history and requires a unique match. One matching prompt or
an older matching excerpt is not enough. It retries short persistence delays
before reporting a mismatch or insufficient evidence. You do not need to find a session UUID,
locate a journal, or use another publishing command. These changes do not alter
IDE or desktop capture selection.

### If the skills load but the MCP server is missing

Plugin version 1.0.0 shipped only the portable `mcp.json` configuration. Copilot CLI
1.0.70 uses the portable `mcp.json`, while Claude Code reads the MCP server
configuration inlined in the generated `.claude-plugin/plugin.json`.
An updated artifact includes both host projections without creating a root
`.mcp.json`.

In Copilot CLI, update the plugin with
`copilot plugin update session-registry@brandonh-msft-plugins`, then fully exit and
restart the CLI. Check `copilot --version` in the terminal you actually use: an
older running process or another installation on `PATH` may differ from a newly
opened terminal. Copilot CLI 1.0.87 can also discover the original portable configuration.

If `/mcp` shows the server but reports a startup failure, check that `node --version`
reports 24 or later and read the server's startup error. Do not install dependencies
inside the plugin or replace the host's MCP connection with a script.

### If `/mcp` says connected but the agent says otherwise

A host can list all 12 server tools while the agent calls an unsupported bare name
such as `save_session`. MCP operation names and the callable names exposed to the
agent are not always identical. This is a tool-routing failure, not proof that the
server disconnected.

Use the exact callable identifier and schema the host exposes. In Copilot CLI, search for the exact operation name, such as `session-registry-save_session`. Claude Code's plugin tool name includes the plugin and server namespaces, for example `mcp__plugin_session-registry_session-registry__save_session`. Codex may list tools directly without `tool_search`; use its exact namespace and operation as separate values, and never concatenate them. Do not use MCP resource discovery such as `resources/list` or `list_mcp_resources`; Session Registry exposes tools, not resources. An `unsupported call` is not evidence that the server is disconnected. Do not reinstall a connected server or bypass the host with a custom client. After a plugin update, start a new session to load the revised skills and server instructions.

## Security & privacy

- **Scan before upload** — your machine finds secrets before anything leaves
- **You control redactions** — for each detected secret, redact it or leave it as-is
- **Lock down access** — choose public, GitHub org/team, or specific GitHub users
- **Set expiration** — default 14 days, or choose a different duration, or never expire
- **Reverse delete** — `/delete-session` takes it offline but keeps it recoverable
- **Permanent delete** — `/purge-session` removes it permanently
- **No auto-publish** — publishing always requires your approval

## Use cases

**Debugging with teammates**: Have a complex issue? Publish the session and share the link with your team to let them see exactly what the agent did.

**Preserving session context**: Want to document a working solution or a interesting agent behavior for later? Publish it and keep the link in your wiki.

**Code review**: Attach the session share card to a pull request so reviewers can see the full context of why changes were made.

**Learning from sessions**: Share your agent sessions with junior teammates to show problem-solving approaches and agent techniques.

**Demos and documentation**: Create a reproducible example of an agent workflow and publish it so others can follow along.

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

## Complete command reference

| Command | Purpose | Output |
| --- | --- | --- |
| `/publish-session` | Capture, scan, and publish your session | Share URL + metadata |
| `/import-session <zip-file>` | Import a downloaded session for review | Read-only workspace access |
| `/get-session-card` | Get the PR-ready share card markdown | Copyable markdown card |
| `/restore-session` | Restore a session you deleted | Session becomes available again |
| `/delete-session` | Stop sharing a published session | Confirmation (reversible) |
| `/purge-session` | Permanently remove a deleted session | Confirmation (irreversible) |
| `/purge-sessions` | Permanently remove ALL deleted sessions | Bulk confirmation |

## Understanding the lifecycle

**Published** → **Deleted** → **Purged**

- **Published**: The session is active and shareable; people can access it with your share link
- **Deleted**: The session is offline; the share link no longer resolves, but the data is kept and can be restored or purged
- **Purged**: The session is permanently removed; cannot be recovered

Think of it like email: Delete moves to Trash (reversible), Purge removes from Trash (permanent).

## FAQ

**Q: Does the plugin auto-publish my sessions?**
No. Publishing is always explicit — you must run `/publish-session`. The plugin will never publish without your approval.

**Q: What if I accidentally publish something I shouldn't?**
Run `/delete-session` immediately to take it offline and stop the share link from working. No one can access it anymore. If you need assurance it doesn't exist anywhere at all and won't want it available later, run `/purge-session` to permanently delete it.

**Q: Can I share a session with just specific GitHub users?**
Yes! When publishing, set the audience to specific GitHub usernames. Only those people can access it (once they sign in with GitHub).

**Q: How long does a published session stay available?**
By default, 14 days. You can choose a different duration (30 days, 90 days, and so on) or set it to never expire. After expiration, the session becomes inaccessible, but you can still delete and purge it.

**Q: What happens when I import a session?**
The ZIP file is extracted into a private, read-only workspace ready for you to give your agent instructions on what to do with it. You can ask questions, get insights, etc. - if you have all the same tools available as the person who published and are running it on the same harness, you could even tell your agent to spin up a resumed version of it (ymmv).

**Q: Are my credentials at risk?**
The plugin scans for secrets on your machine before anything uploads. It flags tokens, keys, passwords, and similar values, and you decide what happens to each one: redact it or leave it as-is. Nothing uploads until every finding has a decision (an unanswered finding blocks the whole publish). Keep in mind the scanner isn't perfect, so you can also supply your own text to redact (and an optional specific replacement for it) for anything it missed.

**Q: What data is captured?**
The full native session: your conversation, all files the agent created or attached, dependencies, and context. Depending on the client you're using, this may/may not include any attachments *you* uploaded to the conversation as well (screenshots, etc.). It does NOT include your local filesystem outside the session, system environment, or private files not attached to the session.

**Q: Can I edit a session after publishing?**
No. If you need changes, publish a new session with the updated content.

**Q: Why does a large session take time after I approve its metadata?**
The plugin checks your final redactions against the full captured source before uploading. It sends progress updates while reviewing and lets cancellation stop the request before upload. Individual file-processing steps can still take time. Review no longer builds an extra ZIP; the approved bundle is staged once for publication. Progress does not extend a client's fixed wall-clock deadline.

## Troubleshooting

| Error | What happened | What to do |
| --- | --- | --- |
| `PUBLISH FAILED` | The server classified a failed publish step and returned retry guidance | Follow `automaticRetry`, `retryAfterSeconds`, and the exact `retryRequest`. After the retry limit, tell the owner and stop. If the result includes `resume`, a later owner-requested retry calls `save_session` with that `captureId` and `resume: true`, which reuses the recorded decisions without new forms |
| `PUBLISH STATE UNKNOWN` | The registry did not return a trustworthy receipt, so the session may have published | Keep the same `captureId` and confirmed values. Retry only when the returned continuation allows it; never recapture or claim success without the full share URL |
| `CAPTURE NOT FOUND` | The local capture files were deleted or moved | Check for an existing share link first — the session may have published already. Otherwise publish a fresh session |
| `SECURITY REVIEW REQUIRED` | Detected secrets still need a decision, so nothing uploaded | Review each finding and choose to redact it or leave it as-is, then publish again |
| `MISSING_DEPENDENCY` | A referenced historical file is missing from its recorded path | If the owner has the relocated historical copy, map that exact reference to the current file and retry |
| `UNSUPPORTED_DEPENDENCY` | The selected host source contains a dependency format this adapter cannot decode | Report the error; do not treat it as a request to authorize arbitrary files |
| Not found or not owned by you | The session belongs to a different publisher, or the id is wrong | Only the original publisher can manage a session. Confirm you're using the `sessionId` from the original publish result, not the share URL |
| Import fails | The ZIP is incomplete, invalid, or failed hash verification | Re-download the bundle and try again. Treat bundles from untrusted sources carefully — imports are read-only, but untrusted content can still influence your agent |

- `SESSION_REGISTRY_CAPTURE_TIMEOUT_MS` sets how long, in milliseconds, native capture may go without making progress before it stops. A large session that keeps making progress is not cut off. Default: 30000. Invalid, zero, or negative values fail clearly.
