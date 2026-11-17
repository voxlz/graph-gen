FROM node:20-bookworm-slim AS build

# node-canvas needs Cairo and Pango headers and a toolchain to build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Skip lifecycle scripts (e.g. husky prepare) and rebuild canvas explicitly so
# native bindings are always present in the final image.
RUN npm ci --ignore-scripts && npm rebuild canvas --build-from-source
COPY src ./src
# Precompile so each render skips TypeScript transpilation (see src/bundle.ts).
RUN npx tsx src/bundle.ts && npm prune --omit=dev --ignore-scripts

FROM node:20-bookworm-slim

# Runtime libraries for the canvas binding, and the fonts used for text.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu-core \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json style.jsonc ./
COPY demo ./demo

# Usage:
#   docker run -v $(pwd)/out:/app/out graph-gen demo/usecases/bookstore_uc1.ggn out/output.png
# Absolute path so the image also works with another working directory (-w).
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["demo/usecases/bookstore_uc1.ggn", "output.png"]
