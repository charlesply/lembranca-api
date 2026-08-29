// lib/r2 — hospeda o áudio no Cloudflare R2 (durabilidade PERMANENTE), servido por
// cdn.lcantada.com. Resolve o problema do tempfile (expira 14 dias) e do cdn1
// (MissingKey). Ver reference_suno_cdn_missingkey.
//
// Fluxo: baixa a URL tocável que a Suno devolve (tempfile) e sobe pro bucket.
// 🔒 GATE: R2_ENABLED='true' + credenciais (R2_ENDPOINT/R2_ACCESS_KEY_ID/
//   R2_SECRET_ACCESS_KEY). Se desligado OU qualquer falha → retorna null e o
//   caller mantém a URL tempfile (fallback) — NUNCA quebra a geração.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ENABLED = process.env.R2_ENABLED === 'true';
const BUCKET = process.env.R2_BUCKET || 'lc-musicas';
const CDN = (process.env.R2_CDN || 'https://cdn.lcantada.com').replace(/\/+$/, '');

let _s3 = null;
function client() {
  if (_s3) return _s3;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  _s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
  return _s3;
}

// Sobe 1 clip pro R2. Retorna a URL pública (cdn.lcantada.com) ou null (falha →
// o caller usa a URL original como fallback). Idempotente (sobrescreve a mesma key).
async function uploadClip(clipId, sourceUrl) {
  if (!ENABLED || !clipId || !sourceUrl) return null;
  const s3 = client();
  if (!s3) return null;
  try {
    const r = await fetch(sourceUrl);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const Key = `musicas/${clipId}.mp3`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: buf, ContentType: 'audio/mpeg' }));
    return `${CDN}/${Key}`;
  } catch (e) {
    console.error('[r2] upload falhou (mantém tempfile):', e.message);
    return null;
  }
}

module.exports = { uploadClip, R2_ENABLED: ENABLED };
