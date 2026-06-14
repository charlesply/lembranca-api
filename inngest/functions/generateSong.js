const { inngest } = require('../client');
const { NonRetriableError } = require('inngest');
const { supaFetch } = require('../../lib/supabase');
const { generateLyricsWithGPT } = require('../../lib/openai');
const { createPreviewFromUrl, SELF_URL } = require('../../lib/audio');
const { getClient, resetClient } = require('../../lib/suno');
// Provider abstrato: tenta sunoapi.org primeiro (API paga, V5_5),
// cai pro cookie (SunoClient) em erros recuperáveis. Veja lib/sunoProvider.js
// pra política completa (env SUNO_PROVIDER: api | cookie | auto).
const sunoProvider = require('../../lib/sunoProvider');
const axios = require('axios');

// ═══ N8N como hub central de notificações ═══
// Backend chama webhook do N8N que decide o que fazer (WhatsApp, dedup, logs)
const N8N_ALERT_WEBHOOK = process.env.N8N_ALERT_WEBHOOK || 'https://n8ntech.linkarbox.app/webhook/system-alert';

async function notifyN8N(event, payload) {
  try {
    const resp = await axios.post(N8N_ALERT_WEBHOOK, {
      event,                              // 'cookie_expired' | 'cookie_renewed' | 'order_failed'
      timestamp: new Date().toISOString(),
      ...payload,
    }, { timeout: 5000 });
    console.log(`[N8N notify] ✅ ${event}: ${resp.status}`);
    return true;
  } catch (e) {
    console.error(`[N8N notify] ❌ ${event}:`, e.message);
    return false;
  }
}

// =====================================================
// generateSong — Função durável Inngest (v2 — produção)
//
// Correções aplicadas vs v1:
//   1. Imports de lib/ (sem dependência circular)
//   2. idempotency por orderId (previne duplicação)
//   3. NonRetriableError pra 422 Suno (moderação)
//   4. onFailure → marca failed no Supabase
//   5. Polling com backoff (20 tentativas, ~10 min)
//   6. Output slim dos clips (sem blobs)
//   7. Event name: song/ (domínio-agnóstico)
// =====================================================

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Concorrência adaptativa ao provider de geração:
//   • cookie scraping: máx 2 — o Suno detecta padrão de bot e bloqueia
//     se passamos disso. Por isso o limite herdado historicamente.
//   • sunoapi.org    : máx 10 — API oficial paga, aguenta 20 req/10s.
//     Mais paralelismo significa esvaziar fila de pico (Dia das Mães etc.)
//     muito mais rápido.
//   • auto (default) : assume API por padrão (limite alto), porque o fallback
//     pro cookie é raro e o portão de fila no início do step ainda controla
//     em caso de runtime fallback.
// Override explícito disponível via SUNO_CONCURRENCY_LIMIT.
const _SUNO_POLICY = String(process.env.SUNO_PROVIDER || 'auto').toLowerCase();
const SUNO_CONCURRENCY_LIMIT = parseInt(
  process.env.SUNO_CONCURRENCY_LIMIT
    || (_SUNO_POLICY === 'cookie' ? '2' : '10'),
  10,
);

const generateSong = inngest.createFunction(
  {
    id: 'generate-song',
    // 10 retries (default era 3): cobre janela de ~30min com backoff exponencial.
    // Sobrevive a restart do container (~30s downtime no deploy normal) sem
    // matar jobs em vôo. Cada step.run individual tambem se beneficia.
    retries: 10,
    concurrency: [
      { limit: SUNO_CONCURRENCY_LIMIT },           // 10 com API, 2 com cookie
      { limit: 1, key: 'event.data.orderId' },     // 1 job por order (anti-duplicação reforçada)
    ],
    // Idempotency inclui retryAttempt: cada retry é tratado como job NOVO
    // Sem isso, /api/regenerate seria ignorado pelo Inngest (mesmo orderId em 24h)
    idempotency: 'event.data.orderId + ":" + string(has(event.data.retryAttempt) ? event.data.retryAttempt : 0)',
    onFailure: async ({ event, error }) => {
      // Estado terminal: se TODOS os retries esgotarem, marca failed no Supabase
      // ⚠️ MAS antes verifica o status atual — NUNCA regredir preview_sent/paid/delivered
      const orderId = event?.data?.event?.data?.orderId;
      if (!orderId) return;

      console.error(`[Inngest/onFailure] ❌ Retries esgotados para order=${orderId}: ${error.message}`);

      // Verificar status atual antes de regredir
      const current = await supaFetch('GET', `orders?id=eq.${orderId}&select=status`);
      const currentStatus = current?.[0]?.status;

      if (['preview_sent', 'paid', 'delivered'].includes(currentStatus)) {
        // Música já foi entregue — NÃO regride pra failed, apenas registra o erro
        console.log(`[Inngest/onFailure] ⚠️ Status atual='${currentStatus}' — NÃO regredindo pra failed`);
        await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
          error_message: `[NÃO-FATAL pós-${currentStatus}] Inngest: ${error.message}`,
        });
      } else {
        // Realmente falhou antes de entregar
        await supaFetch('PATCH', `orders?id=eq.${orderId}`, {
          status: 'failed',
          error_message: `Inngest: ${error.message}`,
        });
      }
    },
  },
  { event: 'song/generate.requested' },
  async ({ event, step }) => {
    const d = event.data;
    const hasStory = d.story && d.story.trim().length > 10;

    console.log(`[Inngest] 🎬 Iniciando geração para ${d.honoreeName || 'N/A'} (order: ${d.orderId || 'sem'})`);

    // ═══ EARLY-EXIT: status final/cancelled — pula sem chamar GPT/SUNOAPI ═══
    // CRITICO: protege de drenagem de creditos quando admin cancela em massa
    // (ex: regenerate em batch acidental). Verificado ANTES de qualquer custo.
    if (d.orderId) {
      const cur = await step.run('check-cancelled-early', async () => {
        const rows = await supaFetch('GET', `orders?id=eq.${d.orderId}&select=status`);
        return rows?.[0]?.status || null;
      });
      if (['cancelled', 'preview_sent', 'paid', 'delivered'].includes(cur)) {
        console.log(`[Inngest] ⏭️ order=${d.orderId} ja em status=${cur} — early-exit (sem custo SUNOAPI)`);
        return { ok: true, skipped: true, reason: `status_${cur}` };
      }
    }

    // ═══ STEP 1: GPT gera letra ═══
    const lyrics = await step.run('gpt-generate-lyrics', async () => {
      if (!hasStory || !OPENAI_API_KEY) {
        console.log('[Inngest] Pulando GPT (sem história ou sem API key)');
        return d.prompt || d.story || null;
      }

      console.log(`[Inngest] 📝 Gerando letra via GPT para ${d.honoreeName || 'alguem'}...`);
      const generatedLyrics = await generateLyricsWithGPT(d.story, {
        honoreeName: d.honoreeName,
        relationship: d.relationship,
        occasion: d.occasion,
        genre: d.genre,
        mood: d.mood,
        voice: d.voice,
      });

      // Salvar lyrics no Supabase
      if (d.orderId && generatedLyrics) {
        await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
          status: 'generating',
          final_lyrics: generatedLyrics,
        });
      }

      return generatedLyrics;
    });

    // ═══ PORTÃO DE FILA — máx N músicas ATIVAS no Suno (refill ao terminar) ═══
    // O concurrency:N do Inngest NÃO segura "in-flight": o polling usa step.sleep, que libera
    // a vaga (Inngest não conta runs dormindo). Este portão segura de verdade: antes de submeter,
    // espera até haver < N músicas ATIVAS. "Ativa" = já submeteu (suno_clip_ids != null) e ainda
    // sem prévia. Quem está esperando na fila NÃO tem clip_ids → não conta um ao outro (sem
    // deadlock). Janela recente + teto de tentativas evita travar pra sempre. fail-open.
    //
    // Default adaptativo igual ao concurrency do Inngest:
    //   cookie → 2 (anti-bot do Suno);  api/auto → 10 (sunoapi.org aguenta 20 req/10s).
    // Override via env SUNO_GATE_MAX se quiser ajustar runtime.
    {
      const GATE_MAX = parseInt(
        process.env.SUNO_GATE_MAX || (_SUNO_POLICY === 'cookie' ? '2' : '10'),
        10,
      );
      const GATE_TRIES = parseInt(process.env.SUNO_GATE_TRIES || '40', 10);       // 40 x 30s = 20min teto
      const GATE_WIN_MIN = parseInt(process.env.SUNO_GATE_WINDOW_MIN || '30', 10); // ignora presos > 30min
      for (let g = 0; g < GATE_TRIES; g++) {
        const ativas = await step.run(`gate-check-${g}`, async () => {
          try {
            const since = new Date(Date.now() - GATE_WIN_MIN * 60 * 1000).toISOString();
            const rows = await supaFetch('GET',
              `orders?status=in.(generating,producing)&suno_clip_ids=not.is.null&preview_audio_url=is.null&created_at=gte.${since}&id=neq.${d.orderId}&select=id`);
            return Array.isArray(rows) ? rows.length : 0;
          } catch (e) { return 0; } // erro de leitura NÃO bloqueia a geração
        });
        if (ativas < GATE_MAX) break;
        console.log(`[Inngest] 🚦 Portão: ${ativas} ativa(s) no Suno (>= ${GATE_MAX}) — order ${d.orderId} aguardando vaga (tentativa ${g + 1}/${GATE_TRIES})`);
        await step.sleep(`gate-wait-${g}`, '30s');
      }
    }

    // ═══ STEP 2: Suno gera clips (SEM esperar — retorno imediato) ═══
    //
    // sunoProvider abstrai a escolha entre 2 backends:
    //   • api    — sunoapi.org (REST oficial, modelo V5_5, créditos $$)
    //   • cookie — SunoClient (scraping autenticado por cookie, comportamento legacy)
    //
    // Política via env SUNO_PROVIDER (api | cookie | auto). Default 'auto' tenta
    // a API primeiro e cai pro cookie em erros recuperáveis (sem chave, sem
    // créditos, 5xx, timeout). Pra erros NÃO-recuperáveis (400/422 moderation),
    // o erro propaga normalmente e cai no handler abaixo.
    //
    // Retorno do step (SLIM, evita 4MB limit): { provider, taskId?, clipIds? }
    let submitRef;
    try {
      submitRef = await step.run('suno-start-generation', async () => {
        const finalPrompt = lyrics || d.prompt || '';
        const finalTitle = d.title || (d.honoreeName ? `Para ${d.honoreeName}` : 'Sua Musica');
        const finalStyle = d.tags || d.genre || '';
        const finalInstrumental = !!d.make_instrumental;
        console.log(`[Inngest] 🎵 Iniciando geração para ${d.honoreeName || 'N/A'} (provider policy: ${sunoProvider.POLICY})...`);

        // Args completos pro fallback via SunoClient (caminho legacy preservado)
        const fallbackArgs = {
          prompt: finalPrompt,
          tags: finalStyle,
          title: finalTitle,
          model: d.model,
          make_instrumental: finalInstrumental,
          negative_tags: d.negative_tags,
          vocal_gender: d.vocal_gender || (/masculin|\bmale\b|homem/i.test(d.voice || '') ? 'male' : /feminin|female|mulher/i.test(d.voice || '') ? 'female' : undefined),
          wait_audio: false,
        };

        // Normaliza voz: o quiz manda "Masculino"/"Feminino"/"male"/"female"/etc.
        // sunoapi.org aceita só 'm' | 'f'. Detecção carinhosa.
        const voiceRaw = d.vocal_gender || d.voice || '';
        const vocalGender = /^m$|masculin|\bmale\b|homem/i.test(voiceRaw) ? 'm'
                          : /^f$|feminin|female|mulher/i.test(voiceRaw) ? 'f'
                          : undefined;

        let result;
        try {
          result = await sunoProvider.submit({
            prompt: finalPrompt,
            style: finalStyle,
            title: finalTitle,
            instrumental: finalInstrumental,
            vocalGender,
            negativeTags: d.negative_tags || undefined,
            fallbackArgs,
          });
        } catch (err) {
          const status = err.response?.status;
          const errorType = err.response?.data?.error_type || err.response?.data?.detail || '';

          // 422 cookie expirado → marcar pra função-level handler
          if (status === 422 && /token_validation|session|auth/i.test(errorType)) {
            const cookieErr = new Error(`SUNO_COOKIE_EXPIRED:${errorType}`);
            cookieErr.cause = err;
            throw cookieErr;
          }
          // 422 moderation → não retentar
          if (status === 422) {
            throw new NonRetriableError(`Suno rejeitou (422): ${errorType}`, { cause: err });
          }
          // 400 → não retentar
          if (status === 400) {
            throw new NonRetriableError(`Suno bad request (400): ${err.message}`, { cause: err });
          }
          // 429 rate-limit / anti-bot → MESMO tratamento do cookie: PARA + alerta admin.
          if (status === 429) {
            const rlErr = new Error('SUNO_COOKIE_EXPIRED:429_rate_limit');
            rlErr.cause = err;
            throw rlErr;
          }
          // 5xx, timeout → retry normal
          throw err;
        }

        if (result.provider === 'api') {
          console.log(`[Inngest] ✅ submit via API (taskId=${result.taskId}, model=${result.model})`);
        } else {
          console.log(`[Inngest] ✅ submit via cookie (clips=${result.clipIds.join(', ')})`);
        }

        if (d.orderId) {
          const patch = {
            status: 'generating',
            suno_provider: result.provider,
          };
          if (result.provider === 'api') patch.suno_task_id = result.taskId;
          else patch.suno_clip_ids = result.clipIds;
          await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, patch);
        }

        // SLIM return — provider + identificador específico
        return {
          provider: result.provider,
          taskId: result.taskId || null,
          clipIds: result.clipIds || null,
        };
      });
    } catch (stepErr) {
      // ═══ Cookie expired handler — PARA de tentar + ALERTA ADMIN IMEDIATO ═══
      // Decisão do dono: cookie/anti-bot exige renovação MANUAL (logar no Suno + criar 1 música).
      // Retentar sozinho só martela o Suno e prolonga o flag. Então: avisa o admin na hora e PARA.
      if (stepErr.message && stepErr.message.startsWith('SUNO_COOKIE_EXPIRED')) {
        console.warn(`[Inngest] 🚨 Cookie Suno caiu! PARANDO retries + alertando admin...`);
        resetClient();

        // Marca order pra recuperação (onFailure marca 'failed'; retryStuck/admin re-dispara após renovar)
        if (d.orderId) {
          await step.run('mark-awaiting-retry', async () => {
            await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
              status: 'awaiting_retry',
              error_message: '[awaiting_retry] Suno anti-bot/cookie — PARADO, aguardando renovação manual do cookie',
            });
          });
        }

        // ALERTA ADMIN IMEDIATO via WhatsApp — dedup 20min (5 pedidos falhando = 1 alerta só)
        await step.run('alert-admin-cookie-stop', async () => {
          try {
            const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511920188319';
            const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
            const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
            const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
            const SUPA = process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1';
            const SKEY = process.env.SUPABASE_KEY || '';
            const prev = await supaFetch('GET', `system_control?key=eq.cookie_alert_last&select=value`);
            const lastMs = (Array.isArray(prev) && prev[0] && prev[0].value) ? parseInt(prev[0].value, 10) : 0;
            const nowMs = Date.now();
            if (nowMs - lastMs < 20 * 60 * 1000) { console.log('[Inngest] alerta cookie admin já enviado <20min — dedup'); return; }
            const _motivo = /429/.test(stepErr.message || '') ? 'limite/anti-bot (429)' : 'cookie/anti-bot';
            const msg = '🚨 *SUNO BLOQUEOU A GERAÇÃO!*\n\n' +
              'A geração de músicas *PAROU* (' + _motivo + '). Pedidos novos vão ficar aguardando.\n\n' +
              '👉 *Entra no Suno agora e cria 1 música* pra renovar/esfriar a sessão.\n' +
              'Quando voltar, me chama aqui que eu re-disparo os pedidos travados na hora! 💜\n\n' +
              '_(pedido afetado: ' + (d.honoreeName || '?') + ')_';
            await axios.post(EVO_URL + '/message/sendText/' + EVO_INSTANCE,
              { number: ADMIN_PHONE, text: msg },
              { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 6000 });
            if (SKEY) await axios.post(SUPA + '/system_control',
              { key: 'cookie_alert_last', value: String(nowMs), updated_by: 'generateSong' },
              { headers: { apikey: SKEY, Authorization: 'Bearer ' + SKEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 6000 });
            console.log('[Inngest] 🚨 Alerta cookie enviado pro admin + dedup gravado');
          } catch (e) { console.error('[Inngest] alerta admin cookie falhou (não-blocking):', e.message); }
        });

        // Notifica N8N também (logs/dedup do fluxo existente)
        await step.run('notify-n8n-cookie-expired', async () => {
          await notifyN8N('cookie_expired', { orderId: d.orderId, honoreeName: d.honoreeName, phone: d.phone, error: stepErr.message });
        });

        // PARA — NonRetriableError não martela o Suno. Recuperação = renovar cookie + re-disparar.
        throw new NonRetriableError('Cookie/anti-bot Suno — PARADO, admin alertado, aguardando renovação manual');
      }
      // Outros erros: bubble up normalmente
      throw stepErr;
    }

    // ═══ Cookie-renewed detector — N8N decide se manda ═══
    // Se houve recente alerta de cookie expired, notifica N8N pra mandar "voltou"
    await step.run('check-cookie-renewed', async () => {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const recentAlerts = await supaFetch('GET',
        `funnel_events?event_type=eq.cookie_expired_alert&created_at=gte.${thirtyMinAgo}&order=created_at.desc&limit=1`
      );
      if (!recentAlerts || recentAlerts.length === 0) return { skipped: true };

      // Notifica N8N — dedup do "renovado" fica no N8N
      await notifyN8N('cookie_renewed', {
        orderId: d.orderId,
        honoreeName: d.honoreeName,
        alert_time: recentAlerts[0].created_at,
      });
      return { notified: true };
    });

    // ═══ STEP 3: Polling durável dos clips (3 fases progressivas) ═══
    // Phase 1 (fast):   36 attempts × ~30s   = ~15 min  (95% dos casos resolvem aqui)
    // Phase 2 (medium): 10 attempts × ~3 min = ~30 min  (Suno lento — não regenera, só espera)
    // Phase 3 (slow):    5 attempts × ~15min = ~75 min  (último recurso)
    // Total max wait: ~2h antes de desistir
    //
    // Lógica: Inngest "congela" o job durante step.sleep — zero CPU/memória.
    // Cliente fica esperando mas SEM gastar créditos Suno extras.
    let completedClips = null;
    const POLL_ATTEMPTS = 51;  // 36 fast + 10 medium + 5 slow
    const PHASE_BOUNDARY_MEDIUM = 36;
    const PHASE_BOUNDARY_SLOW = 46;
    // Anti-drenagem: a SUNOAPI esta voltando GENERATE_AUDIO_FAILED com "Internal Error"
    // em ~5-7% das tasks. Em vez de esperar 2h e desistir, detectamos e
    // re-submetemos UMA vez automatico (max 2 submissoes totais por order).
    //
    // FIX 13/jun/2026: contador agora persistido em audio_retry_count na orders.
    // Antes era variavel local — toda re-execucao do Inngest function zerava o
    // contador e re-submetia mais uma vez, desperdiçando ~10 creditos por loop.
    // Caso Deise/Pedro&Joaquim: ~70 creditos perdidos em ~7 re-execucoes.
    const MAX_AUDIO_RETRIES = 1;

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      // Wait progressivo: fast → medium → slow
      if (attempt > 0) {
        let waitSecs;
        if (attempt < 3)                      waitSecs = `${15 + attempt * 5}s`;  // 20s, 25s, 30s
        else if (attempt < PHASE_BOUNDARY_MEDIUM) waitSecs = '30s';               // Phase 1: 30s × 33 = ~16 min
        else if (attempt < PHASE_BOUNDARY_SLOW)   waitSecs = '3m';                // Phase 2: 3min × 10 = 30 min
        else                                      waitSecs = '15m';               // Phase 3: 15min × 5 = 75 min
        await step.sleep(`wait-clips-${attempt}`, waitSecs);
      }

      // Marcar transição de fase no Supabase (pra dashboard/alertas)
      if (attempt === PHASE_BOUNDARY_MEDIUM && d.orderId) {
        await step.run('mark-phase-medium', async () => {
          console.log(`[Inngest] ⏰ Entrando Phase 2 (medium, ~30 min) após Phase 1 timeout`);
          await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
            error_message: '[Phase 2] Suno lento — aguardando mais 30min antes de desistir',
          });
        });
      }
      if (attempt === PHASE_BOUNDARY_SLOW && d.orderId) {
        await step.run('mark-phase-slow', async () => {
          console.log(`[Inngest] ⏰ Entrando Phase 3 (slow, ~75 min) — última tentativa`);
          await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
            error_message: '[Phase 3] Suno muito lento — última tentativa (~75 min)',
          });
        });
      }

      // Poll: checa status via provider (api ou cookie). Output SLIM normalizado.
      // sunoProvider.getStatus retorna { status, tracks, allDone, anyComplete }
      // — anyComplete já vem mapeado pra evitar passar pelos tracks de novo.
      const pollResult = await step.run(`poll-clips-${attempt}`, async () => {
        const s = await sunoProvider.getStatus({
          provider: submitRef.provider,
          taskId: submitRef.taskId,
          clipIds: submitRef.clipIds,
        });
        const statuses = s.tracks.map((c) => `${(c.id || '').slice(0, 8)}: ${c.status}`).join(', ');
        const phase = attempt < PHASE_BOUNDARY_MEDIUM ? 'fast'
                    : attempt < PHASE_BOUNDARY_SLOW ? 'medium' : 'slow';
        console.log(`[Inngest] ⏳ Poll ${attempt + 1}/${POLL_ATTEMPTS} (${phase}, via ${submitRef.provider}) [${s.status}]: ${statuses}`);
        return { tracks: s.tracks, globalStatus: s.status };
      });
      const polledClips = pollResult.tracks;

      // ═══ AUTO-RETRY em GENERATE_AUDIO_FAILED (contador persistido) ═══
      // SUNOAPI falha intermitentemente com "Internal Error". Em vez de esperar 2h,
      // re-submetemos automatico (max MAX_AUDIO_RETRIES vezes) e continuamos o
      // polling no taskId novo. Contador no DB pra durar entre re-execucoes do
      // Inngest function (cada re-execucao zerava o contador local antes).
      if (pollResult.globalStatus === 'FAILED' && submitRef.provider === 'api') {
        const retryCheck = await step.run(`audio-retry-check-${attempt}`, async () => {
          if (!d.orderId) return { allowed: false, exhausted: false, current: 0 };
          const rows = await supaFetch('GET', `orders?id=eq.${d.orderId}&select=audio_retry_count`);
          const current = (Array.isArray(rows) && rows[0] && rows[0].audio_retry_count) || 0;
          if (current >= MAX_AUDIO_RETRIES) {
            // Esgotado — marca como failed e sai do loop.
            await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
              status: 'generation_failed',
              error_message: `[generation_failed] SUNOAPI FAILED apos ${current + 1} tentativas — intervencao manual necessaria (/api/regenerate)`,
            });
            return { allowed: false, exhausted: true, current };
          }
          // Incrementa ANTES de submeter pra evitar duplicacao em re-execucao.
          await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
            audio_retry_count: current + 1,
          });
          return { allowed: true, exhausted: false, current: current + 1 };
        });

        if (retryCheck.exhausted) {
          console.log(`[Inngest] ❌ Auto-resubmit esgotado p/ order ${d.orderId} — parando (${retryCheck.current}/${MAX_AUDIO_RETRIES})`);
          throw new NonRetriableError(`SUNOAPI FAILED esgotado apos ${MAX_AUDIO_RETRIES + 1} tentativas — order marcada generation_failed`);
        }

        if (retryCheck.allowed) {
          console.log(`[Inngest] 🔄 SUNOAPI retornou FAILED — auto-resubmit ${retryCheck.current}/${MAX_AUDIO_RETRIES}`);
          const newSubmit = await step.run(`auto-resubmit-${retryCheck.current}`, async () => {
            const result = await sunoProvider.submit({
              prompt: finalPrompt,
              style: finalStyle,
              title: finalTitle,
              instrumental: finalInstrumental,
              vocalGender,
              negativeTags: d.negative_tags || undefined,
              fallbackArgs,
            });
            if (d.orderId && result.provider === 'api') {
              await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
                suno_task_id: result.taskId,
                error_message: `[auto-resubmit ${retryCheck.current}] SUNOAPI Internal Error — taskId novo: ${result.taskId.slice(0,12)}`,
              });
            }
            return result;
          });
          submitRef.taskId = newSubmit.taskId;
          submitRef.clipIds = newSubmit.clipIds;
          submitRef.provider = newSubmit.provider;
          continue;
        }
      }

      // CUIDADO com vacuous truth: array vazio satisfaz .every(...) automaticamente.
      // Em PENDING/GENERATING via sunoapi.org, response.data ainda pode ser []
      // antes do "first" callback. Sem o guard de length, sairíamos do loop achando
      // que "todos terminaram" quando na verdade ninguém começou.
      const allDone = polledClips.length > 0 && polledClips.every(c => c.status === 'complete' || c.status === 'error');
      if (allDone) {
        completedClips = polledClips;
        console.log('[Inngest] ✅ Todos os clips prontos!');
        break;
      }

      // ═══ DETECTOR DE OUTAGE DO SUNO ═══
      // Clips presos em 'submitted' por vários minutos = Suno aceitou mas NÃO está processando
      // (instabilidade/outage do Suno, não é nosso sistema). Alerta o admin UMA vez (dedup 20min)
      // e NÃO para o poll: quando o Suno voltar, o próprio poll recupera sozinho (auto-cura, ~2h).
      if (attempt === parseInt(process.env.SUNO_OUTAGE_ALERT_ATTEMPT || '10', 10)
          && polledClips.length && polledClips.every(c => c.status === 'submitted')) {
        await step.run(`alert-suno-outage-${attempt}`, async () => {
          try {
            const SUPA = process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1';
            const SKEY = process.env.SUPABASE_KEY || '';
            const prev = await supaFetch('GET', `system_control?key=eq.suno_outage_alert_last&select=value`);
            const lastMs = (Array.isArray(prev) && prev[0] && prev[0].value) ? parseInt(prev[0].value, 10) : 0;
            const nowMs = Date.now();
            if (nowMs - lastMs < 20 * 60 * 1000) { console.log('[Inngest] alerta outage já enviado <20min — dedup'); return; }
            const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511920188319';
            const EVO_URL = process.env.EVO_URL || 'https://evolutiontechv2.linkarbox.app';
            const EVO_KEY = process.env.EVO_KEY || 'klRvAffSJYcPDPYCFIMQXRrcBqNztk';
            const EVO_INSTANCE = process.env.EVO_INSTANCE || 'app_suno_teste';
            const msg = '🔴 *SUNO FORA DO AR?*\n\n' +
              'As músicas estão presas em "submitted" há vários minutos — o Suno aceitou mas *não está processando*. Provável instabilidade do Suno (não é o nosso sistema).\n\n' +
              '✅ Os pedidos *auto-recuperam* sozinhos quando o Suno voltar (em até ~2h). Se demorar muito, me manda *TRAVADOS* depois que o Suno voltar que eu re-disparo os que falharem.';
            await axios.post(EVO_URL + '/message/sendText/' + EVO_INSTANCE, { number: ADMIN_PHONE, text: msg }, { headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, timeout: 6000 });
            if (SKEY) await axios.post(SUPA + '/system_control', { key: 'suno_outage_alert_last', value: String(nowMs), updated_by: 'generateSong' }, { headers: { apikey: SKEY, Authorization: 'Bearer ' + SKEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 6000 });
            console.log('[Inngest] 🔴 Alerta de OUTAGE do Suno enviado pro admin');
          } catch (e) { console.error('[Inngest] alerta outage falhou (não-blocking):', e.message); }
        });
      }

      // Se pelo menos 1 clip completou, usar ele
      // Phase 1: aguarda até attempt 12 (~5 min) antes de aceitar partial
      // Phase 2+: aceita partial imediatamente (já esperamos bastante)
      const anyComplete = polledClips.find(c => c.status === 'complete' && c.audio_url);
      if (anyComplete && (attempt >= 12 || attempt >= PHASE_BOUNDARY_MEDIUM)) {
        completedClips = polledClips;
        console.log(`[Inngest] ⚡ Clip pronto após attempt ${attempt + 1}, seguindo com partial`);
        break;
      }
    }

    // Timeout após ~2h — REALMENTE desistir
    if (!completedClips) {
      console.error(`[Inngest] ❌ Timeout TOTAL após ${POLL_ATTEMPTS} tentativas (~2h)`);
      // Último poll pra pegar status final pra log (via provider)
      const lastPoll = await step.run('poll-clips-final', async () => {
        const s = await sunoProvider.getStatus({
          provider: submitRef.provider,
          taskId: submitRef.taskId,
          clipIds: submitRef.clipIds,
        });
        return s.tracks;
      });
      // Última chance — checar se algo completou nesse poll final
      const anyReady = lastPoll.find(c => c.status === 'complete' && c.audio_url);
      if (anyReady) {
        completedClips = lastPoll;
        console.log('[Inngest] ⚡ Clip encontrado no poll final após 2h!');
      } else {
        throw new Error(`Suno não completou após ${POLL_ATTEMPTS} tentativas (~2h em 3 fases). Status: ${lastPoll.map(c => c.status).join(', ')}`);
      }
    }

    const bestClip = completedClips.find(c => c.status === 'complete') || completedClips[0];
    if (!bestClip || !bestClip.audio_url) {
      // Suno gerou mas todos com erro — non-retriable
      const errorMsgs = completedClips.map(c => `${c.id.slice(0,8)}: ${c.status}`).join(', ');
      throw new NonRetriableError(`Nenhum clip gerado com sucesso: ${errorMsgs}`);
    }

    // Salvar audio original no Supabase
    if (d.orderId) {
      await step.run('save-original', async () => {
        await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
          status: 'generating',
          original_audio_url: bestClip.audio_url,
          suno_clip_ids: completedClips.map(c => c.id),
          full_audio_urls: completedClips.map(c => c.audio_url).filter(Boolean),
          final_lyrics: lyrics || null,
        });
        console.log(`[Inngest] ✅ Original salvo: ${bestClip.audio_url.substring(0, 60)}...`);
      });
    }

    // ═══ STEP 4: Audio-Edit preview ═══
    const previewUrl = await step.run('audio-edit-preview', async () => {
      const songTitle = bestClip.title || d.title || (d.honoreeName ? `Para ${d.honoreeName}` : 'Musica');
      const preview = await createPreviewFromUrl(bestClip.audio_url, d.orderId || undefined, songTitle);
      // NÃO grava no Storage (prévia é descartável). A rota /api/preview AUTO-CURA:
      // se o arquivo sumir (redeploy), regenera na hora do link permanente da Suno.
      const url = `${SELF_URL}/api/preview/${encodeURIComponent(preview.previewFilename)}`;
      console.log(`[Inngest/Preview] ✅ Preview: ${url}`);
      return url;
    });

    // ═══ STEP 5: Atualizar Supabase → preview_sent ═══
    await step.run('supabase-mark-preview-sent', async () => {
      if (!d.orderId) return;
      // ANTI-DUPLICATA: se o pedido foi CANCELADO/supersedido enquanto a run rodava
      // (ex: re-disparo manual criou outro pedido p/ o mesmo cliente), NÃO entrega.
      try {
        const cur = await supaFetch('GET', `orders?id=eq.${d.orderId}&select=status`);
        if (cur && cur[0] && cur[0].status === 'cancelled') {
          console.log(`[Inngest] ⏭️ order=${d.orderId} cancelado — pulando entrega (anti-duplicata)`);
          return { skipped: 'cancelled' };
        }
        // 'cancelled' é status inválido na constraint — o cancelamento real marca o
        // marker autosend_<id>='cancelled'. Se for o caso, NÃO marca preview_sent.
        const _asC = await supaFetch('GET', `system_control?key=eq.autosend_${d.orderId}&select=value`);
        if (_asC && _asC[0] && _asC[0].value === 'cancelled') {
          console.log(`[Inngest] ⏭️ order=${d.orderId} autosend=cancelled — pulando entrega (anti-duplicata)`);
          return { skipped: 'autosend_cancelled' };
        }
      } catch (e) {}
      await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
        status: 'preview_sent',
        preview_audio_url: previewUrl,
        error_message: null, // limpa erros anteriores
      });
      console.log(`[Inngest] ✅ preview_sent! order=${d.orderId}`);

      // PRE-GERA o video karaoke COM A CAPA DO SUNO logo apos a musica ficar
      // pronta. Antes esperava o pagamento (R$29,90) pra so entao gerar -
      // e o cliente esperava ~3min depois de pagar. Agora ja deixa pronto e
      // armazenado em video_brinde_url. Quando paga, libera INSTANTANEO.
      // Fire-and-forget: nunca propaga erro pro Inngest.
      try {
        const { generateBrindeForOrder } = require('../../lib/brindeVideo');
        generateBrindeForOrder(d.orderId, bestClip.image_url || '').catch((e) =>
          console.error(`[Inngest] pre-gerar video falhou (NAO-FATAL):`, e.message));
      } catch (e) {
        console.error(`[Inngest] require brindeVideo falhou (NAO-FATAL):`, e.message);
      }
    });

    // ═══ STEP 6 (condicional): Webhook N8N — NÃO-BLOQUEANTE + gate Meta-safe ═══
    // CRÍTICO: só envia WhatsApp se cliente JÁ contactou Bia (janela 24h aberta)
    // Senão marca pending_delivery=true — N8N entrega quando cliente mandar msg
    if (N8N_WEBHOOK_URL && d.phone && d.orderId) {
      await step.run('n8n-webhook-with-gate', async () => {
        // 1. Verificar se cliente já contactou Bia (client_contacted_at preenchido)
        let canDeliver = false;
        // ANTI-DUPLICATA REGEN: pedidos do regenPreview têm marker autosend_<id> e a
        // entrega deles é feita pelo CRON regenPreview. Se o marker existe, NÃO entrega
        // pelo webhook n8n — senão a prévia vai 2x (cron + webhook). Cobre tbm cancelados
        // (autosend=cancelled): o cron pula 'cancelled' e aqui o webhook também.
        try {
          const _asW = await supaFetch('GET', `system_control?key=eq.autosend_${d.orderId}&select=value`);
          if (_asW && _asW[0] && _asW[0].value) {
            console.log(`[Inngest] ⏭️ order=${d.orderId} autosend=${_asW[0].value} — entrega pelo cron regen, pulando webhook (anti-duplicata)`);
            return { sent: false, reason: 'managed_by_regen_cron' };
          }
        } catch (e) {}
        try {
          const orders = await supaFetch('GET',
            `orders?id=eq.${d.orderId}&select=client_contacted_at,phone,status`
          );
          // ANTI-DUPLICATA: pedido cancelado/supersedido não entrega (evita prévia dupla)
          if (orders && orders[0] && orders[0].status === 'cancelled') {
            console.log(`[Inngest] ⏭️ order=${d.orderId} cancelado — não entrega webhook (anti-duplicata)`);
            return { sent: false, reason: 'cancelled' };
          }
          if (orders && orders[0] && orders[0].client_contacted_at) {
            canDeliver = true;
            console.log(`[Inngest] ✅ Cliente já contactou — pode entregar`);
          }
        } catch (e) {
          console.error('[Inngest] ⚠️ Erro ao verificar client_contacted_at:', e.message);
        }

        // 2. Se NÃO pode entregar → marca pending_delivery e sai
        if (!canDeliver) {
          console.log(`[Inngest] 🕊️ Cliente NÃO contactou ainda — marcando pending_delivery=true`);
          await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
            pending_delivery: true,
          });
          return { sent: false, reason: 'awaiting_client_contact', pending_delivery: true };
        }

        // 3. Pode entregar → chama webhook N8N normalmente
        console.log(`[Inngest] 📡 Chamando webhook N8N para ${d.phone}...`);
        try {
          await axios.post(N8N_WEBHOOK_URL, {
            phone: d.phone,
            orderId: d.orderId,
            audio_url: bestClip.audio_url,
            title: bestClip.title || d.title || 'Sua Musica',
            tags: bestClip.tags || d.tags || '',
            duration: bestClip.duration || '',
            image_url: bestClip.image_url || '',
            lyrics: lyrics || '',
          }, { timeout: 30000 });
          // Limpa pending_delivery se estava marcado
          await supaFetch('PATCH', `orders?id=eq.${d.orderId}`, {
            pending_delivery: false,
          });
          console.log(`[Inngest] ✅ Webhook N8N enviado!`);
          return { sent: true };
        } catch (webhookErr) {
          // NUNCA propagar — música já entregue no Supabase, webhook é só notificação
          console.error(`[Inngest] ⚠️ Webhook N8N falhou (NÃO-FATAL): ${webhookErr.message}`);
          return { sent: false, error: webhookErr.message };
        }
      });
    }

    // OBS: a ENTREGA da preview no WhatsApp é feita pelo fluxo do n8n (com legenda +
    // follow-up). NÃO entregar aqui no backend pra não enviar a preview EM DOBRO.

    // Refator sunoProvider: as variáveis antigas viraram submitRef.{provider,taskId,clipIds}.
    // Pega o que faz sentido por provider — taskId pra API, clipIds pro cookie.
    const finalClipIds = submitRef.clipIds || (completedClips || []).map((c) => c.id).filter(Boolean);
    console.log(`[Inngest] 🎉 Geração completa! order=${d.orderId} provider=${submitRef.provider} ref=${submitRef.taskId || finalClipIds.join(',')}`);
    return {
      success: true,
      orderId: d.orderId,
      provider: submitRef.provider,
      taskId: submitRef.taskId || null,
      clipIds: finalClipIds,
      previewUrl,
      audioUrl: bestClip.audio_url,
    };
  }
);

module.exports = { generateSong };
