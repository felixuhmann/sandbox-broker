# Broker service image.
#
# This is the only container in the deployment that receives
# /var/run/docker.sock. It publishes no port to the host; the application
# reaches it over a private Compose network.
#
# Releases pin these bases by digest; the tags here keep local builds workable.
FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/client/package.json packages/client/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/ apps/
# `--legacy` keeps the workspace dependency as a plain copy rather than an
# injected one, which is what a self-contained runtime image needs.
RUN pnpm --filter @sandbox-broker/contracts build \
    && pnpm --filter @sandbox-broker/server build \
    && pnpm --filter @sandbox-broker/server --prod --legacy deploy /out

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The broker holds the Docker socket, so it runs as an unprivileged user and
# the group that owns the socket is supplied at run time (`--group-add`).
RUN useradd --uid 10101 --create-home --shell /usr/sbin/nologin broker

COPY --from=build --chown=10101:10101 /out /app
COPY --from=build --chown=10101:10101 /app/apps/server/dist /app/dist

USER 10101:10101
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SANDBOX_BROKER_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
