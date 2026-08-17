FROM public.ecr.aws/docker/library/node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder

COPY packages/shared/ packages/shared/
COPY packages/config/ packages/config/
COPY apps/server/ apps/server/

RUN pnpm --filter @loomic/shared build
RUN pnpm --filter @loomic/config build
RUN pnpm --filter @loomic/server build
RUN pnpm --filter @loomic/server deploy --prod --legacy /opt/server

FROM public.ecr.aws/docker/library/node:22-slim AS production

ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV SERVICE_MODE=api
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install --no-cache-dir --break-system-packages pillow reportlab && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/server/node_modules ./node_modules
COPY --from=builder /workspace/apps/server/package.json ./package.json
COPY --from=builder /workspace/apps/server/dist ./dist
COPY skills/ /opt/loomic/skills/

RUN mkdir -p /app/credentials && chown -R node:node /app /opt/loomic/skills
USER node

EXPOSE 3001

CMD ["sh", "-c", "if [ -n \"$GOOGLE_SERVICE_ACCOUNT_JSON\" ]; then printf '%s' \"$GOOGLE_SERVICE_ACCOUNT_JSON\" > /app/credentials/vertex-ai-service-account.json && export GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/vertex-ai-service-account.json; fi; if [ \"$SERVICE_MODE\" = \"worker\" ]; then exec node dist/worker.js; else exec node dist/server.js; fi"]
