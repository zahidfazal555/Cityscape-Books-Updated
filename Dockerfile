# Production image for Cityscape Books (ENGINEERING-STANDARDS §5): one Next.js app; migrations and
# scheduled jobs run from the same image with a different command (docs/GO-LIVE.md).
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/services/package.json packages/services/
# Behind a TLS-inspecting proxy, pass its CA as a build secret: --secret id=ca,src=ca.pem
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @csd/web build

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate 2>/dev/null || true
RUN mkdir -p /data/attachments && chown node:node /data/attachments
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
# Bill and site photos live here; mount a persistent, backed-up volume (RUNBOOKS "Bill photos").
ENV ATTACHMENT_DIR=/data/attachments
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@csd/web", "start", "--", "-p", "3000"]
