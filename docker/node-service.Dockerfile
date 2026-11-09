# -----------------------------------------------------------------------------
# Imagen generica de los microservicios AegisVolt (multi-stage).
# Una misma receta para los 4 servicios; se elige con build args:
#
#   docker build -f docker/node-service.Dockerfile \
#     --build-arg SERVICE=station-reservation-service \
#     --build-arg SERVICE_DIR=services/station-reservation-service \
#     -t aegisvolt/station-reservation-service:<sha> .
#
# La MISMA imagen se promueve dev -> test -> prod: el ambiente lo define el
# ConfigMap de Kubernetes (AEGIS_ENV, URLs, flags admin), nunca la imagen.
# -----------------------------------------------------------------------------
FROM node:22-slim AS build
ARG SERVICE
ARG SERVICE_DIR
WORKDIR /app

# 1) Solo manifiestos: la capa de dependencias se cachea mientras no cambien.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/common/package.json packages/common/
COPY services/station-reservation-service/package.json services/station-reservation-service/
COPY services/billing-wallet-service/package.json services/billing-wallet-service/
COPY services/energy-dispatch-service/package.json services/energy-dispatch-service/
COPY graphql-gateway/package.json graphql-gateway/
RUN npm ci --no-audit --no-fund --ignore-scripts

# 2) Codigo y compilacion TypeScript -> dist/
COPY packages/common packages/common
COPY ${SERVICE_DIR} ${SERVICE_DIR}
RUN npm run build -w @aegisvolt/common && npm run build -w @aegisvolt/${SERVICE} \
 && npm prune --omit=dev --workspace=@aegisvolt/${SERVICE} --include-workspace-root=false --no-audit --no-fund

# 3) Imagen final: solo dist + dependencias de produccion, usuario sin privilegios.
FROM node:22-slim
ARG SERVICE
ARG SERVICE_DIR
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    SERVICE_DIR=${SERVICE_DIR} \
    APP_VERSION=${APP_VERSION} \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/packages/common/package.json packages/common/
COPY --from=build --chown=node:node /app/packages/common/dist packages/common/dist
COPY --from=build --chown=node:node /app/${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY --from=build --chown=node:node /app/${SERVICE_DIR}/dist ${SERVICE_DIR}/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node ${SERVICE_DIR}/dist/index.js"]
