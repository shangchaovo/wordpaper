FROM node:22-alpine AS bundle

WORKDIR /app
RUN apk add --no-cache python3
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN python3 scripts/package_companion.py >/dev/null

FROM node:22-alpine

RUN apk add --no-cache espeak-ng
WORKDIR /app
COPY --from=bundle --chown=node:node /app /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8770 \
    WORDPAPER_MODE=public \
    WORDPAPER_DATA_DIR=/data \
    WORDPAPER_COMPANION_ENABLED=0

RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8770

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
