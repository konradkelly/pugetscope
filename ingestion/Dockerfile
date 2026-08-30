# Built on the builder's own architecture — this stage only runs tsc, and the
# dist/ it emits is architecture-independent JavaScript. Keeps the arm64 half
# of the multi-arch build (k8s/push-ecr.sh) off QEMU emulation; the runtime
# stage below stays per-target so its npm ci resolves platform-correct deps.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
