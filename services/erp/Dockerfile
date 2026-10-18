FROM node:24-alpine
WORKDIR /app
COPY package.json server.ts erp.ts ./
ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "server.ts"]
