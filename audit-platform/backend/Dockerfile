# syntax=docker/dockerfile:1
#
# API image. Build from audit-platform/ (it also packages the TB parser, which
# the demo profile runs as a resource-limited subprocess):
#   docker build -f backend/Dockerfile -t audit-api .
# Behind a TLS-inspecting proxy, pass its CA: --secret id=extra_ca,src=ca.pem

FROM node:22-bookworm-slim AS build
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: the official Python image (for the parser) plus the Node.js binary
# from the Node image, so nothing is fetched from OS package mirrors.
FROM python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /usr/sbin/nologin --no-create-home node
COPY parser/requirements.lock /tmp/requirements.lock
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && python -m venv /app/parser/.venv \
 && /app/parser/.venv/bin/pip install --no-cache-dir --no-deps --only-binary=:all: --require-hashes -r /tmp/requirements.lock \
 && /app/parser/.venv/bin/pip uninstall -y pip \
 && rm -rf /usr/local/lib/python3.12/ensurepip /usr/local/bin/pip*
COPY parser/tb_parser /app/parser/tb_parser
COPY --from=build /src/backend/node_modules /app/backend/node_modules
COPY --from=build /src/backend/dist /app/backend/dist
COPY backend/package.json /app/backend/package.json
WORKDIR /app/backend
ENV NODE_ENV=production TB_PARSER_DIR=/app/parser TB_PARSER_PYTHON=/app/parser/.venv/bin/python
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
