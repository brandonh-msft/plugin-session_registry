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

Run `/publish-session` to capture, scan, and publish the current agent session. You'll confirm an auto-generated title and summary, choose who can view it (public, GitHub organization, GitHub team, or specific GitHub users), set an expiration (default 14 days, a different duration, or never), and receive a private share link.

### Import and review a shared session

When a teammate shares a session with you, run `/import-session` with the downloaded ZIP file to extract and review it in a private, read-only workspace. You can browse the full conversation, attachments, and context the agent had without executing anything.

### Manage published sessions

- Get the markdown share card for pasting into PRs, etc. with `/get-session-card`
- Take a published session offline with `/delete-session` (reversible)
- Permanently remove a session with `/purge-session` after deleting it (irreversible)
- Permanently remove all your deleted sessions with `/purge-sessions` in one step

## Supported hosts

The plugin works best with CLI tools that capture sessions natively:

- **GitHub Copilot CLI** — Full support
- **Claude Code** — Full support
- **Codex CLI** — Full support

VS Code and GitHub Copilot Desktop have limited support; use one of the CLI tools for the best experience.

## Quick start

1. Install the plugin (see [Installation](#installation) below).
2. Start an agent session and run `/publish-session`.
3. The plugin captures your session and scans it locally for secrets.
4. Review the findings and decide what to redact.
5. Confirm the auto-generated title, summary, audience, and expiration.
6. Get back a share URL — send it to anyone who needs to review your session.

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
```

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

No additional setup. Sessions publish to `https://sessionregistry.io`, and your first publish registers you automatically.

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
## Troubleshooting

| Error | What happened | What to do |
| --- | --- | --- |
| `PUBLISH STATE UNKNOWN` | The upload timed out or lost its connection, so the outcome is unclear | Retry the same command. Retries are idempotent, so you won't get a duplicate session |
| `CAPTURE NOT FOUND` | The local capture files were deleted or moved | Check for an existing share link first — the session may have published already. Otherwise publish a fresh session |
| `SECURITY REVIEW REQUIRED` | Detected secrets still need a decision, so nothing uploaded | Review each finding and choose to redact it or leave it as-is, then publish again |
| `UNSUPPORTED_DEPENDENCY` / `MISSING_DEPENDENCY` | The session references a file outside its own folder that you haven't authorized | The error lists the exact paths it needs. Approve them and retry |
| Not found or not owned by you | The session belongs to a different publisher, or the id is wrong | Only the original publisher can manage a session. Confirm you're using the `sessionId` from the original publish result, not the share URL |
| Import fails | The ZIP is incomplete, invalid, or failed hash verification | Re-download the bundle and try again. Treat bundles from untrusted sources carefully — imports are read-only, but untrusted content can still influence your agent |
