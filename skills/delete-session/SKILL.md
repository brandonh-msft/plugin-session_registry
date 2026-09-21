---
name: delete-session
description: Soft-delete (tombstone) a previously published Session Registry session by its published sessionId, so it stops resolving for viewers while remaining recoverable.
---

# `delete-session` Agentic Skill

Use this skill to tombstone one previously published session so its share
link and download stop resolving for collaborators. This is a **soft**
delete: the session's row and stored content are preserved, and the
tombstone can later be undone (via the registry's restore capability) or
made permanent (via `purge-session`/`purge-sessions`). Deleting is not the
same as purging — never conflate the two when talking to the user.

## Transport Contract

The `session-registry` MCP tools are the only interface to this workflow. Do not read the plugin's own files, run a package manager or build step, start the MCP server yourself, or write your own MCP client.

Operation names below are not necessarily callable host identifiers. Use the exact callable identifier and schema exposed by the host. Tools may load lazily: use the host's tool search/deferred-tool loader for `session-registry` and the required operation before calling a deferred tool. Host-native tool discovery is not MCP resource discovery; do not call `resources/list`, `list_mcp_resources`, `session-registry.list_mcp_resources`, or any invented discovery operation on this server. If the host namespaces server tools, the callable commonly looks like `session-registry-delete_session`; load/search and invoke the exact exposed identifier. Do not invent a tool name or prefix or call a bare operation unless that identifier is exposed. An `unsupported call` is not evidence that the server is disconnected; resolve the actual identifier before retrying. If discovery cannot expose it, stop and report that the tool cannot be resolved in this turn, including the actual routing error. Claim disconnection only if the host explicitly reports it. Host-native tool discovery is allowed; replacement clients are not. Relay resolved tool errors as tool errors.

## When to Use

Invoke this skill when a user:

- Types `/delete-session`
- Asks to "delete my published session", "unpublish this session", "take
  this session down", or "stop sharing this session"

Do not invoke `purge-session` or `purge-sessions` in response to these
phrases — those are separate, irreversible operations.

## `sessionId` Disambiguation (read this first)

`delete_session` takes exactly one input: `sessionId`, the **opaque id
returned by the original `publish_session` or `save_session` tool result**
(the JSON field literally named `sessionId`). This is **not**:

- `harnessSessionId` — the native harness's own session identifier
  (e.g. `COPILOT_AGENT_SESSION_ID`), also present in that same result.
- The `linkId` segment embedded in the collaborator share URL
  (`.../session/<harnessSessionId>/<linkId>`).

If the user only has a share URL or remembers the harness session id, do
not guess or substitute one of those other values as `sessionId`. Instead:

- If the original `publish_session`/`save_session` tool result is still
  visible earlier in this conversation, read the true `sessionId` from it.
- Otherwise, ask the user to paste the `sessionId` value from that original
  publish result (not the share URL, and not the harness session id).

## Execution Protocol

1. Resolve the true `sessionId` per the disambiguation rule above. Do not
   call the tool with a guessed or substituted id.
2. Call `delete_session` with `{ sessionId }`.
3. Report the result plainly, distinguishing the two possible outcomes:
   - `outcome: "deleted"` — the session is now tombstoned; its share link
     and download will stop resolving for viewers.
   - `outcome: "already_tombstoned"` — no-op; the session was already
     deleted. State this rather than implying a fresh delete happened.
4. Remind the user, briefly, that this is reversible and does not free
   storage — a permanent purge is a separate, deliberate action
   (`/purge-session` or `/purge-sessions`), not an automatic follow-up.

## Safety Rules

- Ownership is enforced entirely server-side from the caller's configured
  bearer token; never ask the user to prove ownership some other way, and
  never attempt to delete a session on another user's behalf by supplying
  a different credential.
- If the tool reports the session was not found or not owned by the
  caller, say so plainly — do not retry with a different guessed
  `sessionId`.
- Never describe this action as permanent, irreversible, or as freeing
  storage/blob space — that is `purge-session`/`purge-sessions`, not this
  tool.

## Examples

```powershell
/delete-session
```

```text
User: delete the session I published earlier, sessionId sess_3f9c1e2a-...
```
