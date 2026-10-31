# docs/specs/release-0-1-0.md. One image for the API, the worker and the migrations, so the API and
# the worker always run the same version. Build it from the repository root:
#   docker build -f deploy/docker/Dockerfile -t factoree:dev .

# build: compiles src to dist, and builds the UI in ui/ when the checkout has one (DI-15.02).
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# prisma.config.ts reads FACTOREE_DATABASE_URL, the only database name Prisma needs. The Prisma CLI
# resolves it eagerly, and any value works for generate.
ENV FACTOREE_DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npx prisma generate && npm run build
RUN if [ -f ui/package.json ]; then \
      if [ -f ui/package-lock.json ]; then npm ci --prefix ui --no-audit --no-fund; fi \
      && npm run build --prefix ui; \
    fi \
    && mkdir -p ui/dist

# factoree: Node 24, the production packages, the Prisma CLI for `migrate`, git for the trusted
# checkout (git 2.38 or later, DI-14.38) and Playwright Chromium for the worker. Non-root.
FROM node:24-bookworm-slim AS factoree
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# The Prisma CLI is a dev dependency of the repository and a runtime need of `migrate`. It
# installs at the exact version of the lock file. The browser driver launches headless Chromium,
# which is the headless shell, and records video with ffmpeg. The full Chromium build is not needed.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --no-save --omit=dev --no-audit --no-fund \
         "prisma@$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")" \
    && npx playwright install --with-deps --only-shell chromium \
    && npx playwright install ffmpeg \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /root/.npm /root/.cache /var/lib/apt/lists/*
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN FACTOREE_DATABASE_URL=postgresql://build:build@localhost:5432/build \
    npx prisma generate \
    && rm -rf /root/.cache /root/.npm
COPY --from=build /src/dist ./dist
COPY --from=build /src/ui/dist ./ui/dist
COPY deploy/docker/entrypoint.sh /usr/local/bin/factoree
RUN chmod 755 /usr/local/bin/factoree

# DI-15.03 and DI-15.04. The release workflow sets these. A local build reports "dev".
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
ARG SANDBOX_IMAGE=""
ENV FACTOREE_VERSION=${VERSION} \
    FACTOREE_COMMIT=${COMMIT} \
    FACTOREE_BUILD_DATE=${BUILD_DATE} \
    FACTOREE_SANDBOX_IMAGE_DEFAULT=${SANDBOX_IMAGE}
LABEL org.opencontainers.image.title="factoree" \
      org.opencontainers.image.source="https://github.com/alternayte/factoree" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version=${VERSION} \
      org.opencontainers.image.revision=${COMMIT} \
      org.opencontainers.image.created=${BUILD_DATE}

# The node user of the base image, uid 1000. The worker writes sandboxes and evidence under /tmp.
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/factoree"]
CMD ["api"]
