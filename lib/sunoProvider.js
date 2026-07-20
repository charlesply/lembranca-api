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
const apipassApi = require('./apipassApi');
const { getClient } = require('./suno');

const POLICY = String(process.env.SUNO_PROVIDER || 'auto').toLowerCase();

// ═══ A/B sunoapi.org × ApiPass ═══
// APIPASS_AB_PCT = % das gerações sorteadas pra ApiPass (0-100, default 0=off).
// Sorteio DETERMINÍSTICO por orderId (mesmo pedido sempre no mesmo braço, mesmo
// em re-execução do Inngest). Cross-fallback: se o provider sorteado falhar de
// forma recuperável, tenta o OUTRO antes do cookie — mas o `assigned`/`fellBack`
// no retorno registram a falha do sorteado pra métrica do A/B ficar honesta.
const AB_PCT = Math.max(0, Math.min(100, Number(process.env.APIPASS_AB_PCT || 0)));
// Os dois clientes de API que rodam em KIE (mesmo formato de retorno).
const API_CLIENTS = {
  sunoapi: { client: sunoApi, provider: 'api' },
  apipass: { client: apipassApi, provider: 'apipass' },
};
function _hashPct(id) {
  const s = String(id || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h % 100;
}
function _assignApi(orderId) {
  if (AB_PCT <= 0) return 'sunoapi';
  if (AB_PCT >= 100) return 'apipass';
  return _hashPct(orderId) < AB_PCT ? 'apipass' : 'sunoapi';
}

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
// Suno rejeita título >80 chars (400) e request grande demais (413). Cliente às
// vezes cola história gigante no campo do NOME → título estoura; história/letra
// enorme → payload estoura. Aparamos aqui, no ponto único por onde tudo passa.
function _clipTitle(t) {
  t = String(t || '').trim();
  if (t.length <= 80) return t || 'Sua música';
  const cut = t.slice(0, 80);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).trim();
}
const _clipPrompt = (p) => String(p || '').slice(0, 3000);

async function submit({ prompt, style, title, instrumental = false, vocalGender, negativeTags, fallbackArgs, orderId }) {
  // 🔒 sanitiza limites do Suno (título ≤80, prompt/letra ≤3000) — API e fallback
  title = _clipTitle(title);
  prompt = _clipPrompt(prompt);
  if (fallbackArgs && typeof fallbackArgs === 'object') {
    if (fallbackArgs.title) fallbackArgs.title = _clipTitle(fallbackArgs.title);
    if (fallbackArgs.prompt) fallbackArgs.prompt = _clipPrompt(fallbackArgs.prompt);
  }

  // Hard cookie-only? legacy 100%
  if (POLICY === 'cookie') {
    return await _viaCookie(fallbackArgs);
  }

  const args = { prompt, style, title, instrumental, vocalGender, negativeTags };
  const assigned = _assignApi(orderId);         // 'sunoapi' | 'apipass' (A/B)
  const other = assigned === 'sunoapi' ? 'apipass' : 'sunoapi';

  // 1) Provider SORTEADO pelo A/B.
  try {
    const a = API_CLIENTS[assigned];
    const r = await a.client.submitMusic(args);
    console.log(`[sunoProvider] ✅ ${assigned} submit ok — taskId=${r.taskId} model=${r.model}`);
    return { provider: a.provider, taskId: r.taskId, model: r.model, assigned, fellBack: false };
  } catch (e) {
    // Erros NÃO-recuperáveis (400/422 moderação/429) SOBEM pro generateSong tratar —
    // e o outro provider KIE rejeitaria igual, então nem tenta.
    if (!API_CLIENTS[assigned].client.isFallbackable(e)) {
      console.error(`[sunoProvider] ❌ ${assigned} erro NÃO-recuperável: ${e.message}`);
      throw e;
    }
    console.warn(`[sunoProvider] ⚠️ ${assigned} falhou (${e.message}) — cross-fallback pro ${other}`);
  }

  // 2) Cross-fallback pro OUTRO provider de API (mantém o cliente servido).
  try {
    const b = API_CLIENTS[other];
    const r = await b.client.submitMusic(args);
    console.log(`[sunoProvider] ✅ cross-fallback ${other} submit ok — taskId=${r.taskId}`);
    return { provider: b.provider, taskId: r.taskId, model: r.model, assigned, fellBack: true };
  } catch (e2) {
    if (POLICY === 'api') {
      console.error(`[sunoProvider] ❌ ambos APIs falharam (politica=api, sem cookie): ${e2.message}`);
      throw e2;
    }
    if (!API_CLIENTS[other].client.isFallbackable(e2)) {
      console.error(`[sunoProvider] ❌ ${other} erro NÃO-recuperável: ${e2.message}`);
      throw e2;
    }
    // 3) Último recurso: cookie (legacy).
    console.warn(`[sunoProvider] ⚠️ ambos APIs falharam — fallback pro cookie`);
    const c = await _viaCookie(fallbackArgs);
    return { ...c, assigned, fellBack: true };
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
  if (provider === 'api' || provider === 'apipass') {
    if (!taskId) throw new Error(`sunoProvider.getStatus: taskId obrigatório pra provider=${provider}`);
    const api = provider === 'apipass' ? apipassApi : sunoApi;
    const s = await api.getTaskStatus(taskId);
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
