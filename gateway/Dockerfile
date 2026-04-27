FROM node:22-alpine

WORKDIR /app

# Install only production deps. devDependencies (typescript, @solana/web3.js,
# @types/node, nodemon) are not needed to run the Shield — they exist for
# building the TypeScript client SDK and for local dev workflow only.
#
# IMPORTANT: this Dockerfile expects the build context to be the REPO ROOT
# (one level above gateway/), because it needs to copy ../dashboard/public/
# into the image. See docker-compose.yml — `context: ..`.
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev

# Shield runtime — index.js + persistence layer.
COPY gateway/index.js ./
COPY gateway/lib/ ./lib/

# Internal pages (/live, /try, /explorer) served by Express.
COPY gateway/public/ ./public/

# Public 3D management console — served at "/" by index.js. Lives at the
# repo root in dashboard/public/, so we COPY it into /app/dashboard/public/
# inside the image. index.js auto-detects this layout.
COPY dashboard/public/ ./dashboard/public/

EXPOSE 3000

CMD ["node", "index.js"]
