---
name: publish-session
description: Publish current Copilot, Claude, or Codex CLI sessions, or VS Code chats.
---

# Publish a native session

Use for `/publish-session` or explicit sharing, not local-capture-only requests.

For every live chat or slash command use `interactionMode: "interactive"`.
Never skip secret decisions or the metadata form.

## Transport Contract - Resolve the host tool first

Use the host's **exact callable identifier and schema**. Do not invent a prefix.
Use host tool search/deferred-tool loader for `session-registry` + `save_session`
(often callable `session-registry-save_session`), not MCP resource discovery:
`resources/list`, `list_mcp_resources`, or `session-registry.list_mcp_resources`.
An `unsupported call` is not evidence that the server is disconnected.
Resolve again or report routing failure; claim disconnection only on host evidence.

The MCP tools are the only interface. Do not read the plugin's own files, run a
package manager or build step, start the server, or write your own MCP client.
Never replace native capture or owner-facing forms.

## Capture and publish

1. Resolve every operation below using the host-routing rule.
1. Identify the harness: `github-copilot-cli`, `claude-code`, or `codex-cli`.
   VS Code Copilot Chat: `vscode-copilot-chat`, no selector; the host
   supplies identity.
   Publish only the current session. Copilot uses its profile-guarded runtime
   ID; supported Codex calls carry a verified thread ID. Explicit selectors
   cannot override active identity. Claude's plugin hook supplies current
   ID/path from each matching MCP invocation; the server checks the ID in
   Claude's native journal. Without a host ID, pass absolute `workingDirectory`
   and a `verificationWindow` of 3-6 ordered, verbatim `{role, text}` turns
   (32 KiB max): two distinct user turns and one assistant turn.
   `recentUserMessage` must be the final user turn. Match the whole window
   exactly to the newest native turns. Don't use old excerpts, summaries, tool
   output, or candidate journals. Join text blocks with newlines. Never ask for
   IDs or paths.
1. Call `save_session` with harness, interaction mode, source selector, and drafted
   title (1-120 characters) and summary (1-500 characters). Honor owner metadata.
   The server rescans edits and truncates only metadata. Every invocation is a fresh publication:
   describe the substantive task, outcome, and decisions. Never title or summarize the slash command, publication request/process,
   prior receipt, or share link.
   `prepare_session_capture` is for local capture only, with the interactive
   **Codex App** exception; never a bypass of
   `save_session` for `github-copilot-cli`, `claude-code`, or Codex CLI.
1. Preserve requested access and expiry. Otherwise default to anyone with the link
   (`audiencePolicy: {accessMode: "anonymous"}` or omit it) and 14 days (omit `expiresAt`).
   `expiresAt: null` means never expire. Never invent recipients or downgrade
   restricted access.
1. Let the server capture, scan, drive owner decisions, and upload only approved
   native content. Report the finding count.

## Owner-facing forms

For Codex CLI, GHCP, and Claude, **the server renders every form in this phase itself**
through host elicitation. Do not pre-answer, recreate, merge, or replace its forms with chat questions.
Never bundle fields into a single run-on prompt.

1. **Secret decision gate**, when findings exist: the owner chooses bulk redaction,
   individual review, or explicit unredacted override. Individual review offers
   redact, keep, or custom replacement.
   Never decide findings, redactions, or overrides on the owner's behalf.
1. **One-shot metadata form**: title, summary, audience, expiration, and optional
   `additionalRedactions`, prefilled for confirmation/edits. Each target becomes
   an exact-text rule applied to native content and metadata. In GHCP and Claude,
   accepting this completed form is final approval and publication proceeds
   without another confirmation UI.
1. **Codex CLI only**: after its sequential metadata questions, show the
   separate, non-editable recap and require native Accept before upload.

For interactive Codex App or a no-elicitation proposal, show these fields and wait:

```markdown
**Title**: <prefilled title>
**Summary**: <prefilled summary>
**Audience**: <prefilled audience>
**Expiration**: <prefilled expiration>
**Additional redactions** (optional, blank means none): <prefilled value>
```

Never compress these into one paragraph or question. Resolve findings first; rendering
never skips the secret gate. For GHCP or Claude, the reply is final approval: retry
`save_session` with the returned request and edits. For Codex, show the non-editable recap
and wait again. Only its explicit publish response authorizes `publish_session` with that
`captureId`, confirmed values, resolutions, `confirmed: true`, and
`additionalRedactionsConfirmed: true` when findings existed.

`noninteractive` is only for headless invocations with no further chat possible
(`copilot -p`, `claude --print`, `codex exec`). There the publish request authorizes
supplied/default settings and the native-package warning; unresolved secrets still block.
Urgency, "just publish it", or a demo never authorize headless mode in live chat.

## Errors and retries

- **Routing failure:** use host tool search, not resource discovery or environment probing.
- **Ambiguous, unsupported, missing, stale, or mismatched native source:** report
  the precise server error. Never substitute another session or synthetic history.
- **`CURRENT_SESSION_EVIDENCE_REQUIRED` / `CURRENT_SESSION_NOT_VERIFIED`:**
  retry with the newest complete turns from current context. The server retries
  write delays. If verification still fails, report the limitation. Never invent
  turns, request historical IDs/paths, or redirect to a native publisher.
- **`MISSING_DEPENDENCY`:** a referenced file is missing. Use
  `dependencyMappings` only for an owner-supplied relocated historical copy;
  existing references are captured automatically. Never search or substitute.
- **`UNSUPPORTED_DEPENDENCY`:** the host dependency format cannot be decoded.
  Report the error; do not retry it as file authorization.
- **Security findings:** keep the capture, collect explicit owner decisions, and
  regenerate metadata only from approved content. Do not suppress scan failures.
- **Unmatched owner redactions:** do not block publication; check the applied-redaction count.
- **`confirmation-timeout`:** report the expired form and stop. This attempt
  uploaded nothing. Use its `retryRequest` only when the owner asks to resume;
  re-collect required approvals. Never auto-answer or switch to noninteractive.
- **Transport timeout without a server-issued `retryRequest`:** stop; the first
  handler may still be running. Never start another save or invent a publish
  request. Report the unknown outcome; do not claim nothing was uploaded.
- **`PUBLISH_STATE_UNKNOWN` or unknown network outcome:** retry the exact
  returned request with the same `captureId` and confirmed values. Never recapture
  or generate a replacement ID. Claim success only when the full share URL is returned.
  When automatic CLI identity is unavailable, refresh only `currentSession`
  evidence from the current conversation. Do not reuse stale evidence after
  switching sessions; resume the original session for a necessary retry.

## Share output

Relay the complete server-authored publication receipt unchanged. Copy the
raw API `shareUrl` exactly. Never reconstruct, normalize, shorten, substitute,
rehost, or omit it. Keep it available for copying. Don't publish again or fetch
a share card to verify it. The server controls its MCP result, not the final
assistant response; don't claim host rendering is guaranteed.
