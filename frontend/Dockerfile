# Built on the builder's own architecture — Vite emits static assets, which are
# the same bytes whichever machine produced them. This matters more here than
# in the backend images: without it, the arm64 half of the multi-arch build
# (k8s/push-ecr.sh) would run npm ci plus a full Vite production build under
# QEMU emulation. Only the nginx runtime stage below is genuinely per-target.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Vite env vars are baked in at build time, not read at container runtime —
# these must match whatever host the Ingress serves the app on (k8s/base/ingress.yaml).
ARG VITE_API_URL=http://pugetscope.127.0.0.1.nip.io:8081/api
ARG VITE_WS_URL=ws://pugetscope.127.0.0.1.nip.io:8081/live
ARG VITE_VAPID_PUBLIC_KEY=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_VAPID_PUBLIC_KEY=$VITE_VAPID_PUBLIC_KEY
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
