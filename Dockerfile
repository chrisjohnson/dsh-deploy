# dsh (DeepSeek Harness) — config-as-code service. Companion to
# jmfederico-pi-web/Dockerfile; same repo conventions (seed-once vs
# always-sync split in docker-entrypoint.sh, secrets via env var only,
# durable state bind-mounted from the host, never baked into the image).
FROM node:22-bookworm-slim

# No Caddy/TLS here — tried and removed (see git history for the full
# story). dsh's frontend needs a secure browser context
# (crypto.randomUUID etc.) AND hard-pins its configuration plane
# (settings.*, credentials.*) to a literal localhost/127.0.0.1 Host header,
# which no proxy topology can ever satisfy for a real LAN hostname anyway
# — Caddy solved the first problem while being structurally unable to
# solve the second. An SSH tunnel straight to dsh's own loopback bind
# solves BOTH at once (localhost is always a secure context, and IS the
# literal Host header the loopback gate wants) with none of the TLS/CA
# complexity. Matches this box's own established convention for every
# other unauthenticated local service (vLLM, llama.cpp — see
# docker-compose.yml's top-of-file port-allocation comment: "reach via SSH
# tunnel"). Revisit if/when a real auth-gateway story exists — see
# docs/adding-tools-to-dsh.md for more on that decision.

# Common CLI tools for dsh's own bash tool to actually use inside sessions
# — apt where Debian packages them cleanly, matching
# jmfederico-pi-web's Dockerfile conventions exactly. docker.io gives the
# `docker` CLI (socket access + group membership is a compose-level
# concern, see docker-compose.yml's group_add, not baked in here — same
# split pi-web uses).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    wget \
    ca-certificates \
    jq \
    openssl \
    netcat-openbsd \
    unzip \
    less \
    nano \
    tree \
    python3 \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# yq (Mike Farah's Go yq — the YAML-for-jq tool people mean by "yq", not
# the unrelated Python wrapper apt might otherwise resolve to). No clean
# Debian package; pinned, checksum-verified static binary, same pattern
# pi-web's own Dockerfile uses for its docker-compose plugin install.
RUN curl -fsSL -o /usr/local/bin/yq \
        https://github.com/mikefarah/yq/releases/download/v4.53.4/yq_linux_amd64 \
    && echo "f67d8a6a2dc2308c961f83d5ba8707fd4c7c44ad77902fef87eb3a4646cdfa2a  /usr/local/bin/yq" | sha256sum -c - \
    && chmod +x /usr/local/bin/yq

# GitHub CLI (gh) — no official Debian package either; adding Docker's own
# apt repo + GPG key for one binary is more surface area than a pinned,
# checksum-verified tarball, same reasoning pi-web's Dockerfile gives for
# its own docker-compose plugin install.
RUN curl -fsSL -o /tmp/gh.tar.gz \
        https://github.com/cli/cli/releases/download/v2.97.0/gh_2.97.0_linux_amd64.tar.gz \
    && echo "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv /tmp/gh_2.97.0_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh_2.97.0_linux_amd64

# `npm install` here pins @deepseek-ai/dsh AND the searxng search plugin
# into ONE flat node_modules tree as real siblings — this is what makes the
# plugin's `@deepseek-ai/dsh-*` peer dependencies resolve at all. (Confirmed
# during development: a plugin installed standalone outside this app's own
# node_modules cannot resolve those peers via Node's upward node_modules
# walk.) Do not
# split this into two separate `npm install` calls or two node_modules
# trees; that reintroduces the exact failure this avoids.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

ENV PATH="/app/node_modules/.bin:${PATH}"
ENV DSH_HOME=/dsh-home

# Baked-in defaults for $DSH_HOME's config-as-code paths — seed-copied
# into place on first boot only by docker-entrypoint.sh, never
# overwriting an existing (possibly agent-edited) file. Not bind-mounted
# live from a git checkout on the host: dsh-deploy is a pulled image with
# no checkout on the box. See docker-entrypoint.sh for the full reasoning.
COPY dsh-home-seed /app/dsh-home-seed

# GitHub App credential helper — lives under /app so Node's own
# node_modules resolution finds @octokit/auth-app from the tree `npm ci`
# above already installed, same reasoning the flat-tree comment above
# gives for the dsh plugins.
# Executable: git invokes credential.helper by direct path (`<path> get`),
# not via `node <path>`.
COPY github-app-token.mjs github-app-git-credential-helper.mjs /app/
RUN chmod +x /app/github-app-git-credential-helper.mjs

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# node:22-bookworm-slim ships a uid/gid 1000 `node` user already — reused
# rather than inventing a new one (matches this repo's uid 1000 convention
# for non-root service users, e.g. jmfederico-pi-web's `piweb`).
USER node
WORKDIR /work

# Generic fallback only — docker-compose.yml's `command:` overrides this
# with the deployment-specific --trusted-host and is what actually runs.
# --host 127.0.0.1 is dsh's own safe default posture (it hard-refuses
# 0.0.0.0 unconditionally regardless — see the top-of-file comment); the
# published port is bound to the HOST's own 127.0.0.1 only in
# docker-compose.yml, matching this box's SSH-tunnel-only convention for
# every other unauthenticated local service.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["dsh", "web", "--host", "127.0.0.1", "--port", "3080"]
