// ═══════════════════════════════════════════════════════════════════════════
// Cliente HTTP da ApiPass (apipass.dev) — provedor ALTERNATIVO de geração.
//
// Roda no MESMO backend KIE que a sunoapi.org (musicfile.kie.ai), então os
// clipes são clipes Suno REAIS: o campo `id` é o clip ID do Suno e resolve em
// cdn1.suno.ai/{id}.mp3 (permanente, oficial) — igual à sunoapi. Por isso o
// pipeline pode usar clipCdnUrl(clip.id) pros DOIS providers sem mudar nada.
//
// Interface IDÊNTICA ao lib/sunoApi.js (submitMusic/getTaskStatus/isFallbackable)
// pra plugar no sunoProvider sem reescrever o generateSong.
//
// Descobertas empíricas (19/jul, teste real com a chave do Charles):
//   • Endpoint: POST /api/v1/jobs/createTask  { model:"suno/generate", input:{...} }
//     ⚠️ params vão DENTRO de `input` (senão 422); campos em snake_case.
//   • Versão do modelo = `input.model_version` ("V5_5" → chirp-fenix = v5.5).
//     (o campo `input.model` é IGNORADO e cai em chirp-crow=v5.0 — NÃO usar)
//   • Status: GET /api/v1/jobs/recordInfo?taskId=  → data.state + data.resultJson.data[]
//   • state: waiting|queuing→PENDING · generating→GENERATING · success→SUCCESS · failed→FAILED
//   • Auth: Bearer APIPASS_API_KEY (chave apk_...)
// ═══════════════════════════════════════════════════════════════════════════
const axios = require('axios');

const BASE_URL = process.env.APIPASS_BASE_URL || 'https://api.apipass.dev/api/v1';
// V5_5 → chirp-fenix (v5.5). Mesmo modelo que a sunoapi (paridade no A/B).
const MODEL_VERSION = process.env.APIPASS_MODEL_VERSION || 'V5_5';
const TIMEOUT_MS = 30000;

function _key() {
  const k = process.env.APIPASS_API_KEY || '';
  if (!k) {
    const err = new Error('APIPASS_NO_KEY: APIPASS_API_KEY não configurada no .env');
    err.code = 'APIPASS_NO_KEY';
    throw err;
  }
  return k;
}
function _headers() {
  return { Authorization: `Bearer ${_key()}`, 'Content-Type': 'application/json' };
}

// Submete uma nova música. Mesma assinatura do sunoApi.submitMusic.
// Retorna { taskId, model } — model = a versão real pedida (pra log/métrica).
async function submitMusic({
  prompt, style, title,
  instrumental = false,
  vocalGender,   // aceito por compat; a voz já vai embutida no style/tags
  negativeTags,  // idem
}) {
  const input = {
    customMode: true,
    instrumental: !!instrumental,
    prompt: String(prompt || '').slice(0, 5000),
    style: String(style || 'pop').slice(0, 1000),
    title: String(title || 'Musica personalizada').slice(0, 100),
    model_version: MODEL_VERSION,
  };
  if (negativeTags) input.negativeTags = String(negativeTags).slice(0, 1000);
  const vg = String(vocalGender || '').toLowerCase();
  if (vg === 'm' || vg === 'f') input.vocalGender = vg;

  const resp = await axios.post(`${BASE_URL}/jobs/createTask`,
    { model: 'suno/generate', input },
    { headers: _headers(), timeout: TIMEOUT_MS });

  const taskId = resp.data?.data?.taskId || resp.data?.taskId;
  const code = resp.data?.code;
  if (!taskId) {
    const err = new Error(`APIPASS_SUBMIT_FAIL: code=${code} msg=${resp.data?.message || '?'}`);
    err.code = code || 'APIPASS_SUBMIT_FAIL';
    err.response = { status: code, data: resp.data };
    throw err;
  }
  return { taskId, model: MODEL_VERSION };
}

// Status da geração. Retorna { taskId, status, tracks } no MESMO formato do sunoApi.
async function getTaskStatus(taskId) {
  const resp = await axios.get(`${BASE_URL}/jobs/recordInfo`, {
    params: { taskId }, headers: _headers(), timeout: TIMEOUT_MS,
  });
  const d = resp.data?.data || {};
  const st = String(d.state || 'waiting').toLowerCase();
  const status = st === 'success'    ? 'SUCCESS'
               : st === 'failed'     ? 'FAILED'
               : st === 'generating' ? 'GENERATING'
               : 'PENDING'; // waiting | queuing
  // Clipes ficam em resultJson.data[]. audio_url prioriza o STREAM ao vivo
  // (musicfile.kie.ai) pra prévia instantânea; o permanente vem do clipCdnUrl(id)
  // no pipeline. source_stream_audio_url já é o cdn1 (fallback).
  const raw = Array.isArray(d.resultJson?.data) ? d.resultJson.data
            : Array.isArray(d.resultJson) ? d.resultJson
            : [];
  const tracks = raw.map((t) => ({
    id: t.id || t.audio_id || '',
    audio_url: t.stream_audio_url || t.source_stream_audio_url || t.audio_url || '',
    title: t.title || '',
    duration: Number(t.duration || 0),
    tags: t.tags || '',
    image_url: t.image_url || t.source_image_url || '',
    lyric: t.prompt || t.lyric || '',
  }));
  return { taskId, status, tracks };
}

// Saldo (não-fatal). ApiPass não documentou endpoint estável de saldo → null.
async function getCredits() { return null; }

// Mesma classificação de "recuperável via fallback" do sunoApi.
function isFallbackable(err) {
  if (err?.code === 'APIPASS_NO_KEY') return true;
  const status = err.response?.status || err.code || 0;
  if (status === 401 || status === 402) return true;
  if (status >= 500 && status < 600) return true;
  return /timeout|ENOTFOUND|ECONNRESET|EAI_AGAIN|insufficient|quota|credit|balance/i
    .test(err.message || '');
}

module.exports = { submitMusic, getTaskStatus, getCredits, isFallbackable, MODEL_VERSION, BASE_URL };
