const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Mantemos AUDIO_EDIT_URL exportado por compatibilidade (server.js healthcheck
// referencia), mas o serviço externo NÃO é mais chamado — a prévia agora é
// gerada localmente via ffmpeg.
const AUDIO_EDIT_URL = process.env.AUDIO_EDIT_URL || 'http://audio-edit:5000';
const SELF_URL = process.env.SELF_URL || 'https://api-suno.linkarbox.app';

// Quanto da música vira a prévia. Decisão do dono: prévia limpa, sem narração
// "isso é uma prévia, faça o pagamento". Só os primeiros N segundos.
const PREVIEW_SECONDS = parseInt(process.env.PREVIEW_SECONDS || '50', 10);

// Diretorios para preview
const PREVIEW_DIR = path.join(__dirname, '..', 'previews');
const ORIGINALS_DIR = path.join(__dirname, '..', 'originals');
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });
if (!fs.existsSync(ORIGINALS_DIR)) fs.mkdirSync(ORIGINALS_DIR, { recursive: true });

async function downloadFile(url, destPath) {
  const resp = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  const writer = fs.createWriteStream(destPath);
  resp.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Gera a prévia cortando os primeiros PREVIEW_SECONDS via ffmpeg.
// Assinatura idêntica à versão antiga (que usava o serviço audio-edit + narração
// embutida) — callers não precisam mudar nada. Trocamos a dependência externa
// por ffmpeg local (já no Dockerfile do suno-api-lite).
//
// Otimização: -c copy NÃO re-encoda o stream MP3 (rápido, ~1s, sem perda).
//             -t N corta na duração exata.
//             -avoid_negative_ts make_zero evita timestamps negativos no header.
async function createPreviewFromUrl(audioUrl, orderId, title) {
  const uid = orderId || crypto.randomBytes(6).toString('hex');
  // Sanitizar título para nome de arquivo seguro
  const safeName = (title || uid).replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').replace(/\s+/g, '_').substring(0, 80);
  const originalPath = path.join(ORIGINALS_DIR, `${safeName}.mp3`);
  const previewPath = path.join(PREVIEW_DIR, `${safeName}_preview.mp3`);

  // 1. Baixa MP3 original do provider (Suno via cookie ou sunoapi.org)
  console.log(`[Preview] Baixando original de: ${audioUrl.substring(0, 80)}...`);
  await downloadFile(audioUrl, originalPath);
  const fileSize = (fs.statSync(originalPath).size / 1024).toFixed(0);
  console.log(`[Preview] ✅ Original salvo (${fileSize}KB)`);

  // 2. Corta os primeiros N segundos via ffmpeg local (sem voz, sem efeitos).
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', originalPath,
      '-t', String(PREVIEW_SECONDS),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      previewPath,
    ], { timeout: 60000 });
  } catch (e) {
    // Fallback: se -c copy falhar (header malformado, etc.), re-encoda
    console.warn(`[Preview] -c copy falhou (${e.message?.slice(0,80)}) — re-encodando MP3...`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', originalPath,
      '-t', String(PREVIEW_SECONDS),
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      previewPath,
    ], { timeout: 90000 });
  }

  const previewSize = (fs.statSync(previewPath).size / 1024).toFixed(0);
  console.log(`[Preview] ✅ Preview salvo: ${previewPath} (${previewSize}KB, ${PREVIEW_SECONDS}s)`);
  return {
    uid,
    originalPath,
    previewPath,
    previewFilename: `${safeName}_preview.mp3`,
    originalFilename: `${safeName}.mp3`,
  };
}

module.exports = { createPreviewFromUrl, downloadFile, PREVIEW_DIR, ORIGINALS_DIR, AUDIO_EDIT_URL, SELF_URL };
