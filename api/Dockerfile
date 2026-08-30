# glibc base (not alpine) — argon2 ships prebuilt native bindings for glibc,
# avoiding a from-source compile against musl.
#
# Pinned to the builder's own architecture, not the target's: this stage only
# runs tsc, and the dist/ it emits is architecture-independent JavaScript. On a
# multi-arch build (k8s/push-ecr.sh) the arm64 variant would otherwise run the
# whole npm ci + tsc under QEMU emulation for an identical result. The runtime
# stage below is deliberately left per-target — its `npm ci` is what resolves
# argon2's native binding, which genuinely does differ per architecture.
FROM --platform=$BUILDPLATFORM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
