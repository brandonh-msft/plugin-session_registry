---
name: publish-session
description: Capture, scan, summarize, publish, and share native AI agent sessions (Copilot CLI, Claude Code, Codex CLI) securely with full fidelity and audience policy controls.
---

# `publish-session` Agentic Skill

Use this skill to publish the current native AI agent session to the Secure Agent Session Registry and return a collaborator share link. The workflow captures the full native session package, scans it locally before upload, drafts publish metadata, applies access and expiration policy, uploads the approved capture, and reports the external link.

## When to Use

Invoke this skill when a user:

- Types `/publish-session`
- Requests to "publish this session", "share this session", "upload this session", or "register this session"
- Asks for a shareable external link to an active or archived Copilot CLI, Claude Code, or Codex CLI session

Do not describe this as merely "saving" a session. Publication uploads approved session content for external access according to the selected audience policy.

## Host Capability & Onboarding Matrix

| Host | Plugin Installation | Skill Discovery | MCP Startup | Secret Delivery | Response Budget |
| --- | --- | --- | --- | --- | --- |
| **GitHub Copilot CLI** | `copilot plugin install` / `plugin.json` | Automatic via `skills/publish-session/SKILL.md` | Stdio launcher (`scripts/mcp-server.mjs`) | `SESSION_REGISTRY_CREDENTIAL_FILE` or `SESSION_REGISTRY_TOKEN` env | 15+ minutes (900000ms) |
| **Claude Code** | `.mcp.json` / plugin import | Automatic via `skills/publish-session/SKILL.md` | Stdio launcher (`scripts/mcp-server.mjs`) | Host secret store / `.mcp.json` env | 15+ minutes (900000ms) |
| **Codex CLI** | Plugin manifest / `.mcp.json` | Automatic via `skills/publish-session/SKILL.md` | Stdio launcher (`scripts/mcp-server.mjs`) | Host secret store / `SESSION_REGISTRY_CREDENTIAL_FILE` | 15+ minutes (900000ms) |
| **VS Code / Copilot App** *(Projection only)* | Plugin manifest | Non-blocking | Stdio launcher | Host secret store / env | 15+ minutes |

*Note: VS Code Agent Plugins and GitHub Copilot App are non-blocking projection targets. Installation or discovery does not by itself establish native session-capture support.*

## Execution Protocol

Run the workflow in these deterministic phases:

1. Pre-flight check: verify host Node 24+, MCP server, configuration readiness, credential permissions, and trusted HTTPS origins.
2. Context detection: identify the native harness, session source, and interaction mode.
3. Capture and scan: create a full-fidelity native capture and perform local secret scanning before upload.
4. Metadata and policy: draft the title, summary, audience, and expiration.
5. Atomic publication: invoke the registry MCP tools with idempotent retry handling.
6. Share output: return the collaborator-facing share URL and safety notice.

## Phase 1: Pre-flight Environment and Health Check

### Prerequisites & Readiness
- **Node.js**: Node 24 or higher must be installed on the host.
- **MCP Server**: The stdio launcher (`scripts/mcp-server.mjs`) starts the server process using Node 24.
- **Response Budget**: The host MCP configuration must allocate a response budget of at least 15 minutes (900,000 ms) for session capture and scanning operations.

### Configuration & Credential Safety
The MCP server requires the following configuration environment variables:
- `SESSION_REGISTRY_API_URL`: Absolute URL of the registry API service. Production uses `https://sessionregistry.io`; local development uses `http://localhost:8080`.

**Origin Security Rules:**
- `SESSION_REGISTRY_API_URL` must be an absolute HTTP/HTTPS URL. The API returns the complete collaborator-facing share URL.
- Non-loopback production origins **must** use `https://`. Only loopback origins (`localhost`, `127.0.0.1`, `[::1]`) permit plain `http://`.
- HTTP redirects are rejected during API requests to prevent credential leaks.

**Credential Delivery:**
- Credentials **must** remain runtime-only and never be embedded in portable plugin distribution files (`mcp.json`, `.mcp.json`).
- On portable hosts (e.g. Copilot CLI, Codex), supply token credentials via `SESSION_REGISTRY_CREDENTIAL_FILE` pointing to a per-user file (e.g. `~/.session-registry/credentials.json`) with strict user-only permissions (`0600` on Unix), containing `{"token": "<your-token>"}`. Alternatively, set `SESSION_REGISTRY_TOKEN` in the environment.
- On Claude Code or Codex, use the host's secret storage or environment injection for `SESSION_REGISTRY_TOKEN`.

**Readiness Evaluation:**
- Configuration changes take effect only after reloading or restarting the MCP server session.
- If credentials or origins are invalid, the pre-flight check fails immediately before performing native reads or requesting upload slots.
- (For local repository development setups, use the backing repository's local development documentation. That infrastructure documentation is intentionally not distributed inside the portable plugin.)

## Phase 2: Native Session Identification and Context Detection

Identify the producing harness and native source:

- **GitHub Copilot CLI**: Prefer the runtime-provided `COPILOT_AGENT_SESSION_ID`; the `save_session` MCP tool binds to it automatically.
- **Claude Code**: Use the active session folder or pass `sessionDirectory` / `sourcePath`.
- **Codex CLI**: Use the active rollout/session source or pass `sourcePath`.
- **Fallback**: Use `workingDirectory` plus an exact distinctive `recentUserMessage` from the current conversation to resolve one unique native journal.

Never ask the user to find or retype obscure UUIDs or native journal paths when the harness can resolve them.

**Native Source Resolution Rules:**
- If a native source is unsupported, ambiguous, unavailable, stale, or mismatched, report distinct error outcomes to the user.
- **Never** fall back to visible model transcript generation or synthetic history. Native capture must be full-fidelity and sourced directly from native storage.

Set `interactionMode` based on runtime context:

- `interactive`: use when a user can review a prefilled confirmation form. This includes **every** slash command and chat message in a live session — even a bare `/publish-session` or a terse "just publish it, this is a demo."
- `noninteractive`: use **only** for genuinely headless, flag-invoked execution with no further chat turn possible at all (`copilot -p`, `claude --print`, `codex exec`). The explicit publish request authorizes prompt-specified values or defaults, but unresolved secret findings still block upload.

**The secret decision gate, one-shot metadata form, and non-editable recap (Phase 4) are mandatory for every interactive publication and can never be skipped, auto-approved, or inferred from the original publish request.** Do not read "explicit publish request" or "generate the metadata yourself" as license to bypass any of these code-enforced steps. If the host has no elicitation form, show each returned proposal as plain chat text and wait for the owner's reply before calling `save_session` again — that plain-text exchange **is** the mandatory step, not an optional extra.

**Never rationalize `noninteractive` from urgency, terseness, or "this is just a demo" framing.** Only the literal absence of a further chat turn (a flag-invoked headless process) justifies skipping this sequence. Publishing a session — with real content, potentially including secrets — without these owner-facing confirmations in an interactive session is a critical safety failure, not an acceptable shortcut, regardless of how the request was phrased.

## Phase 3: Full-Fidelity Capture and Client-Side Secret Scanning

Call the MCP `save_session` tool as the preferred one-step path. Use `prepare_session_capture` followed by `publish_session` only for advanced review, exact retry, or previously returned `captureId` flows.

The MCP server must:

- Read native journal events and supported dependencies without substituting a model-written transcript. Session artifacts are **always** gathered fresh; a stale or foreign `captureId` is never accepted as a shortcut to skip gathering.
- Store the original capture in an owner-only local archive (`~/.session-registry/captures`).
- Scan the gathered artifacts for secrets before transmitting anything to the hosted registry backend, and **always** report how many were found — this reporting step is code-enforced and never skipped, narrated away, or folded silently into another step.

## Phase 4: Code-Enforced Secret Decision, Metadata Form, and Recap

Once artifacts are gathered and scanned, the server drives a fixed, non-negotiable sequence in interactive mode. None of these steps can be skipped, merged, reordered, auto-approved, or inferred from the original publish request, regardless of how the agent or user phrases it:

1. **Secret decision gate.** If any scanner findings are unresolved, the owner must make one explicit choice before anything else happens:
   - Redact all detected secrets.
   - Review and approve each finding individually (a per-finding loop, one decision per finding).
   - Publish unredacted as an explicit override (never assumed, never defaulted).

   Never silently redact, ignore, or declare false positives on the owner's behalf. This decision is separate from, and always precedes, the metadata form below.

1. **One-shot metadata form.** Present exactly one confirmation form containing all five fields together, filled in exactly once with no re-presentation on edits:
   - `title` — YOU auto-generate a specific 1-120 character task title from approved conversation content; the form prefills it for owner confirmation/edits. Avoid generic placeholders such as "Saved session" or "Session export".
   - `summary` — YOU auto-generate a 1-500 character summary of objective, outcome, decisions, and verification status; the form prefills it for owner confirmation/edits.
   - `audience` — defaults to "Anyone with the link can view" unless the user specified otherwise. Preserve explicit user choices: `anyone`, `org:<github-org>`, `team:<org>/<team>`, `users:<user1>,<user2>`.
   - `expiration` — defaults to the registry's 14-day default (omit to use it). Preserve explicit user choices: `never` / `null` for no expiration, or an ISO-8601 timestamp for a custom expiration.
   - `additionalRedactions` — the owner's free-text answer to "anything else you'd like redacted that the scanner didn't flag?" (internal project names, personal names, hostnames, URLs, or other sensitive content not caught by the scanner), or an explicit statement that there is nothing more to redact. Each supplied target becomes an exact-text owner redaction applied to every scannable native source occurrence and every publication metadata occurrence.

   If the host has no elicitation form, show the returned proposal as plain chat text containing all five fields and collect the owner's answers before calling `save_session` again with the same `captureId`.

1. **Separate, non-editable recap.** After the metadata form is answered, the server always shows one more confirmation containing a plain-text recap of every prior decision (secret decision, title, summary, audience, expiration, additional redactions) with **exactly one yes/no field** and no editable content. The owner must explicitly confirm this recap before anything uploads. A "no" answer cancels cleanly without uploading; it never silently falls back to the original metadata form or an assumed default.

Unresolved detected secrets, an unanswered secret decision, an unanswered metadata form, or an unanswered recap each independently block upload. Do not read "explicit publish request" or "generate the metadata yourself" as license to bypass any of these three steps.

**Never rationalize `noninteractive` from urgency, terseness, or "this is just a demo" framing.** Only the literal absence of a further chat turn (a flag-invoked headless process) justifies skipping this sequence. Publishing a session — with real content, potentially including secrets — without these owner-facing confirmations in an interactive session is a critical safety failure, not an acceptable shortcut, regardless of how the request was phrased.

## Phase 5: Atomic Publication and Idempotent Error Handling

Invoke `save_session` or `publish_session` with the confirmed capture, metadata, policy, and finding resolutions.

If publication returns `PUBLISH_STATE_UNKNOWN`, a network timeout, or an equivalent unknown-outcome error:

- Retry with the exact same `captureId` and confirmed request values.
- Do not re-capture.
- Do not generate a replacement capture ID.
- Do not claim success until the complete public share URL is returned.

Expected share URL shape:

```text
<API-returned-web-origin>/session/<harnessSessionId>/<linkId>
```

## Phase 6: Share Output

On success, return this concise result. Every bracketed placeholder below —
`<harnessSessionId>`, `<shareUrl>`, `<linkId>`, etc. — MUST be copied
character-for-character from the tool result JSON. Do not retype,
reformat, summarize, truncate, or reconstruct these values from memory:
copy/paste each value verbatim, exactly as it appears in the JSON field of
the same name. This matters most for `shareUrl`, which is a long opaque
URL — never assemble or approximate it by combining fragments of other
IDs; always use the literal `shareUrl` string from the tool result.

```markdown
### Agent Session Published

**Title**: <title>
**Summary**: <summary>
**Harness**: <harnessName> (`<harnessSessionId>`)
**Access**: <audiencePolicy>
**Expires**: <expiresAt>

**Collaborator Share Link**: [<shareUrl>](<shareUrl>)

> Resume safety notice: Full native archive files and dependencies are available after trust-and-safety acknowledgment.
```

## Examples

Interactive publication:

```powershell
/publish-session
```

Headless one-shot publication:

```powershell
copilot -p "/publish-session publish this session for org:github"
```
