// lib/r2 — hospeda o áudio no Cloudflare R2 (durabilidade PERMANENTE), servido por
// cdn.lcantada.com. Resolve o problema do tempfile (expira 14 dias) e do cdn1
// (MissingKey). Ver reference_suno_cdn_missingkey.
//
// 🚨 DECISÃO DO DONO (29/ago): R2 é OBRIGATÓRIO. TODA música fica no R2 — NUNCA
//   mais tempfile. Não existe fallback pra tempfile (o R2 é sempre funcional).
//   O upload INSISTE (re-tenta com backoff) até gravar no R2, mesmo que demore —
//   cliente que pagou NÃO pode ficar sem música. Só num cenário extremo (R2 fora
//   por mais que o budget), como ÚLTIMO recurso, estoura pro caller — e aí o
//   próprio step do Inngest re-executa de forma durável e volta a insistir.
//
// 🔒 GATE: R2_ENABLED='true' + credenciais (R2_ENDPOINT/R2_ACCESS_KEY_ID/
//   R2_SECRET_ACCESS_KEY). Só quando desligado (dev/off) retorna null.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ENABLED = process.env.R2_ENABLED === 'true';
const BUCKET = process.env.R2_BUCKET || 'lc-musicas';
const CDN = (process.env.R2_CDN || 'https://cdn.lcantada.com').replace(/\/+$/, '');
const DOWNLOAD_TIMEOUT_MS = 60000; // baixar o mp3 da Suno (tempfile) sem pendurar
// INSISTE até subir: re-tenta por até ~45 min (backoff). Na prática sobe na 1ª/2ª.
const RETRY_BUDGET_MS = Number(process.env.R2_RETRY_BUDGET_MS || 45 * 60 * 1000);
const BACKOFF_MAX_MS = 60000;

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
// Idempotente (sobrescreve a mesma key). INSISTE (re-tenta com backoff) até subir,
// dentro do budget (~45 min). NÃO cai pro tempfile. Só retorna null quando R2 está
// desligado (gate off / dev). Estoura só se estourar o budget (último recurso).
async function uploadClip(clipId, sourceUrl) {
  if (!ENABLED) return null; // gate off (dev) — único caso de null
  if (!clipId || !sourceUrl) throw new Error('[r2] uploadClip: clipId e sourceUrl são obrigatórios');
  const s3 = client();
  if (!s3) throw new Error('[r2] credenciais R2 ausentes (R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)');
  const Key = `musicas/${clipId}.mp3`;
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let attempt = 0, lastErr;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const buf = await _downloadWithTimeout(sourceUrl);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: buf, ContentType: 'audio/mpeg' }));
      if (attempt > 1) console.log(`[r2] ✅ ${clipId} subiu na tentativa ${attempt}`);
      return `${CDN}/${Key}`;
    } catch (e) {
      lastErr = e;
      console.error(`[r2] tentativa ${attempt} falhou p/ ${clipId} (insistindo): ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, BACKOFF_MAX_MS)));
    }
  }
  // Estourou o budget (R2 fora por >45min — cenário extremo). NÃO grava tempfile;
  // estoura pro caller (o step do Inngest re-executa de forma durável e volta a
  // insistir até subir). Ver reference_r2_hospedagem.
  throw new Error(`[r2] upload não subiu dentro do budget p/ ${clipId} (${attempt} tentativas): ${lastErr && lastErr.message}`);
}

module.exports = { uploadClip, R2_ENABLED: ENABLED, CDN, BUCKET };
