FROM node:20-bullseye

# Dependências do Chromium (lista oficial do Playwright pra Debian)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxshmfence1 \
    libpango-1.0-0 libcairo2 libasound2 libgtk-3-0 fonts-liberation \
    ca-certificates wget && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Inngest precisa de NODE_ENV=production p/ rodar em modo Cloud (e nao "dev").
# O nixpacks setava isso automaticamente; no Dockerfile precisa ser explicito.
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

# Instalar TUDO que Playwright suporta — inclui chromium + chrome-headless-shell + deps
# chrome-headless-shell é necessário em Playwright 1.50+ pra headless: true
# Cache buster: 2026-05-30-v2
RUN npx playwright install --with-deps && \
    ls -la /root/.cache/ms-playwright/ && \
    find /root/.cache/ms-playwright -name 'chrome-headless-shell' -type f

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
