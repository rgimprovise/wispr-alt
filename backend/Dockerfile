FROM oven/bun:1.3-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Copy source
COPY index.ts ./
COPY src ./src

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787

# Fly.io sets PORT via env; backend reads process.env.PORT with 8787 fallback.
CMD ["bun", "index.ts"]
