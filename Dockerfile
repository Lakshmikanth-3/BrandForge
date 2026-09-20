FROM node:22-slim AS base
WORKDIR /app

# Install dependencies (uses lockfile for reproducible builds)
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci

# Build all workspaces (shared -> api/mcp, then the web app)
FROM deps AS build
COPY . .
RUN npm run build

# Production image: only what's needed to run the api server
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Fly injects PORT; the app's env schema defaults to 4021 if unset
EXPOSE 4021

CMD ["node", "packages/api/dist/server.js"]
