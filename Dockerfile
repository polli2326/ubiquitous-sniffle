FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node *.js schema.sql ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.js"]
