# docs/specs/kiln-sandbox-provider.md. The Factoree sandbox image. Every Kiln sandbox starts from it.
# The runner CLIs and the browser tools live root-owned in /opt/factoree, so an agent, which runs
# as the user `agent`, cannot replace them (B-2). A change here reaches a run only through a
# reviewed commit, a CI build and a new KILN_IMAGE digest.
FROM node:24-bookworm-slim

ARG OPENCODE_VERSION=1.19.5
ARG AGENT_BROWSER_VERSION=0.37.1
ARG PUPPETEER_BROWSERS_VERSION=3.2.6

# git for the checkouts, iproute2 and procps for the preview port check, unzip for the browser
# download, and the shared libraries and fonts chrome-headless-shell needs for a screenshot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git iproute2 procps unzip \
      fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

# The install scripts run by hand, because a later npm runs none. Each package ships its Linux
# binary, so its script only links it.
RUN npm install -g --prefix /opt/factoree --ignore-scripts --no-audit --no-fund \
      "opencode-ai@${OPENCODE_VERSION}" "agent-browser@${AGENT_BROWSER_VERSION}" \
 && (cd /opt/factoree/lib/node_modules/opencode-ai && node postinstall.mjs) \
 && (cd /opt/factoree/lib/node_modules/agent-browser && node scripts/postinstall.js) \
 && npx -y "@puppeteer/browsers@${PUPPETEER_BROWSERS_VERSION}" install chrome-headless-shell@stable --path /opt/factoree/browser \
 && shell="$(find /opt/factoree/browser -type f -name chrome-headless-shell | head -n 1)" \
 && test -n "$shell" \
 && rm -f /opt/factoree/bin/agent-browser \
 && printf '#!/bin/sh\nexport AGENT_BROWSER_EXECUTABLE_PATH="%s"\nexec node /opt/factoree/lib/node_modules/agent-browser/bin/agent-browser.js "$@"\n' "$shell" > /opt/factoree/bin/agent-browser \
 && chmod 755 /opt/factoree/bin/agent-browser \
 && chown -R root:root /opt/factoree \
 && chmod -R go-w /opt/factoree \
 && rm -rf /root/.npm

# Kiln runs every command as this user. Its home holds the workspace and the agent state.
RUN useradd --create-home --uid 1001 --shell /bin/bash agent

ENV PATH=/opt/factoree/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
