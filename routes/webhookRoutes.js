// webhookRoutes — endpoints chamados por servicos externos via HTTP POST.
//
// Rotas (2):
//   POST /api/webhooks/sunoapi    — sunoapi.org confirma geracao de musica
//   POST /api/webhooks/abacatepay — AbacatePay confirma pagamento PIX
//
// IMPORTANTE:
// - sunoapi: ACK imediato (`res.json({ok:true})` antes de processar) — sunoapi
//   tem timeout curto e retry agressivo. Errado aqui = retry stuck.
// - abacatepay: protegido por secret no header `x-abacatepay-secret` (ou query
//   webhookSecret). Sem match = 401. Ao receber `paid`, dispara cron de brinde
//   + email transacional + Meta CAPI Purchase (todos fire-and-forget).
const express = require('express');
const axios = require('axios');  // axios indireto via lib/, mas mantido pra futuras integracoes

const { supaFetch } = require('../lib/supabase');
const { sendPurchaseToMeta } = require('../lib/metaCapi');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// SUNOAPI WEBHOOK — sunoapi.org notifica quando a musica fica pronta.
// Pelo menos 2 callbacks chegam: 'first' (1o clip pronto, ~30s) e 'complete'
// (todos os clips, ~60-90s). Tambem chega 'error' se a geracao falhar.
// Estrategia: ACK rapido + salvar URLs/clip IDs no DB se tiver tracks no body.
// O Inngest tbm processa em paralelo via polling; este webhook e' atalho/seguranca.
// retry desnecessario do sunoapi.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/api/webhooks/sunoapi', express.json({ limit: '2mb' }), async (req, res) => {
  res.json({ ok: true });  // ack imediato pro sunoapi nao retry
  try {
    const body = req.body || {};
    const taskId = body.data?.task_id || body.data?.taskId || null;
    const callbackType = body.data?.callbackType || 'unknown';
    const code = body.code;
    const tracks = Array.isArray(body.data?.data) ? body.data.data : [];
    console.log(`[sunoapi/webhook] type=${callbackType} code=${code} task=${taskId?.slice(0,12)} tracks=${tracks.length}`);

    if (!taskId) return;

    // Acha o order pelo taskId
    const rows = await supaFetch('GET', `orders?suno_task_id=eq.${taskId}&select=id,status`);
    const o = Array.isArray(rows) && rows[0];
    if (!o) {
      console.warn(`[sunoapi/webhook] taskId ${taskId.slice(0,12)} sem order — ignorando`);
      return;
    }

    // Snapshot de observabilidade no error_message (campo livre pra rastro)
    const snapshot = `[sunoapi/${callbackType}] code=${code} tracks=${tracks.length} t=${new Date().toISOString().slice(0,19)}`;
    const patch = { error_message: snapshot.slice(0, 500) };

    // A PROVA DE FALHAS: se este callback tem tracks com audioUrl OU clip ID,
    // ja salva no DB AGORA. Antes esse handler so fazia observabilidade e
    // dependia do Inngest pra preencher — quando o Inngest falhava em ler o
    // status (Suno API mente FAILED), a order ficava sem URL eternamente.
    //
    // Construir cdn1.suno.ai/{id}.mp3 a partir do clip ID e DETERMINISTICO:
    // sempre funciona se a musica foi de fato gerada (testado historicamente).
    if (tracks.length && (callbackType === 'complete' || callbackType === 'first')) {
      try {
        const { tracksToUrls } = require('../lib/sunoFallback');
        const { urls, ids } = tracksToUrls(tracks);
        if (urls.length) {
          patch.full_audio_urls = urls;
          patch.original_audio_url = urls[0];
        }
        if (ids.length) patch.suno_clip_ids = ids;
        console.log(`[sunoapi/webhook] 💾 ${o.id.slice(0,8)} salvando ${urls.length} URL(s) + ${ids.length} clipId(s)`);
      } catch (e) {
        console.error('[sunoapi/webhook] falha em extrair URLs:', e.message);
      }
    }

    await supaFetch('PATCH', `orders?id=eq.${o.id}`, patch);
  } catch (e) {
    console.error('[sunoapi/webhook] erro (nao-fatal):', e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ABACATEPAY WEBHOOK — confirmacao automatica quando cliente paga via PIX.
//
// Resolucao do orderId (3 fontes, em ordem de preferencia):
//   1) metadata.order_id  (V2 — mais confiavel; SEMPRE vem quando criamos via
//      /api/pay/create porque passamos metadata={order_id, plan})
//   2) externalId no formato "{uuid}-{plan}-{ts}" (legado)
//   3) abacate_charge_id no DB (ultimo recurso — pode falhar se PIX foi
//      renovado e a charge atual difere da salva)
//
// BUG historico corrigido: antes so olhavamos externalId. Quando AbacatePay V2
// manda externalId=null (caso da Maria luana 07/06 — order 7756cae8), o parse
// falhava silenciosamente e a order ficava preview_sent pra sempre, mesmo
// com pagamento confirmado no AbacatePay.
//
// Apos marcar como paid: dispara brinde video + email transacional + Meta CAPI
// Purchase (todos fire-and-forget; cron faz retry se algum falhar).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/api/webhooks/abacatepay', async (req, res) => {
  try {
    const expected = process.env.ABACATEPAY_WEBHOOK_SECRET;
    if (!expected) return res.status(500).json({ error: 'webhook nao configurado' });
    const recv = req.headers['x-abacatepay-secret'] || req.headers['abacatepay-secret'] || req.query.webhookSecret;
    if (recv !== expected) return res.status(401).json({ error: 'unauthorized' });

    const event = req.body?.event;
    const data = req.body?.data;
    console.log('[webhook abacatepay] RAW:', JSON.stringify(req.body));

    if (event === 'transparent.completed' || event === 'checkout.completed' || event === 'billing.paid' || event === 'paid') {
      // AbacatePay manda estrutura variavel — tentamos varias chaves
      const transparent = data?.transparent || data?.checkout || data?.charge || data?.pixQrCode || data;
      const externalId = transparent?.externalId || data?.externalId;
      const paymentId = transparent?.id || data?.id;
      const metadataOrderId = transparent?.metadata?.order_id || data?.metadata?.order_id;
      const m = externalId && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(externalId);
      const orderId = metadataOrderId || m?.[1];
      console.log('[webhook abacatepay] parsed orderId:', orderId, '(src:', metadataOrderId ? 'metadata' : (m ? 'externalId' : 'fallback-paymentId'), ') paymentId:', paymentId);
      const filter = orderId ? `id=eq.${orderId}` : `abacate_charge_id=eq.${paymentId}`;
      const rows = await supaFetch('GET', `orders?${filter}&select=id,status,plan`);
      const o = rows?.[0];
      if (!o) return res.json({ ok: true, found: false });
      if (o.status === 'paid' || o.status === 'delivered') return res.json({ ok: true, already: true });
      await supaFetch('PATCH', `orders?id=eq.${o.id}`, {
        status: 'paid',
        abacate_status: 'PAID',
        paid_at: new Date().toISOString(),
      });
      console.log('[webhook abacatepay] order', o.id, 'PAID plan=', o.plan);
      // Video eh gerado pra QUALQUER plano com includes_video=true
      // (completa, promo_namorados_2026, promo_recovery_jun26, video_letra).
      // Plano musica puro (R$19,90 sem promo) NAO recebe video.
      if (require('../lib/payPlans').isVideoPlan(o.plan)) {
        try { require('../lib/brindeVideo').generateBrindeForOrder(o.id); } catch (_) {}
      }
      // ═══ NOTIFICACAO DE VENDA — WhatsApp pessoal + Pushcut por valor ═══
      // Fire-and-forget. Falha aqui nao bloqueia entrega.
      try { require('../lib/salesNotify').notifySale(o.id); } catch (e) { console.error('[salesNotify] init err:', e.message); }
      // Email transacional de entrega — fire-and-forget. Se falhar aqui, o cron
      // emailDeliveryMonitor pega no proximo tick (a cada 10 min).
      // Carrega dados completos pra o template + lib.
      try {
        const emailRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,honoree_name,customer_name,customer_email,plan,original_audio_url,full_audio_urls,video_brinde_url,email_delivery_sent`);
        const emailOrder = emailRows?.[0];
        if (emailOrder && emailOrder.customer_email && !emailOrder.email_delivery_sent) {
          require('../lib/emailDelivery').sendDeliveryEmail(emailOrder).catch(e => {
            console.error('[webhook abacatepay] email delivery falhou (ignorado, cron tenta de novo):', e.message);
          });
        }
      } catch (e) {
        console.error('[webhook abacatepay] erro ao buscar pra email (ignorado):', e.message);
      }
      // Meta Conversions API (CAPI) — envio server-side garantido, dedup com client-side via event_id
      try {
        let fullRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,customer_name,customer_email,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent,paid_at`);
        // Fallback: se a coluna customer_email ainda nao existir, refaz sem ela
        if (!Array.isArray(fullRows) || !fullRows[0]) {
          fullRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,customer_name,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent,paid_at`);
        }
        const fullOrder = fullRows?.[0];
        if (fullOrder && !fullOrder.meta_capi_sent) {
          const result = await sendPurchaseToMeta(fullOrder);
          if (result?.ok) {
            await supaFetch('PATCH', `orders?id=eq.${o.id}`, { meta_capi_sent: true });
          }
        }
      } catch (e) {
        console.error('[webhook abacatepay] CAPI falhou (ignorado):', e.message);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook abacatepay] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WOOVI (ex-OpenPix) WEBHOOK — confirmação de pagamento PIX.
//
// Woovi manda POST com { event, charge, pix }. Pago = event
// 'OPENPIX:CHARGE_COMPLETED' (e/ou charge.status='COMPLETED'). O orderId é
// extraído do charge.correlationID (formato "{uuid}-{plan}-{ts}" que criamos em
// /api/pay/create). Pós-pagamento roda a MESMA entrega do AbacatePay: vídeo +
// notificação + email transacional + Meta CAPI (tudo fire-and-forget).
//
// Segurança: token na query (?token=…) validado contra WOOVI_WEBHOOK_TOKEN.
// Se o env não estiver setado, aceita mas LOGA aviso (janela de emergência —
// setar o token depois pra fechar). Configure no painel Woovi a URL:
//   https://suno-api-novo.bvph.uk/api/webhooks/woovi?token=SEU_TOKEN
// ═══════════════════════════════════════════════════════════════════════════
router.post('/api/webhooks/woovi', async (req, res) => {
  try {
    const expected = process.env.WOOVI_WEBHOOK_TOKEN;
    if (expected) {
      const recv = req.query.token || req.headers['x-webhook-token'];
      if (recv !== expected) return res.status(401).json({ error: 'unauthorized' });
    } else {
      console.warn('[webhook woovi] WOOVI_WEBHOOK_TOKEN não setado — aceitando sem validar (setar pra fechar)');
    }

    const event = req.body?.event || '';
    const charge = req.body?.charge || {};
    // Woovi manda um POST de teste ao cadastrar o webhook — ACK sem processar.
    if (!event || (!/CHARGE_COMPLETED/i.test(event) && String(charge.status || '').toUpperCase() !== 'COMPLETED')) {
      return res.json({ ok: true, ignored: event || 'no_event' });
    }

    const correlationID = charge.correlationID || req.body?.correlationID || '';
    const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(correlationID);
    const orderId = m?.[1];
    console.log('[webhook woovi]', event, 'correlationID=', correlationID, '→ orderId=', orderId);
    if (!orderId) return res.json({ ok: true, found: false });

    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,status,plan`);
    const o = rows?.[0];
    if (!o) return res.json({ ok: true, found: false });
    if (o.status === 'paid' || o.status === 'delivered') return res.json({ ok: true, already: true });

    await supaFetch('PATCH', `orders?id=eq.${o.id}`, {
      status: 'paid',
      abacate_status: 'PAID',
      paid_at: new Date().toISOString(),
    });
    console.log('[webhook woovi] order', o.id, 'PAID plan=', o.plan);

    // ── mesma entrega do AbacatePay (fire-and-forget) ──
    if (require('../lib/payPlans').isVideoPlan(o.plan)) {
      try { require('../lib/brindeVideo').generateBrindeForOrder(o.id); } catch (_) {}
    }
    try { require('../lib/salesNotify').notifySale(o.id); } catch (e) { console.error('[salesNotify] init err:', e.message); }
    try {
      const emailRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,honoree_name,customer_name,customer_email,plan,original_audio_url,full_audio_urls,video_brinde_url,email_delivery_sent`);
      const emailOrder = emailRows?.[0];
      if (emailOrder && emailOrder.customer_email && !emailOrder.email_delivery_sent) {
        require('../lib/emailDelivery').sendDeliveryEmail(emailOrder).catch(e => console.error('[webhook woovi] email delivery falhou (cron tenta de novo):', e.message));
      }
    } catch (e) { console.error('[webhook woovi] erro ao buscar pra email (ignorado):', e.message); }
    try {
      let fullRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,customer_name,customer_email,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent,paid_at`);
      if (!Array.isArray(fullRows) || !fullRows[0]) {
        fullRows = await supaFetch('GET', `orders?id=eq.${o.id}&select=id,customer_name,phone,payment_amount,plan,fbp_pixel_id,fbp,fbc,client_ip,client_user_agent,meta_capi_sent,paid_at`);
      }
      const fullOrder = fullRows?.[0];
      if (fullOrder && !fullOrder.meta_capi_sent) {
        const result = await sendPurchaseToMeta(fullOrder);
        if (result?.ok) await supaFetch('PATCH', `orders?id=eq.${o.id}`, { meta_capi_sent: true });
      }
    } catch (e) { console.error('[webhook woovi] CAPI falhou (ignorado):', e.message); }

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook woovi] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

// ═══════════════════════════════════════════════════════════════
// WEBHOOK Resend — atualiza promo_campaigns com eventos de email.
//
// Eventos esperados (configurados no painel Resend):
//   email.delivered  → email_delivered_at
//   email.opened     → email_opened_at (uma vez por destinatario; ignoramos repeated)
//   email.clicked    → link_clicked_at (coluna ja existia)
//   email.bounced    → email_bounced_at + email_error
//   email.complained → email_complained_at (red flag: marcou como spam)
//
// Match: cada envio gravou o resend email_id em promo_campaigns.email_status.
// O payload do Resend traz {data.email_id} — buscamos pela coluna email_status.
//
// Idempotente: usa COALESCE no PATCH pra so gravar timestamp se ainda for null.
// Segurança: Resend assina os webhooks com svix-signature; pra simplificar o
// MVP, validamos só presença do email_id + tipo de evento esperado. Se quiser
// hardening, adicionar verificação svix com RESEND_WEBHOOK_SECRET depois.
// ═══════════════════════════════════════════════════════════════
router.post('/api/webhooks/resend', async (req, res) => {
  try {
    const evt = req.body || {};
    const type = evt.type;
    const emailId = evt.data?.email_id;
    const at = evt.created_at ? new Date(evt.created_at).toISOString() : new Date().toISOString();

    if (!type || !emailId) {
      return res.status(200).json({ ok: false, skipped: 'missing_fields' });
    }

    // Mapeia tipo de evento -> coluna a atualizar
    const TYPE_TO_COLUMN = {
      'email.delivered':  'email_delivered_at',
      'email.opened':     'email_opened_at',
      'email.clicked':    'link_clicked_at',
      'email.bounced':    'email_bounced_at',
      'email.complained': 'email_complained_at',
    };
    const col = TYPE_TO_COLUMN[type];
    if (!col) {
      console.log('[webhook resend] tipo ignorado:', type);
      return res.json({ ok: true, ignored: type });
    }

    // Acha o registro de envio pelo email_id (gravado em email_status)
    const rows = await supaFetch('GET',
      `promo_campaigns?email_status=eq.${encodeURIComponent(emailId)}&select=id,${col}`);
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log('[webhook resend] sem match pra email_id:', emailId, 'type:', type);
      return res.json({ ok: true, no_match: true });
    }

    const row = rows[0];
    // Idempotente: nao sobrescreve se ja tem timestamp
    if (row[col]) {
      return res.json({ ok: true, already: true });
    }

    const patch = { [col]: at };
    // Pra bounced/complained, grava motivo tb em email_error
    if (type === 'email.bounced' && evt.data?.bounce?.message) {
      patch.email_error = String(evt.data.bounce.message).slice(0, 500);
    }
    if (type === 'email.complained') {
      patch.email_error = 'spam_complaint';
    }

    await supaFetch('PATCH', `promo_campaigns?id=eq.${row.id}`, patch);
    console.log('[webhook resend]', type, '→', col, 'order_id_row=', row.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook resend] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

module.exports = router;
