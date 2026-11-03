ARG RUST_IMAGE=rust:1.95.0-bookworm
FROM ${RUST_IMAGE}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends binutils file \
    && rm -rf /var/lib/apt/lists/*

ENV CARGO_HOME=/cargo \
    CARGO_TARGET_DIR=/target \
    RUSTUP_TOOLCHAIN=1.95.0
WORKDIR /source
