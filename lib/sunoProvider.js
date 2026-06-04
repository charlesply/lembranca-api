// ═══════════════════════════════════════════════════════════════════════════
// Provider de geração de música — abstrai sunoapi.org (API paga) vs cookie.
//
// Política via env SUNO_PROVIDER:
//   • api    — só sunoapi.org. Falha hard se a API falhar.
//   • cookie — só cookie/SunoClient (comportamento legacy antes desta API).
//   • auto   — tenta API primeiro, cai pro cookie em erros recuperáveis (DEFAULT).
//
// O fallback acontece em:
//   • chave inválida/ausente (401, SUNOAPI_NO_KEY)
//   • sem créditos (402, "insufficient", "quota")
//   • 5xx persistente do sunoapi.org
//   • timeout/erro de rede ao submeter
//
// O fallback NÃO acontece em:
//   • 400 (parâmetro errado — bug nosso, não vai ajudar tentar de novo)
//   • 422 (moderation — Suno também vai rejeitar)
//
// Pra TODOS os retornos:
//   • submit() devolve { provider: 'api'|'cookie', taskId?, clipIds? }
//   • getStatus() devolve formato normalizado igual nas 2 rotas
// ═══════════════════════════════════════════════════════════════════════════
const sunoApi = require('./sunoApi');
const { getClient } = require('./suno');

const POLICY = String(process.env.SUNO_PROVIDER || 'auto').toLowerCase();

/**
 * Submete uma música. Args principais:
 *   - prompt: a letra (ou descrição se não-customMode)
 *   - style: gênero/tags ("MPB, Sertanejo Romântico")
 *   - title: título da música
 *   - instrumental: bool
 *   - fallbackArgs: objeto completo que o SunoClient.customGenerate() espera
 *     (prompt, tags, title, model, make_instrumental, negative_tags, vocal_gender,
 *      wait_audio). Usado SÓ se cair no cookie — caminho legacy intacto.
 */
async function submit({ prompt, style, title, instrumental = false, vocalGender, negativeTags, fallbackArgs }) {
  // Hard cookie-only? legacy 100%
  if (POLICY === 'cookie') {
    return await _viaCookie(fallbackArgs);
  }

  // Tenta a API (api OR auto)
  try {
    const r = await sunoApi.submitMusic({ prompt, style, title, instrumental, vocalGender, negativeTags });
    console.log(`[sunoProvider] ✅ API submit ok — taskId=${r.taskId} model=${r.model}`);
    return { provider: 'api', taskId: r.taskId, model: r.model };
  } catch (e) {
    if (POLICY === 'api') {
      console.error(`[sunoProvider] ❌ API submit falhou (politica=api, sem fallback): ${e.message}`);
      throw e;
    }
    if (!sunoApi.isFallbackable(e)) {
      console.error(`[sunoProvider] ❌ API submit falhou com erro NÃO-recuperável: ${e.message}`);
      throw e;
    }
    console.warn(`[sunoProvider] ⚠️ API submit falhou (${e.message}) — fallback pro cookie`);
    return await _viaCookie(fallbackArgs);
  }
}

async function _viaCookie(fallbackArgs) {
  if (!fallbackArgs) throw new Error('sunoProvider._viaCookie: fallbackArgs obrigatório');
  const client = await getClient();
  const clips = await client.customGenerate(fallbackArgs);
  const ids = clips.map((c) => c.id);
  console.log(`[sunoProvider] ✅ cookie submit ok — clips=${ids.join(',')}`);
  return { provider: 'cookie', clipIds: ids };
}

/**
 * Status normalizado. Retorna { status, tracks: [{id, status, audio_url, ...}], allDone, anyComplete }.
 *   - status global: PENDING|GENERATING|SUCCESS|FAILED
 *   - tracks: array com formato consistente
 *   - allDone: true se todos terminaram (complete OR error)
 *   - anyComplete: primeiro track com status=complete + audio_url (pra partial result)
 *
 * Recebe contexto { provider, taskId, clipIds } — o que o submit() devolveu.
 */
async function getStatus({ provider, taskId, clipIds }) {
  if (provider === 'api') {
    if (!taskId) throw new Error('sunoProvider.getStatus: taskId obrigatório pra provider=api');
    const s = await sunoApi.getTaskStatus(taskId);
    const tracks = s.tracks.map((t) => ({
      id: t.id,
      status: s.status === 'SUCCESS' ? 'complete'
            : s.status === 'FAILED'  ? 'error'
            : t.audio_url            ? 'streaming'
            : 'submitted',
      audio_url: t.audio_url || '',
      title: t.title || '',
      duration: t.duration || 0,
      tags: t.tags || '',
      image_url: t.image_url || '',
      lyric: t.lyric || '',
    }));
    return _summarize(s.status, tracks);
  }

  // cookie
  if (!Array.isArray(clipIds) || !clipIds.length) {
    throw new Error('sunoProvider.getStatus: clipIds obrigatório pra provider=cookie');
  }
  const client = await getClient();
  const clips = await client.getClips(clipIds);
  const tracks = clips.map((c) => ({
    id: c.id,
    status: c.status,
    audio_url: c.audio_url || '',
    title: c.title || '',
    duration: c.duration || 0,
    tags: c.tags || '',
    image_url: c.image_url || '',
    lyric: c.lyric || '',
  }));
  const allComplete = tracks.length && tracks.every((t) => t.status === 'complete');
  const allError = tracks.length && tracks.every((t) => t.status === 'error');
  const globalStatus = allComplete ? 'SUCCESS' : allError ? 'FAILED' : 'GENERATING';
  return _summarize(globalStatus, tracks);
}

function _summarize(status, tracks) {
  const allDone = tracks.length && tracks.every((t) => t.status === 'complete' || t.status === 'error');
  const anyComplete = tracks.find((t) => t.status === 'complete' && t.audio_url) || null;
  return { status, tracks, allDone, anyComplete };
}

module.exports = { submit, getStatus, POLICY };
