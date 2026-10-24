# syntax=docker/dockerfile:1

FROM node:22-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN cd src/apps/cli && npm run build

FROM node:22-slim AS runtime-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /deps
COPY src/apps/cli/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

FROM node:22-slim

WORKDIR /app
COPY --from=runtime-deps /deps/node_modules ./node_modules
COPY --from=builder /build/src/apps/cli/dist ./dist
COPY --chmod=755 src/apps/cli/docker-entrypoint.sh /usr/local/bin/livesync-cli

VOLUME ["/data"]
ENTRYPOINT ["livesync-cli"]
