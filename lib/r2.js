// lib/r2 — hospeda o áudio no Cloudflare R2 (durabilidade PERMANENTE), servido por
// cdn.lcantada.com. Resolve o problema do tempfile (expira 14 dias) e do cdn1
// (MissingKey). Ver reference_suno_cdn_missingkey.
//
// 🚨 DECISÃO DO DONO (29/ago): R2 é OBRIGATÓRIO. TODA música fica no R2 — NUNCA
//   mais tempfile. Não existe fallback pra tempfile (o R2 é sempre funcional).
//   Se o upload falhar de forma transitória, RE-TENTA; se esgotar as tentativas,
//   ESTOURA (throw) pro caller — que num step do Inngest re-executa até subir.
//   Assim o pedido NUNCA recebe uma URL tempfile que expira.
//
// 🔒 GATE: R2_ENABLED='true' + credenciais (R2_ENDPOINT/R2_ACCESS_KEY_ID/
//   R2_SECRET_ACCESS_KEY). Só quando desligado (dev/off) retorna null.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ENABLED = process.env.R2_ENABLED === 'true';
const BUCKET = process.env.R2_BUCKET || 'lc-musicas';
const CDN = (process.env.R2_CDN || 'https://cdn.lcantada.com').replace(/\/+$/, '');
const DOWNLOAD_TIMEOUT_MS = 60000; // baixar o mp3 da Suno (tempfile) sem pendurar
const MAX_ATTEMPTS = 5;

let _s3 = null;
function client() {
  if (_s3) return _s3;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  // requestHandler com timeout: sem isso um PUT pendurado trava o worker.
  let requestHandler;
  try {
    const { NodeHttpHandler } = require('@smithy/node-http-handler');
    requestHandler = new NodeHttpHandler({ connectionTimeout: 10000, requestTimeout: 60000 });
  } catch (_) { /* SDK usa o default se o handler não estiver disponível */ }
  _s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey }, ...(requestHandler ? { requestHandler } : {}) });
  return _s3;
}

async function _downloadWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf || buf.length < 1000) throw new Error(`buffer vazio/curto (${buf ? buf.length : 0} bytes)`);
    return buf;
  } finally { clearTimeout(t); }
}

// Sobe 1 clip pro R2. Retorna a URL pública (cdn.lcantada.com/musicas/{id}.mp3).
// Idempotente (sobrescreve a mesma key). RE-TENTA em falha transitória; se esgotar,
// ESTOURA (sem fallback tempfile). Só retorna null quando R2 está desligado (gate).
async function uploadClip(clipId, sourceUrl) {
  if (!ENABLED) return null; // gate off (dev) — único caso de null
  if (!clipId || !sourceUrl) throw new Error('[r2] uploadClip: clipId e sourceUrl são obrigatórios');
  const s3 = client();
  if (!s3) throw new Error('[r2] credenciais R2 ausentes (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)');
  const Key = `musicas/${clipId}.mp3`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buf = await _downloadWithTimeout(sourceUrl);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: buf, ContentType: 'audio/mpeg' }));
      if (attempt > 1) console.log(`[r2] ✅ ${clipId} subiu na tentativa ${attempt}`);
      return `${CDN}/${Key}`;
    } catch (e) {
      lastErr = e;
      console.error(`[r2] tentativa ${attempt}/${MAX_ATTEMPTS} falhou p/ ${clipId}: ${e.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  // R2 é obrigatório — NÃO cai pro tempfile. Estoura pro caller (o step do Inngest
  // re-executa e tenta de novo até subir). Ver reference_r2_hospedagem.
  throw new Error(`[r2] upload FALHOU após ${MAX_ATTEMPTS} tentativas p/ ${clipId}: ${lastErr && lastErr.message}`);
}

module.exports = { uploadClip, R2_ENABLED: ENABLED, CDN, BUCKET };
