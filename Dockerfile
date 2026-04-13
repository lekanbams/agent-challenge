FROM node:23-slim AS base

# Install system dependencies needed for native modules (e.g. better-sqlite3)
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  git \
  && rm -rf /var/lib/apt/lists/*

# Disable telemetry
ENV ELIZAOS_TELEMETRY_DISABLED=true
ENV DO_NOT_TRACK=1

WORKDIR /app

# Install pnpm and bun
RUN npm install -g pnpm
RUN npm install -g bun

# Copy package manifest and lockfile, install dependencies
COPY package.json .npmrc ./
RUN pnpm install

# Run Bun postinstall (required by @elizaos/cli)
RUN cd node_modules/bun && node install.js || true

# Apply patches for Qwen3.5 compatibility and web-search display
COPY patches/ /tmp/patches/
ENV APP_DIR=/app
RUN node /tmp/patches/apply.js

# Copy all source files
COPY . .

# Build TypeScript plugin
RUN node node_modules/typescript/lib/tsc.js

# Copy compiled plugin into node_modules so ElizaOS can load it
RUN mkdir -p node_modules/nosana-eliza-agent && \
    cp dist/index.js node_modules/nosana-eliza-agent/index.js && \
    echo '{"name":"nosana-eliza-agent","main":"index.js","type":"module"}' > node_modules/nosana-eliza-agent/package.json

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV SERVER_PORT=3000

CMD ["bun", "node_modules/@elizaos/cli/dist/index.js", "start", "--character", "./characters/agent.character.json"]
