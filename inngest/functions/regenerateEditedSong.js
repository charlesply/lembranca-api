// ═══════════════════════════════════════════════════════════════════════════
// regenerateEditedSong — regeneração da música pelo PRÓPRIO cliente (self-edit).
//
// Disparado por POST /api/order/:id/edit/confirm (event 'song/edit.requested')
// DEPOIS que o cliente confirmou a letra nova. É ISOLADA da generateSong (o
// pipeline principal de venda) de propósito: risco zero pro fluxo que fatura.
//
// Diferenças pro generateSong:
//   • usa a letra JÁ confirmada pelo cliente (não gera letra via GPT aqui)
//   • NÃO faz prévia nem manda WhatsApp — é pós-pago, entrega por e-mail + painel
//   • MANTÉM as 2 versões antigas (já snapshotadas em prev_audio_urls no confirm)
//     e grava as 2 NOVAS em full_audio_urls / original_audio_url
//   • pro plano com vídeo: limpa video_brinde_url → o cron brindeVideo regenera
//     o vídeo do novo áudio automaticamente
//   • ao terminar: edit_status='done' + e-mail "nova música pronta"
// ═══════════════════════════════════════════════════════════════════════════
const { inngest } = require('../client');
const { NonRetriableError } = require('inngest');
const { supaFetch } = require('../../lib/supabase');
const sunoProvider = require('../../lib/sunoProvider');
const { sendEditReadyEmail } = require('../../lib/emailDelivery');

// Planos que incluem vídeo (completa + promos c/ vídeo). Fonte única: payPlans.
let VIDEO_PLAN_KEYS = ['completa'];
try {
  const { VIDEO_PLAN_KEYS_CSV } = require('../../lib/payPlans');
  if (VIDEO_PLAN_KEYS_CSV) VIDEO_PLAN_KEYS = String(VIDEO_PLAN_KEYS_CSV).split(',').map(s => s.trim()).filter(Boolean);
} catch (_) {}

const regenerateEditedSong = inngest.createFunction(
  {
    id: 'regenerate-edited-song',
    retries: 5,
    concurrency: [
      { limit: 4 },                              // teto global modesto (feature de baixo volume)
      { limit: 1, key: 'event.data.orderId' },   // 1 regeneração por pedido
    ],
    // editNonce muda a cada confirmação → não colide com a geração original nem
    // com uma futura (improvável, self_edit_used trava, mas fica robusto).
    idempotency: 'event.data.orderId + ":edit:" + string(event.data.editNonce)',
    onFailure: async ({ event, error }) => {
      const orderId = event?.data?.event?.data?.orderId || event?.data?.orderId;
      console.error('[EditRegen] ❌ falha terminal order', orderId, error?.message);
      if (orderId) {
        try {
          await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
            edit_status: 'error',
            error_message: `[edit_error] regeneração self-edit falhou: ${String(error?.message || '').slice(0, 200)}`,
          });
        } catch (_) {}
      }
    },
  },
  { event: 'song/edit.requested' },
  async ({ event, step }) => {
    const d = event.data || {};
    const orderId = d.orderId;
    if (!orderId) throw new NonRetriableError('sem orderId');

    // ═══ STEP 1: carrega o pedido (letra confirmada, estilo, voz, plano) ═══
    const info = await step.run('load-order', async () => {
      const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,genre,style_raw,voice_preference,plan,final_lyrics,edit_status,self_edit_used`);
      const o = Array.isArray(rows) && rows[0];
      if (!o) throw new NonRetriableError('pedido não encontrado');
      return o;
    });

    const lyrics = (d.lyrics || info.final_lyrics || '').toString();
    if (!lyrics.trim()) throw new NonRetriableError('sem letra pra gerar');
    const style = info.genre || info.style_raw || 'MPB';
    const title = info.honoree_name ? `Para ${info.honoree_name}` : 'Sua música';
    const vr = String(info.voice_preference || '');
    const vocalGender = /^m$|masculin|\bmale\b|homem/i.test(vr) ? 'm' : /^f$|feminin|female|mulher/i.test(vr) ? 'f' : undefined;

    // ═══ STEP 2: submete pro Suno (customMode, letra confirmada) ═══
    const submitRef = await step.run('suno-submit-edit', async () => {
      const fallbackArgs = {
        prompt: lyrics, tags: style, title, model: d.model,
        make_instrumental: false,
        vocal_gender: vocalGender === 'm' ? 'male' : vocalGender === 'f' ? 'female' : undefined,
        wait_audio: false,
      };
      let result;
      try {
        result = await sunoProvider.submit({ prompt: lyrics, style, title, instrumental: false, vocalGender, fallbackArgs });
      } catch (err) {
        const status = err.response?.status;
        if (status === 400 || status === 422) throw new NonRetriableError(`Suno rejeitou (${status})`, { cause: err });
        throw err; // 5xx/timeout/429 → retry normal
      }
      const patch = { suno_provider: result.provider };
      if (result.provider === 'api') patch.suno_task_id = result.taskId; else patch.suno_clip_ids = result.clipIds;
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, patch);
      return { provider: result.provider, taskId: result.taskId || null, clipIds: result.clipIds || null };
    });

    // ═══ STEP 3: polling durável (~25 min máx) ═══
    // Sem fases/auto-retry como a generateSong — feature de baixo volume, mais
    // simples. Aceita quando ambos os clips terminam, ou o que tiver após ~6min.
    let completed = null;
    const ATTEMPTS = 45;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const wait = attempt < 3 ? `${20 + attempt * 5}s` : attempt < 40 ? '30s' : '90s';
        await step.sleep(`edit-wait-${attempt}`, wait);
      }
      const poll = await step.run(`edit-poll-${attempt}`, async () => {
        const s = await sunoProvider.getStatus({ provider: submitRef.provider, taskId: submitRef.taskId, clipIds: submitRef.clipIds });
        console.log(`[EditRegen] poll ${attempt + 1}/${ATTEMPTS} order=${orderId} [${s.status}] done=${s.allDone}`);
        return { tracks: s.tracks, status: s.status, allDone: s.allDone };
      });
      const done = poll.tracks.filter(t => t.status === 'complete' && t.audio_url);
      if (poll.status === 'FAILED' && !done.length) {
        throw new Error('Suno retornou FAILED sem clips'); // deixa retry / onFailure
      }
      // ambos prontos → fecha; ou aceita parcial após ~6min (attempt>=12) com >=1
      if (poll.allDone && done.length) { completed = done; break; }
      if (done.length >= 2) { completed = done; break; }
      if (attempt >= 12 && done.length >= 1) { completed = done; break; }
    }

    if (!completed || !completed.length) {
      throw new Error('timeout: nenhum clip novo ficou pronto'); // onFailure marca edit_error
    }
    const best = completed[0];

    // ═══ STEP 4: grava as versões NOVAS (mantém as antigas em prev_audio_urls) ═══
    const isVideoPlan = VIDEO_PLAN_KEYS.includes(info.plan);
    await step.run('save-new-versions', async () => {
      const patch = {
        original_audio_url: best.audio_url,
        full_audio_urls: completed.map(c => c.audio_url).filter(Boolean),
        suno_clip_ids: completed.map(c => c.id),
        edit_status: 'done',
        error_message: null,
      };
      // Plano com vídeo: limpa o vídeo antigo → cron brindeVideo regenera do novo
      // áudio + nova letra (usa original_audio_url + final_lyrics, já atualizados).
      if (isVideoPlan) {
        patch.video_brinde_url = null;
        patch.video_brinde_job_id = null;
        patch.video_brinde_started_at = null;
      }
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, patch);
      console.log(`[EditRegen] ✅ novas versões salvas order=${orderId} (${patch.full_audio_urls.length} clips)${isVideoPlan ? ' + vídeo p/ regenerar' : ''}`);
    });

    // ═══ STEP 5: e-mail "nova música pronta" ═══
    await step.run('email-edit-ready', async () => {
      const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,customer_name,customer_email,plan`);
      const o = Array.isArray(rows) && rows[0];
      if (!o) return { skipped: 'no_order' };
      return await sendEditReadyEmail(o);
    });

    return { ok: true, orderId, clips: completed.length, video: isVideoPlan };
  }
);

module.exports = { regenerateEditedSong };
