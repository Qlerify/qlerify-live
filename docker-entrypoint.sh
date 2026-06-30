#!/bin/sh
# Runs on every boot — multi-tenant platform (main).
#
# Volume state on /data:
#   dev.db            — SQLite DB (platform control plane + per-tenant projection tables)
#   qlerify/          — runtime model-snapshot cache (no committed model ships in the repo)
#   .platform-schema  — sentinel marking the one-time switch to the platform schema
set -e

# One-time switch to the platform schema. The previous deploy's volume holds a
# pre-platform DB + model cache that are incompatible with main, so wipe them ONCE
# (guarded by the sentinel). Tenant data created afterwards survives later boots.
if [ ! -f /data/.platform-schema ]; then
  echo "[entrypoint] first platform boot — clearing pre-platform volume state"
  rm -f /data/dev.db /data/dev.db-journal
  rm -rf /data/qlerify
fi

# .qlerify is a runtime scratch dir; keep it on the volume and symlink to it.
mkdir -p /data/qlerify
rm -rf /app/.qlerify
ln -s /data/qlerify /app/.qlerify

# ~/.claude.json for the Qlerify MCP (no-op without a key). Only the KEY is
# required — the endpoint URL defaults to the hosted Qlerify Modeller; set
# QLERIFY_MCP_URL only to point at a white-labelled deployment.
if [ -n "$QLERIFY_MCP_API_KEY" ]; then
  export QLERIFY_MCP_URL="${QLERIFY_MCP_URL:-https://mcp.qlerify.com}"
  echo "[entrypoint] writing ~/.claude.json with Qlerify MCP creds (url=$QLERIFY_MCP_URL)"
  node -e 'const fs=require("fs"),os=require("os");fs.writeFileSync(os.homedir()+"/.claude.json",JSON.stringify({mcpServers:{qlerify:{url:process.env.QLERIFY_MCP_URL,headers:{"x-api-key":process.env.QLERIFY_MCP_API_KEY}}}}))'
fi

echo "[entrypoint] DATABASE_URL=$DATABASE_URL"
# Apply the base schema only when it actually changes (tracked by a hash on the
# volume), so normal restarts never touch the app-managed projection tables.
#   - fresh DB            → create the schema.
#   - schema changed      → additive `db push` (adds new nullable columns, keeps
#                           data). If extra app-managed projection tables block it,
#                           retry with --accept-data-loss: that drops only those
#                           rebuildable tables — orgs, models, identities, settings
#                           (all real schema tables) are preserved.
#   - schema unchanged    → skip (preserve everything).
SCHEMA_HASH=$(sha256sum prisma/schema.prisma | awk '{print $1}')
if [ ! -f /data/dev.db ]; then
  echo "[entrypoint] fresh DB — creating platform schema"
  npx prisma db push --skip-generate
  echo "$SCHEMA_HASH" > /data/.schema-hash
elif [ "$SCHEMA_HASH" != "$(cat /data/.schema-hash 2>/dev/null || true)" ]; then
  echo "[entrypoint] schema changed — applying (data preserved; rebuildable projections may reset)"
  npx prisma db push --skip-generate || npx prisma db push --skip-generate --accept-data-loss
  echo "$SCHEMA_HASH" > /data/.schema-hash
else
  echo "[entrypoint] schema unchanged — skipping prisma db push"
fi
touch /data/.platform-schema

# seedPlatform() (built-in roles + the superuser) runs inside the server at boot.
echo "[entrypoint] starting server (tsx)"
exec npx tsx src/server.ts
