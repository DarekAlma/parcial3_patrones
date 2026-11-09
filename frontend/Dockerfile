# Frontend AegisVolt: build estatico (Vite) servido por nginx sin privilegios.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# app-config.json real lo monta el ConfigMap del ambiente (peers para comparar flags).
USER 101
EXPOSE 8080
