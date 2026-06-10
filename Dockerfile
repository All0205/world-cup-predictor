FROM node:20

WORKDIR /app

COPY . .

EXPOSE 5051

CMD ["node", "server.js"]
