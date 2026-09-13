FROM oven/bun:1.3.14-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/rag/package.json packages/rag/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.14-debian AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/rag/package.json ./packages/rag/package.json
COPY --from=build /app/packages/rag/dist ./packages/rag/dist
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8787/health');if(!r.ok)process.exit(1)"]
CMD ["bun", "apps/server/dist/main.js"]
