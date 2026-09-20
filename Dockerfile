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
# A stale tsbuildinfo makes `tsc --build` believe the output is current and emit nothing,
# which produced an image with no dist/ and a server that could not start. .dockerignore
# excludes these, but a build that fails silently this badly deserves a second guard.
RUN find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
RUN npm run build
# Fail the build now, not at container start, if the server did not get compiled.
RUN test -f packages/api/dist/server.js && test -f apps/web/dist/index.html

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
