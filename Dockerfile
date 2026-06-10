FROM node:20-bullseye

# So ffmpeg (gera a previa 30s/50s do MP3 via lib/audio.js).
# Playwright/Chromium removidos em 10/jun/2026 — SUNOAPI eh path primario.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Inngest precisa de NODE_ENV=production p/ rodar em modo Cloud (e nao "dev").
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
