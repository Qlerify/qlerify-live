import { api } from "./api.ts"
import type { AdminData } from "./types.ts"

// A handful of current Claude models the org can pin (empty = platform default).
// Keep IDs exact — they're validated against the Anthropic API on save.
export const ANTHROPIC_MODELS: [string, string][] = [
  ["", "Platform default"],
  ["claude-opus-4-8", "Claude Opus 4.8 — most capable Opus"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 — balanced (default)"],
  ["claude-haiku-4-5", "Claude Haiku 4.5 — fastest / cheapest"],
  ["claude-fable-5", "Claude Fable 5 — most powerful"],
]

// Suggestions only (free text allowed) — what an AWS account actually has
// enabled varies; the config is validated against Bedrock on save anyway.
export const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-south-1",
  "sa-east-1",
]

export const BEDROCK_MODEL_SUGGESTIONS = [
  "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-opus-4-5-20251101-v1:0",
]

export const ADMIN_TABS: [string, string][] = [
  ["general", "General"],
  ["members", "Members"],
  ["roles", "Roles"],
  ["markings", "Markings"],
  ["environments", "Environments"],
  ["workspaces", "Workspaces"],
  ["workflows", "Workflows"],
  ["audit", "Audit log"],
]

export const loadAdmin = async (tab: string, orgId?: string | null): Promise<AdminData> => {
  const [members, roles, markings, environments, workspaces, workflows, audit, anthropic, qlerify] =
    await Promise.all([
      api("/v1/members").catch(() => []),
      api("/v1/role-assignments").catch(() => []),
      api("/v1/markings").catch(() => []),
      api("/v1/environments").catch(() => []),
      api("/v1/workspaces").catch(() => []),
      api("/v1/workflows").catch(() => []),
      api("/v1/audit?limit=60").catch(() => []),
      orgId ? api(`/v1/organizations/${encodeURIComponent(orgId)}/anthropic-config`).catch(() => null) : null,
      orgId ? api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`).catch(() => null) : null,
    ])

  return {
    tab,
    members,
    roles,
    markings,
    environments,
    workspaces,
    workflows,
    audit,
    anthropic,
    qlerify,
  } as AdminData
}
