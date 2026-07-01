// ═══════════════════════════════════════════════════════════════════════════
// Cliente HTTP da sunoapi.org — provedor primário de geração de música.
//
// Decisões do dono:
//   • Modelo SEMPRE V5_5 (nunca cair pra versão inferior). Hardcoded.
//   • Polling-based — combina com Inngest step.sleep que é durável.
//     Não usamos callBackUrl pra não precisar expor webhook público.
//   • Auth: Bearer SUNO_API_KEY (header Authorization).
//
// Doc oficial: https://docs.sunoapi.org/
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios');

const BASE_URL = process.env.SUNOAPI_BASE_URL || 'https://api.sunoapi.org';
const MODEL = 'V5_5';
const TIMEOUT_MS = 30000;

function _key() {
  const k = process.env.SUNO_API_KEY || '';
  if (!k) {
    const err = new Error('SUNOAPI_NO_KEY: SUNO_API_KEY não configurada no .env');
    err.code = 'SUNOAPI_NO_KEY';
    throw err;
  }
  return k;
}
function _headers() {
  return { Authorization: `Bearer ${_key()}`, 'Content-Type': 'application/json' };
}

// Submete uma nova música via /api/v1/generate (V5_5, customMode).
// Limites do V5_5 confirmados na doc:
//   prompt: 5000 chars · style: 1000 chars · title: 100 chars
// callBackUrl é OBRIGATÓRIO pela API — default aponta pro nosso webhook.
// Nosso polling (Inngest) é o autoritativo; o webhook só registra/loga.
//
// Parâmetros opcionais úteis:
//   vocalGender: 'm' | 'f' — preferência de voz (quiz já coleta isso)
//   negativeTags: string   — estilos a evitar (ex: "metal, eletrônico")
//   styleWeight: 0.00–1.00 — peso da influência do style
async function submitMusic({
  prompt, style, title,
  instrumental = false,
  vocalGender,            // 'm' | 'f' (opcional)
  negativeTags,           // string (opcional)
  styleWeight,            // 0..1 (opcional)
  callBackUrl,
}) {
  const cbUrl = callBackUrl
    || process.env.SUNOAPI_CALLBACK_URL
    || `${process.env.SELF_URL || 'https://historiascantadas.linkarbox.app'}/api/webhooks/sunoapi`;
  const body = {
    model: MODEL,
    customMode: true,
    instrumental: !!instrumental,
    prompt: String(prompt || '').slice(0, 5000),
    style: String(style || 'pop').slice(0, 1000),
    title: String(title || 'Musica personalizada').slice(0, 100),
    callBackUrl: cbUrl,
  };
  // Voz (opcional)
  const vg = String(vocalGender || '').toLowerCase();
  if (vg === 'm' || vg === 'f') body.vocalGender = vg;
  else if (/^male|masculin/i.test(vocalGender || '')) body.vocalGender = 'm';
  else if (/^female|feminin/i.test(vocalGender || '')) body.vocalGender = 'f';
  // Negative tags (opcional)
  if (negativeTags) body.negativeTags = String(negativeTags).slice(0, 1000);
  // Style weight (opcional)
  if (typeof styleWeight === 'number' && styleWeight >= 0 && styleWeight <= 1) {
    body.styleWeight = Math.round(styleWeight * 100) / 100;
  }

  const resp = await axios.post(`${BASE_URL}/api/v1/generate`, body, {
    headers: _headers(), timeout: TIMEOUT_MS,
  });

  const code = resp.data?.code;
  const taskId = resp.data?.data?.taskId;
  if (code !== 200 || !taskId) {
    const err = new Error(`SUNOAPI_SUBMIT_FAIL: code=${code} msg=${resp.data?.msg || '?'}`);
    err.code = code; err.response = { status: code, data: resp.data };
    throw err;
  }
  return { taskId, model: MODEL };
}

// Status da geração. Retorna { status: PENDING|GENERATING|SUCCESS|FAILED, tracks: [...] }
// Estrutura dos tracks já normalizada pro formato que o pipeline existente espera
// (status, audio_url, title, duration, etc.)
async function getTaskStatus(taskId) {
  const resp = await axios.get(`${BASE_URL}/api/v1/generate/record-info`, {
    params: { taskId }, headers: _headers(), timeout: TIMEOUT_MS,
  });
  const code = resp.data?.code;
  if (code !== 200) {
    const err = new Error(`SUNOAPI_STATUS_FAIL: code=${code} msg=${resp.data?.msg || '?'}`);
    err.code = code; err.response = { status: code, data: resp.data };
    throw err;
  }
  const d = resp.data.data || {};
  const rawStatus = String(d.status || 'PENDING').toUpperCase();
  // SUNOAPI as vezes retorna status especificos de falha
  // (GENERATE_AUDIO_FAILED com errorMessage="Internal Error" eh o mais comum).
  // Normalizamos esses pra FAILED, senao sunoProvider.getStatus mapeia tudo pra 'submitted'
  // (fallback) e o polling fica em loop ate timeout de 2h — desperdicando creditos
  // que ja foram cobrados pela SUNOAPI.
  const FAILED_STATUSES = ['GENERATE_AUDIO_FAILED', 'CREATE_TASK_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR'];
  const status = FAILED_STATUSES.includes(rawStatus) ? 'FAILED' : rawStatus;
  // ATENÇÃO: a doc oficial diz "response.data" mas a API real devolve
  // "response.sunoData" (camelCase: audioUrl, sourceAudioUrl, imageUrl, prompt).
  // Acomodamos AMBOS pra robustez caso a API mude no futuro.
  const raw = Array.isArray(d.response?.sunoData) ? d.response.sunoData
            : Array.isArray(d.response?.data)     ? d.response.data
            : [];
  const tracks = raw.map((t) => ({
    id: t.id || t.audio_id || '',
    audio_url: t.audioUrl || t.audio_url
            || t.sourceAudioUrl || t.source_audio_url
            || t.streamAudioUrl || t.stream_audio_url
            || '',
    title: t.title || '',
    duration: Number(t.duration || 0),
    tags: t.tags || '',
    image_url: t.imageUrl || t.image_url || t.sourceImageUrl || t.source_image_url || '',
    lyric: t.prompt || t.lyric || '',
  }));
  return { taskId, status, tracks };
}

// Saldo de créditos (pra dashboard e decisão preventiva).
// Endpoint: GET /api/v1/generate/credit · response { code, msg, data: <int> }
// Não-fatal: retorna null se a chamada falhar (não bloqueia geração).
async function getCredits() {
  try {
    const resp = await axios.get(`${BASE_URL}/api/v1/generate/credit`, {
      headers: _headers(), timeout: 10000,
    });
    const c = resp.data?.data;
    return typeof c === 'number' ? c : (typeof c?.credits === 'number' ? c.credits : null);
  } catch (_) { return null; }
}

// Classifica se um erro é "recuperável via fallback pro cookie".
//   • 401: chave inválida/expirada
//   • 402 / quota / insufficient: sem créditos
//   • 5xx: servidor da sunoapi com problema
//   • timeout/ENOTFOUND/ECONNRESET: rede instável
//   • SUNOAPI_NO_KEY: nem tentamos (chave vazia)
function isFallbackable(err) {
  if (err?.code === 'SUNOAPI_NO_KEY') return true;
  const status = err.response?.status || err.code || 0;
  if (status === 401 || status === 402) return true;
  if (status >= 500 && status < 600) return true;
  return /timeout|ENOTFOUND|ECONNRESET|EAI_AGAIN|insufficient|quota|credit/i
    .test(err.message || '');
}

// URL PERMANENTE do clipe no CDN do Suno (cdn1.suno.ai). O `audioUrl` que a API
// devolve aponta pra tempfile.aiquickdraw.com, que EXPIRA em ~2 semanas — por
// isso músicas antigas paravam de tocar no painel. O cdn1 usa o próprio ID do
// clipe e persiste. Guardamos SEMPRE o cdn1 em full_audio_urls/original_audio_url.
function clipCdnUrl(id) {
  const s = String(id || '').trim();
  return s ? `https://cdn1.suno.ai/${s}.mp3` : null;
}

module.exports = { submitMusic, getTaskStatus, getCredits, isFallbackable, clipCdnUrl, MODEL, BASE_URL };
