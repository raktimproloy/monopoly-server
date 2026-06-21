# Base node image
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files for dependency installation
COPY server/package*.json ./server/
COPY server/package-lock.json ./server/

WORKDIR /app/server
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server

WORKDIR /app/server
RUN npm run build

# Production image, copy all compiled files and run express server
FROM base AS runner
WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=6001

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

COPY --from=builder /app/server/package.json ./
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/schema.sql ./

USER nodejs

EXPOSE 6001

CMD ["npm", "start"]
