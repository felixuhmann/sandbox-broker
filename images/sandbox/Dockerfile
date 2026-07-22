# Hardened sandbox image.
#
# Design rules:
#   * PID 1 is inert. No untrusted code runs at container start; work only ever
#     arrives through `docker exec` after the network policy is verified.
#   * Runs as a fixed non-root UID/GID.
#   * The root filesystem is mounted read-only at runtime. The only writable
#     paths are the /workspace volume and two noexec tmpfs mounts.
#
# Releases pin this base by digest; the tag here keeps local builds workable.
FROM debian:bookworm-slim

ARG SANDBOX_UID=10001
ARG SANDBOX_GID=10001

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        findutils \
        gawk \
        git \
        grep \
        gzip \
        jq \
        less \
        procps \
        python3 \
        python3-venv \
        ripgrep \
        sed \
        tar \
        tini \
        unzip \
        wget \
        xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --gid "${SANDBOX_GID}" sandbox; \
    useradd --uid "${SANDBOX_UID}" --gid "${SANDBOX_GID}" --home-dir /workspace --shell /bin/bash sandbox; \
    mkdir -p /workspace; \
    chown "${SANDBOX_UID}:${SANDBOX_GID}" /workspace

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 0555 /usr/local/bin/sandbox-entrypoint

ENV HOME=/workspace \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1

USER ${SANDBOX_UID}:${SANDBOX_GID}
WORKDIR /workspace

# tini reaps the processes that `docker exec` leaves behind.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandbox-entrypoint"]
