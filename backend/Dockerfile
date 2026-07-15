FROM node:22-alpine

WORKDIR /app

COPY package.json /app

COPY package-lock.json /app

RUN npm install

COPY . /app

EXPOSE 5001

CMD ["npm", "start"]
