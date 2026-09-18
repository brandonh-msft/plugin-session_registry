---
name: pr-publish-prompt
description: Before creating a pull/merge request on any git host, offer once to attach a PR-Ready Share Card for the current session, respecting a durable per-scope opt-out.
user-invocable: false
---

# `pr-publish-prompt` Agentic Skill

Use this skill immediately before issuing any pull/merge-request-creating tool call or shell command, on any git hosting provider. It offers to attach the current session's PR-Ready Share Card to the request being opened, and respects a developer's durable "stop asking" choice. This is the *only* place a PR/MR is ever written to as part of publishing a session, and only ever after a fresh, explicit "Yes" given in the same conversation — it is a narrowly scoped, consent-gated exception to the existing rule that the registry never auto-writes to a PR unattended, not a relaxation of it.

## When to Use

Invoke this skill immediately before, and only before, a call or command that **creates** a pull/merge request, including drafts:

- Your own `create_pull_request` tool
- GitHub MCP's `create_pull_request` / `create_pull_request_with_copilot`
- CLI invocations: `gh pr create`, `glab mr create`, `az repos pr create`, `tea pr create`, or equivalents for other hosts

Do **not** invoke this skill for read-only PR/MR operations (viewing, listing, commenting, reviewing, merging, closing) or for editing an already-existing PR/MR description outside of this flow's own fallback path (see Phase 4).

## Phase 1: Check the Preference — Always First

Before ever showing the prompt, call the `pr_publish_preference` MCP tool with `action: "check"` and the current workspace/worktree root as `workspaceRoot`.

- If `skipScope` is `"session"` or `"user"`, **do not prompt**. Proceed directly to creating the PR/MR exactly as you otherwise would, with no card.
- If `skipScope` is `"none"`, continue to Phase 2.

Never skip this check "because it was already asked earlier in this conversation" — the tool call is the source of truth, not conversational memory.

## Phase 2: The 4-Choice Prompt

Ask the developer, using `ask_user` with exactly these four choices, once per PR-creation attempt:

1. **Yes, attach a share card** (recommended)
1. **No, not this time**
1. **No, and don't ask again this session**
1. **No, and don't ask again ever**

Do not reword these into a yes/no question, and do not embed the choices in the question text — use the tool's native choices mechanism.

## Phase 3: Handling Each Answer

- **Yes, attach a share card**: Run `/publish-session` (the `publish-session` skill) if the session is not already published, or reuse its existing `linkId` if it is. Then call `get_share_card` with that `linkId`. If the result is `{ "kind": "available", markdown }`, embed `markdown` directly into the `body`/`--body` argument of the PR-creating call/command you are about to issue — append it, do not replace any body content the developer or you already drafted. If the result is `{ "kind": "unavailable" }`, tell the developer the card is not currently available (e.g. the link was revoked) and proceed with PR creation as normal, without a card. Do **not** call `pr_publish_preference` with `action: "record"` for this answer — a one-time "Yes" is not a durable preference.
- **No, not this time**: Proceed with PR creation unchanged. Do not call `record`.
- **No, and don't ask again this session**: Call `pr_publish_preference` with `action: "record"`, `scope: "session"`, then proceed with PR creation unchanged.
- **No, and don't ask again ever**: Call `pr_publish_preference` with `action: "record"`, `scope: "user"`, then proceed with PR creation unchanged.

In every case, the PR/MR is still created — this skill only ever adds a card to a request the developer is already asking you to open; it never blocks or delays PR creation on its own account.

## Phase 4: Fallback — a PR Already Exists Without This Flow Having Run

If you are asked to describe or add a card to a PR/MR that already exists (for example, a human created it directly, or an earlier session created it before this skill existed), this flow's normal embed-in-initial-body path does not apply. Instead:

1. Still perform Phase 1's `check` and, if `skipScope` is `"none"`, Phase 2's prompt — the same consent gate applies to an edit as to a creation.
1. On "Yes", get the card via `get_share_card` and apply it using the host's existing description-update mechanism: `update_pull_request` (GitHub), `gh pr edit --body`, `glab mr update --description`, `az repos pr update --description`, `tea pr edit --description`, or the equivalent for the host in use.

No new tool is introduced for this fallback; it reuses whichever update-description mechanism already exists for that host.

## Notes on Scope

- This skill never introduces a host-specific hook; the check happens because you, the agent, always compose the PR-creating call yourself.
- This skill never accepts or implies a bulk/explicit-id-list variant — it is a single per-attempt prompt.
- See `docs/brainstorms/2026-09-18-pr-publish-prompt-requirements.md` and `docs/plans/2026-09-18-001-feat-pr-publish-prompt-plan.md` in the backing repository for the full requirements trace and the governance rationale for why this consent-gated flow is allowed.
