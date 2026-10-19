# One image for the API and the worker (F11): the same code, started with
# `node dist/main` or `node dist/worker`.

# --- build: everything needed to compile, plus the Prisma CLI for migrations.
FROM node:24-slim AS build
WORKDIR /app

# Prisma's schema engine, used by `prisma migrate deploy`, needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# prisma.config.ts requires the migrate URL to be set; generate never connects.
RUN DATABASE_MIGRATE_URL=postgresql://build@localhost/build npx prisma generate \
  && npm run build

# --- runtime: production dependencies and the compiled output only.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/main"]
