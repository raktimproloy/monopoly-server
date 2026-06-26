# Base node image
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./
COPY package-lock.json ./

RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build
RUN mkdir -p dist/config/game_data && cp src/config/game_data/*.json dist/config/game_data/

# Production image, copy all compiled files and run express server
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=6001

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/schema.sql ./

USER nodejs

EXPOSE 6001

CMD ["npm", "start"]
