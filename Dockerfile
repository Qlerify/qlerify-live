# Image for qlerify-live (feat/ontology-model-integration).
# Runs the app UNDER tsx (not compiled): the ontology kernel, pack loader, and
# codegen resolve paths relative to src/ and the pack loader dynamically imports
# .ts files — both of which break once compiled to dist/. tsx runs the TS
# sources directly, so no `npm run build` step (and WIP type errors don't block
# the deploy). Fly builds this remotely; no local Docker required.
FROM node:24-slim

# OpenSSL is required by Prisma's query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all deps (incl. dev) — tsx and the Prisma CLI are needed at runtime.
COPY package.json package-lock.json ./
RUN npm ci

# App sources, then generate the Prisma client (no TS compile — tsx runs src/).
COPY . .
RUN npx prisma generate

# Production mode is intrinsic to the image, not just the Fly runtime [env]: this
# is the security boundary that DISABLES the forgeable raw-subject / X-Identity
# auth shim (src/platform/authn — in prod only a real session token authenticates).
# MUST stay AFTER `npm ci` above, or npm would skip the devDeps (tsx, prisma CLI)
# this image runs on. Prisma generate / db push / tsx are all NODE_ENV-agnostic.
ENV NODE_ENV=production

EXPOSE 3001

# Entrypoint puts .qlerify + the SQLite db on the volume, applies the schema,
# seeds reference data, then starts the server via tsx.
RUN chmod +x /app/docker-entrypoint.sh
CMD ["/app/docker-entrypoint.sh"]
