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

## Transport Contract — Read This First

**The `session-registry` MCP tools are the only interface to this workflow.** Everything below describes behavior you invoke through those tools, never behavior you reimplement.

You **must not**, at any point in this skill:

- Read, open, list, or search the plugin's own files — its manifests, skills, scripts, or any source code. The published plugin ships a prebuilt server; there is nothing in it for you to inspect, and inspecting it tells you nothing the tools do not.
- Run a package manager or build step (`npm`, `pnpm`, `yarn`, `npx`, `tsc`, or any install/compile command) for any reason. The server requires no install and no build.
- Start, spawn, or connect to the MCP server yourself, or write your own MCP client, script, or JSON-RPC harness to call it. The host owns the connection.
- Substitute your own implementation of capture, scanning, metadata drafting, or publication for a tool call.

A hand-rolled client cannot advertise the host's elicitation capability, so it silently disables every owner-facing form this workflow depends on. That is precisely how an interactive publication degrades into an unreviewed one.

**Tools may load lazily.** Hosts are permitted to surface MCP tools on first use rather than at startup. If you do not see `save_session` listed yet, call it anyway — absence from a listing is not evidence that the server is missing.

### When the tools are genuinely unavailable

If calling `save_session` fails because the tool does not exist (not a tool error — the tool itself is unresolvable), **stop immediately.** Do not investigate, diagnose, probe the environment, or attempt any workaround. Report exactly this to the user and end the turn:

> The `session-registry` MCP server is not connected in this host, so I can't publish the session. Please verify the plugin is installed and the server is configured, then restart the host and run `/publish-session` again.

Publishing is not possible without the server, and no local substitute is acceptable.

## Supported Hosts

| Host | Skill Discovery | Owner-facing forms |
| --- | --- | --- |
| **GitHub Copilot CLI** | Automatic | Elicitation forms |
| **Claude Code** | Automatic | Elicitation forms |
| **Codex CLI** | Automatic | Elicitation forms |
| **VS Code / Copilot App** *(Projection only)* | Non-blocking | Host-dependent |

*Note: VS Code Agent Plugins and GitHub Copilot App are non-blocking projection targets. Installation or discovery does not by itself establish native session-capture support.*

Host installation, Node runtime, and MCP server configuration are the host's responsibility and are already settled by the time this skill runs. They are not yours to verify, repair, or work around.

## Execution Protocol

Run the workflow in these deterministic phases:

1. Context detection: identify the native harness, session source, and interaction mode.
2. Capture and scan: call the capture tool, which creates a full-fidelity native capture and scans it locally before upload.
3. Owner decisions: the server drives the secret decision gate, the one-shot metadata form, and the recap.
4. Atomic publication: complete the publication through the same tool with idempotent retry handling.
5. Share output: return the collaborator-facing share URL and safety notice.

There is no pre-flight phase. Begin at context detection and let the tools report any problem they encounter.

## What the server handles for you

You do not verify, configure, or troubleshoot any of the following — the server owns them and reports failures through tool errors:

- **Registry origin.** `SESSION_REGISTRY_API_URL` is host configuration. The server enforces HTTPS for non-loopback origins and rejects redirects.
- **Publisher credential.** No credential is needed to start. Your first publish is admitted without one, and the registry issues a publisher token as part of it. The server stores that token under the user's own credential file with user-only permissions and sends it on later requests. That token is the publisher identity, and the registry keeps only a hash of it, so a lost credential file cannot be recovered or reissued.
- **GitHub authorization.** A GitHub token is requested on demand only when the owner restricts a session's audience to GitHub users, teams, or organizations. It is used for that single request and never stored. Publishing without restrictions never requests one.

If any of these is misconfigured, the tool call fails with a specific error. Relay that error to the owner; do not go looking for the cause yourself.


## Phase 1: Native Session Identification and Context Detection

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

**The secret decision gate, one-shot metadata form, and non-editable recap (Phase 3) are mandatory for every interactive publication and can never be skipped, auto-approved, or inferred from the original publish request.** Do not read "explicit publish request" or "generate the metadata yourself" as license to bypass any of these code-enforced steps. The server renders these forms itself through the host's elicitation capability; you never build, restate, or stand in for them.

**Never rationalize `noninteractive` from urgency, terseness, or "this is just a demo" framing.** Only the literal absence of a further chat turn (a flag-invoked headless process) justifies skipping this sequence. Publishing a session — with real content, potentially including secrets — without these owner-facing confirmations in an interactive session is a critical safety failure, not an acceptable shortcut, regardless of how the request was phrased.

## Phase 2: Full-Fidelity Capture and Client-Side Secret Scanning

Call the MCP `save_session` tool as the preferred one-step path. Use `prepare_session_capture` followed by `publish_session` only for advanced review, exact retry, or previously returned `captureId` flows.

The MCP server must:

- Read native journal events and supported dependencies without substituting a model-written transcript. Session artifacts are **always** gathered fresh; a stale or foreign `captureId` is never accepted as a shortcut to skip gathering.
- Store the original capture in an owner-only local archive (`~/.session-registry/captures`).
- Scan the gathered artifacts for secrets before transmitting anything to the hosted registry backend, and **always** report how many were found — this reporting step is code-enforced and never skipped, narrated away, or folded silently into another step.

**Dependency-path authorization (`UNSUPPORTED_DEPENDENCY` / `MISSING_DEPENDENCY`).** A native capture may reference output files (attachments, generated artifacts, resumable state) that live outside the session's own directory. Reading any such file requires the owner-authorized `dependencyPaths` (or a `dependencyMappings` entry if the file has moved). Do not guess these paths or search the filesystem speculatively. If `save_session` or `prepare_session_capture` returns `UNSUPPORTED_DEPENDENCY`/`MISSING_DEPENDENCY`, the error lists every needed reference in **two distinct forms that are not interchangeable**: a resolved absolute path, and — only when it differs — the exact quoted raw recorded reference text. Use the resolved absolute path verbatim as a `dependencyPaths` entry when the file is still at that location. Use the quoted raw reference text verbatim (never the resolved path) as the `dependencyMappings[].sourcePath` key only when the file has moved, paired with the file's current absolute location as `localPath`. Retry immediately using the same `captureId`, rather than iterating one path at a time, exploring the filesystem, or guessing which of the two values goes in which field.

## Phase 3: Code-Enforced Secret Decision, Metadata Form, and Recap

Once artifacts are gathered and scanned, the server drives a fixed, non-negotiable sequence in interactive mode. **The server renders every form in this phase itself, through the host's elicitation capability.** Your only job is to call the tool and pass the owner's answers back. None of these steps can be skipped, merged, reordered, auto-approved, or inferred from the original publish request, regardless of how the agent or user phrases it.

Never collapse these forms into a chat question of your own, and never bundle fields into a single run-on prompt. A form you compose is not the form the owner is entitled to: it loses the prefilled values, the masked finding previews, the field labels, and the per-field editing the server provides.

1. **Secret decision gate.** If any scanner findings are unresolved, the owner must make one explicit choice before anything else happens. The bulk-decision form itself always lists a capped preview of the detected findings (category, location, and a masked partial preview of each value) so this choice is never made blind, even for large finding sets:
   - Redact all detected secrets.
   - Review and approve each finding individually (a per-finding loop, one decision per finding).
   - Publish unredacted as an explicit override (never assumed, never defaulted).

   Never silently redact, ignore, or declare false positives on the owner's behalf. This decision is separate from, and always precedes, the metadata form below.

   **Per-finding review detail.** Each step of the "review and approve individually" loop shows the finding's category, severity, location, and a masked partial preview of the detected value (e.g. `ghp_****************************abcd` plus its character count) — enough to recognize the finding, never enough to reconstruct it. The owner then chooses exactly one of three options:
   - Redact with the standard `[REDACTED]` placeholder.
   - Keep the finding unredacted (an explicit owner override for that one finding).
   - Redact with owner-supplied custom replacement text — choosing this immediately opens one follow-up form asking for that exact replacement text, then continues to the next finding. Blank replacement text is rejected and re-asked rather than silently falling back to `[REDACTED]`.

1. **One-shot metadata form.** Present exactly one confirmation form containing all five fields together, filled in exactly once with no re-presentation on edits. `additionalRedactions` is the only optional field — the owner may leave it blank to mean "nothing else to redact":
   - `title` — YOU auto-generate a specific 1-120 character task title from approved conversation content; the form prefills it for owner confirmation/edits. Avoid generic placeholders such as "Saved session" or "Session export".
   - `summary` — YOU auto-generate a 1-500 character summary of objective, outcome, decisions, and verification status; the form prefills it for owner confirmation/edits.
   - If the drafted `title` or `summary` exceeds the registry's true 120/500 character limit, the server truncates it automatically with a trailing `...` marker and notes that truncation in the metadata form / recap instead of hard-rejecting the save.
   - `audience` — defaults to "Anyone with the link can view" unless the user specified otherwise. Preserve explicit user choices: `anyone`, `org:<github-org>`, `team:<org>/<team>`, `users:<user1>,<user2>`.
   - `expiration` — defaults to the registry's 14-day default (omit to use it). Preserve explicit user choices: `never` / `null` for no expiration, or an ISO-8601 timestamp for a custom expiration.
   - `additionalRedactions` — the owner's free-text answer to "anything else you'd like redacted that the scanner didn't flag?" (internal project names, personal names, hostnames, URLs, or other sensitive content not caught by the scanner). This field is optional: leaving it blank means "nothing else to redact" and is accepted without further confirmation. Each supplied target becomes an exact-text owner redaction applied to every scannable native source occurrence and every publication metadata occurrence.

   **If — and only if — the host advertises no elicitation capability at all**, the server returns the proposal to you instead of rendering it. The three quality-gated hosts (GitHub Copilot CLI, Claude Code, Codex CLI) all support forms, so reaching this path in one of them means something is wrong, not that the fallback applies. In that genuine no-form case, present the proposal as a labeled block with each of the five fields on its own line, followed by its prefilled value, and wait for the owner's reply before calling `save_session` again with the same `captureId`:

   ```markdown
   **Title**: <prefilled title>
   **Summary**: <prefilled summary>
   **Audience**: <prefilled audience>
   **Expiration**: <prefilled expiration>
   **Additional redactions** (optional, blank means none): <prefilled value, if any>
   ```

   Never compress these into a single paragraph or a one-line question.

1. **Separate, non-editable recap.** After the metadata form is answered, the server always shows one more confirmation containing a plain-text recap of every prior decision (secret decision, title, summary, audience, expiration, additional redactions) with **exactly one yes/no field** and no editable content. The owner must explicitly confirm this recap before anything uploads. A "no" answer cancels cleanly without uploading; it never silently falls back to the original metadata form or an assumed default.

Unresolved detected secrets, an unanswered secret decision, an unanswered metadata form, or an unanswered recap each independently block upload. Do not read "explicit publish request" or "generate the metadata yourself" as license to bypass any of these three steps.

**Never rationalize `noninteractive` from urgency, terseness, or "this is just a demo" framing.** Only the literal absence of a further chat turn (a flag-invoked headless process) justifies skipping this sequence. Publishing a session — with real content, potentially including secrets — without these owner-facing confirmations in an interactive session is a critical safety failure, not an acceptable shortcut, regardless of how the request was phrased.

## Phase 4: Atomic Publication and Idempotent Error Handling

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

## Phase 5: Share Output

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
