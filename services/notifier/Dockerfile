FROM node:24-alpine
WORKDIR /app
COPY package.json server.ts ./
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "server.ts"]
