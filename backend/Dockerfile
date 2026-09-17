# syntax=docker/dockerfile:1
FROM node:24-alpine
ARG APP_NAME
ENV APP_NAME=$APP_NAME
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
COPY --from=contracts . /usr/src/contracts/dictation-v1
RUN npm ci
COPY . .
RUN npm run build -- ${APP_NAME}
ENV NODE_ENV=production
CMD ["sh", "-c", "node dist/apps/${APP_NAME}/main.js"]
