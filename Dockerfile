FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 4000 4001

CMD ["node", "packages/node/dist/cli.js", "--port", "4001", "--api-port", "4000"]
