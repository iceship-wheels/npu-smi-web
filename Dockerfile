ARG TARGETPLATFORM
FROM --platform=$TARGETPLATFORM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm config set strict-ssl false && npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8000

USER node

CMD ["node", "server.js"]
