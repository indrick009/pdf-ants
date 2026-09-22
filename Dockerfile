FROM node:20-alpine

# qpdf: streaming, low-memory PDF merge. curl: healthchecks.
RUN apk add --no-cache qpdf curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

# Default command is the API; the worker service overrides it.
CMD ["node", "src/server.js"]
