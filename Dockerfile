FROM node:18

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm install

COPY . .

RUN npm run build

RUN mkdir -p /app/raft-data

VOLUME /app/raft-data

EXPOSE 3001-3100

CMD ["npm", "run", "dev", "server", "node1"]
