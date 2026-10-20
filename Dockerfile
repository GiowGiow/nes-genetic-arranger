# The song server (spec 005, research R16): a small Starlette app in server/ that reuses the
# command line's lead-sheet reader in src/. GitHub Actions builds and pushes it to
# ghcr.io/giowgiow/nes-arranger-server (.github/workflows/server-image.yml).
#
# Local check:
#   docker build -t nes-arranger-server .
#   docker run --rm --read-only --tmpfs /tmp -p 8765:8765 nes-arranger-server
#   curl http://localhost:8765/health

FROM python:3.12-slim

LABEL org.opencontainers.image.source="https://github.com/GiowGiow/nes-genetic-arranger" \
      org.opencontainers.image.description="Song server of the NES genetic arranger" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Dependencies first, so that a code change reuses this layer: the project's own dependencies
# plus the `server` group, exactly as locked, without the dev tools.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --group server

COPY src/ src/
COPY server/ server/
COPY arranger/data/catalog/ arranger/data/catalog/
# Compile now: at run time the root filesystem is read-only and nothing is written next to code.
RUN python -m compileall -q src server

# The server writes only to /tmp (the reader's temporary MIDI file); in Kubernetes /tmp is an
# emptyDir and the root filesystem is mounted read-only. HOME points there for music21.
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /tmp server
ARG COMMIT=dev
ENV APP_COMMIT=$COMMIT \
    PATH=/app/.venv/bin:$PATH \
    HOME=/tmp \
    MPLCONFIGDIR=/tmp/matplotlib
USER 10001:10001

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=4)"]
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8765", "--no-access-log"]
