# TEPRA Web — Wi-Fi / LAN label printing for TEPRA PRO SR5900P.
# No npm dependencies are needed for network printing; the Bluetooth bridge is left out of the image.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    DATA_DIR=/data \
    TEPRA_BLUETOOTH=0

WORKDIR /app
COPY package.json ./
COPY index.html favicon.svg manifest.webmanifest PROTOCOL.md LICENSE THIRD_PARTY_LICENSES.md ./
COPY app ./app
COPY server ./server
COPY test ./test

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server/index.js"]
