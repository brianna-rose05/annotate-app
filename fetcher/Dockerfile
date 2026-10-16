# Start from an official image that already has Node 22
FROM node:22-slim

# Work inside /app in the container
WORKDIR /app

# Install packages first (Docker caches this step if package files don't change)
COPY package*.json ./
RUN npm ci --omit=dev

# Then copy your code
COPY server.mjs ./

ENV PORT=3000
EXPOSE 3000

# Don't run as the all-powerful root user
USER node

CMD ["node", "server.mjs"]