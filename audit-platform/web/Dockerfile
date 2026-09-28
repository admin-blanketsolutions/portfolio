# syntax=docker/dockerfile:1
#
# Web image (Next.js standalone server). Build from audit-platform/web:
#   docker build -t audit-web .
# Sign-in is OIDC against the firm's IdP (issuer from /api/auth/config);
# AUTH_CONNECT_SRC (runtime) must list the IdP origin for the CSP.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm ci --no-audit --no-fund
COPY . .
ENV NEXT_OUTPUT=standalone NEXT_PUBLIC_API_BASE=/api NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node /app/.next/standalone ./
COPY --from=build --chown=node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
