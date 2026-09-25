# syntax=docker/dockerfile:1
#
# Sandboxed trial-balance parser: one container per file, run by the API's
# worker with no network, a read-only root filesystem, no capabilities and a
# non-root user (see backend/src/modules/tb-ingestion/container-parser.ts).
# The image holds only the interpreter, three hash-pinned wheels and the
# parser package: no shell tools are needed at run time.
#
#   docker build -t audit-tb-parser .
#   docker run --rm -i --network none --read-only audit-tb-parser --format csv < tb.csv

ARG PYTHON_IMAGE=python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.lock /tmp/requirements.lock
# Behind a TLS-inspecting proxy, pass its CA as a build secret
# (--secret id=extra_ca,src=ca.pem); it is never stored in a layer.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-deps --only-binary=:all: --require-hashes -r /tmp/requirements.lock \
 && /opt/venv/bin/pip uninstall -y pip \
 && rm -rf /opt/venv/lib/python3.12/site-packages/setuptools*
# The package goes into site-packages: `python -I` does not put the working
# directory on sys.path.
COPY tb_parser /opt/venv/lib/python3.12/site-packages/tb_parser
RUN /opt/venv/bin/python -m compileall -q /opt/venv/lib/python3.12/site-packages \
 && /opt/venv/bin/python -I -m tb_parser --version

FROM ${PYTHON_IMAGE}
LABEL org.opencontainers.image.title="audit-tb-parser" \
      org.opencontainers.image.description="Sandboxed trial-balance parser (xlsx/csv -> JSON)"
RUN rm -rf /usr/local/lib/python3.12/ensurepip /usr/local/lib/python3.12/site-packages/pip* /usr/local/bin/pip*
COPY --from=build /opt/venv /opt/venv
ENV PYTHONDONTWRITEBYTECODE=1 LANG=C.UTF-8
WORKDIR /nonexistent
USER 65532:65532
ENTRYPOINT ["/opt/venv/bin/python", "-I", "-m", "tb_parser"]
