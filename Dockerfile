# syntax=docker/dockerfile:1

# ---- base: full dependency set + sources (used for building and for verify) ----
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test

# ---- builder: TypeScript build ----
FROM base AS builder
RUN npm run build

# ---- application image: runtime has no external npm dependencies ----
FROM node:22-alpine AS app
WORKDIR /app
ENV NODE_ENV=production
ENV APP_PORT=3000
RUN addgroup -S app && adduser -S app -G app
# package.json marks the runtime tree as ES modules (the app itself has no
# external npm dependencies).
COPY package.json ./
COPY --from=builder /app/dist ./dist
USER app
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]

# ---- one-shot verification service ----
FROM base AS verify
ENV APP_URL=http://app:3000
COPY scripts ./scripts
# Runs the TypeScript build, the test suite, waits for the app health endpoint
# and then exercises the API (including a non-greedy trap request). Exits 0
# only when every stage passes; see scripts/verify.mjs for the bit mask.
CMD ["node", "scripts/verify.mjs"]
