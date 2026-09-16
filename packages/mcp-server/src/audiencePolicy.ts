import { z } from "zod";
import type { AudiencePolicy, AudienceRule } from "@session-registry/core";

export const audiencePolicySchema = z.discriminatedUnion("accessMode", [
  z.object({ accessMode: z.literal("anonymous") }),
  z.object({
    accessMode: z.literal("authenticated"),
    rules: z.array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("specific-users"),
          githubLogins: z.array(z.string().trim().min(1)).min(1),
        }),
        z.object({
          type: z.literal("organization"),
          githubOrg: z.string().trim().min(1),
        }),
        z.object({
          type: z.literal("repo-collaborators"),
          repoOwner: z.string().trim().min(1),
          repoName: z.string().trim().min(1),
          minPermission: z.enum(["read", "triage", "write", "maintain", "admin"]),
        }),
        z.object({
          type: z.literal("team"),
          githubOrg: z.string().trim().min(1),
          teamSlug: z.string().trim().min(1),
        }),
      ]),
    ).min(1),
  }),
]).default({ accessMode: "anonymous" });

export const AUDIENCE_INPUT_GUIDANCE =
  "Use anyone, users:alice,bob, org:github, team:org/team, or repo:owner/name:read. Separate multiple restricted rules with semicolons.";

export function audienceText(policy: AudiencePolicy): string {
  if (policy.accessMode === "anonymous") return "anyone";
  return policy.rules.map((rule) => {
    switch (rule.type) {
      case "specific-users": return `users:${rule.githubLogins.join(",")}`;
      case "organization": return `org:${rule.githubOrg}`;
      case "team": return `team:${rule.githubOrg}/${rule.teamSlug}`;
      case "repo-collaborators": return `repo:${rule.repoOwner}/${rule.repoName}:${rule.minPermission}`;
    }
  }).join("; ");
}

export function parseAudienceText(value: string): AudiencePolicy {
  if (value.trim().toLowerCase() === "anyone") return { accessMode: "anonymous" };
  const invalid = () => new Error(`Invalid audience. ${AUDIENCE_INPUT_GUIDANCE}`);
  const rules = value.split(";").map((part): AudienceRule => {
    const [kind, target, permission, ...extra] = part.trim().split(":");
    if (!target?.trim() || extra.length > 0) throw invalid();
    if (kind === "users" && permission === undefined) {
      const githubLogins = target.split(",").map((login) => login.trim());
      if (!githubLogins.every((login) => /^[A-Za-z0-9_-]+$/.test(login))) throw invalid();
      return { type: "specific-users", githubLogins };
    }
    if (kind === "org" && permission === undefined && /^[A-Za-z0-9_-]+$/.test(target)) {
      return { type: "organization", githubOrg: target };
    }
    const match = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(target);
    if (!match) throw invalid();
    if (kind === "team" && permission === undefined) {
      return { type: "team", githubOrg: match[1]!, teamSlug: match[2]! };
    }
    if (kind === "repo") {
      const parsed = audiencePolicySchema.safeParse({ accessMode: "authenticated", rules: [{
        type: "repo-collaborators", repoOwner: match[1], repoName: match[2], minPermission: permission ?? "read",
      }] });
      if (parsed.success && parsed.data.accessMode === "authenticated") return parsed.data.rules[0]!;
    }
    throw invalid();
  });
  return audiencePolicySchema.parse({ accessMode: "authenticated", rules });
}
