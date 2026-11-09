# OpenSkyLight home server: runs every service headless and serves the
# display UI to the wall tablet (Fully Kiosk Browser) on port 8080.
#   docker compose up -d     (see docker-compose.yml)

FROM node:22-bookworm-slim AS build
WORKDIR /app
# the Electron binary isn't needed to build the web bundles
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx electron-vite build && npm run build:companion && npm run build:server

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    OSL_DATA_DIR=/data \
    OSL_PORT=8080
COPY package.json package-lock.json ./
# scripts are skipped (no Electron rebuild), then better-sqlite3 is built for Node
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
 && npm cache clean --force \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y
COPY --from=build /app/out ./out
VOLUME /data
# 8080 = wall display, 8420 = phone companion app (enable it in Settings)
EXPOSE 8080 8420
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "out/server/index.js"]
