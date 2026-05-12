FROM node:22-alpine

# node:22-alpine ships a `node` user (uid 1000). We run as that user,
# not root, so a container compromise can't write outside /tmp (compose
# mounts a tmpfs there) and can't escalate.
WORKDIR /app

# Install only production deps. devDependencies (typescript, @solana/web3.js,
# @types/node, nodemon) are not needed to run the Shield — they exist for
# building the TypeScript client SDK and for local dev workflow only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    chown -R node:node /app

# Shield runtime files only. demo.js and bench.js are client-side tools that
# ship with the source for humans, not with the container.
COPY --chown=node:node index.js ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/

USER node
EXPOSE 3000
CMD ["node", "index.js"]
