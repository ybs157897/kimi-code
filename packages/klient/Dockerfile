# syntax=docker/dockerfile:1.7
#
# Klient e2e docker-run image.
#
# Source code and node_modules are provided by bind mounts from
# scripts/run-docker-e2e.sh, so host edits are picked up without rebuilding.
# Keep the image self-contained: the repository does not have a root
# Dockerfile, and the credential-free CI gate must not depend on a locally
# prebuilt server image.
#
# The launcher intentionally does not pass -p/--publish to docker run. The
# server binds inside the container only, so this workflow can run alongside the
# docker-compose.yml server that publishes host port 7878.

FROM node:24.15.0-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        g++ \
        git \
        make \
        python3 \
    && npm install --global pnpm@10.33.0 \
    && apt-get clean

ENV KIMI_CODE_HOME=/data/docker-e2e/kimi-code-home \
    KIMI_SERVER_URL=http://127.0.0.1:7878 \
    KIMI_SERVER_E2E_REPORT_DIR=/data/server-e2e-reports/docker/latest \
    TMPDIR=/data/docker-e2e/tmp \
    TERM=xterm-256color \
    TZ=Asia/Shanghai \
    npm_config_store_dir=/workspace/kimi-code/node_modules/.pnpm-store \
    npm_config_package_import_method=copy

WORKDIR /workspace/kimi-code/packages/klient

CMD ["bash"]
