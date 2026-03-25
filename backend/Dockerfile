FROM node:18-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 4000
CMD ["node", "server.js"]
