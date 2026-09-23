FROM --platform=$TARGETPLATFORM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8000

USER node

CMD ["node", "server.js"]
