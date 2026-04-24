FROM node:22-alpine

WORKDIR /app

# Install only production deps. devDependencies (typescript, @solana/web3.js,
# @types/node, nodemon) are not needed to run the Shield — they exist for
# building the TypeScript client SDK and for local dev workflow only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Shield runtime files only. demo.js and bench.js are client-side tools that
# ship with the source for humans, not with the container.
COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
