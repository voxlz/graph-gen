FROM node:20-bookworm-slim

# node-canvas needs cairo/pango/jpeg/gif system libs to build & run
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# Skip lifecycle scripts (e.g. husky prepare) and rebuild canvas explicitly so
# native bindings are always present in the final image.
RUN npm install --omit=dev --ignore-scripts && npm rebuild canvas --build-from-source
COPY src ./src
COPY style.jsonc ./
COPY demo ./demo

# Usage:
#   docker run -v $(pwd)/out:/app/out graphgen demo/usecases/bookstore_uc1.ggn out/output.png
ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD ["demo/usecases/bookstore_uc1.ggn", "output.png"]
