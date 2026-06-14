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
      // Video so eh gerado pra plano COMPLETA (R$29,90).
      // Plano musica (R$19,90) NAO recebe video.
      if (o.plan === 'completa') {
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

module.exports = router;
