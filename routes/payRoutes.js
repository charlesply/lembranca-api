// payRoutes — rotas de pagamento (AbacatePay PIX + InfinitePay legado).
//
// Rotas (3):
//   POST /api/pay/create — cria PIX dinamico via AbacatePay (cliente PAGA aqui)
//   GET  /api/pay/status — polling do frontend (paid? abacate_status?)
//   POST /api/pay/verify — legado InfinitePay (mantido pra compat de links antigos)
//
// IMPORTANTE:
// - PAY_PLANS tem PRECO FIXO no servidor. Front so manda planKey; backend
//   decide o valor pra evitar cliente forjar preco.
// - /api/pay/create grava bill_id/abacate_charge_id na order pra webhook +
//   polling conseguirem amarrar a confirmacao.
// - /api/pay/verify e idempotente (nao reprocessa se ja `paid`).
const express = require('express');
const axios = require('axios');

const { supaFetch } = require('../lib/supabase');
const { PAY_PLANS } = require('../lib/payPlans');
const { isUuid: _isUuid } = require('../lib/validators');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════
// PAGAMENTO — InfinitePay Checkout (LEGADO, mantido por links antigos):
//  1) front chama POST /api/pay/create  -> devolve a URL do checkout
//  2) cliente paga no InfinitePay e volta pro site (redirect_url)
//  3) front chama POST /api/pay/verify com {orderId, transaction_nsu, slug}
//     -> backend confirma no payment_check do InfinitePay e marca PAGO.
//
// Hoje o fluxo principal e o AbacatePay PIX (gerado em /api/pay/create
// abaixo, confirmado por webhook em /api/webhooks/abacatepay).
// ═══════════════════════════════════════════════════════════════
const INFINITEPAY_HANDLE = process.env.INFINITEPAY_HANDLE || '';
const N8N_PAY_WEBHOOK_URL = process.env.N8N_PAY_WEBHOOK_URL || ''; // opcional: dispara a entrega do n8n

// PAY_PLANS — importado de lib/payPlans (compartilhado com /api/order/:id/proof)

// ═══════════════════════════════════════════════════════════════
// PAGAMENTO via AbacatePay — gera PIX dinamico com confirmacao automatica
// ═══════════════════════════════════════════════════════════════
const ABACATEPAY_API_KEY = process.env.ABACATEPAY_API_KEY || '';
const ABACATEPAY_API = 'https://api.abacatepay.com/v2';

router.post('/api/pay/create', async (req, res) => {
  try {
    if (!ABACATEPAY_API_KEY) return res.status(503).json({ error: 'AbacatePay nao configurado (ABACATEPAY_API_KEY)' });
    const { orderId, plan } = req.body || {};
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });
    const p = PAY_PLANS[plan];
    if (!p) return res.status(400).json({ error: 'plano invalido' });
    const cents = p.cents;

    // SEMPRE cria PIX novo com externalId unico — evita dedup do AbacatePay
    // (que retornava cobranca antiga com valor errado quando o cliente trocava plano)
    const extId = `${orderId}-${plan}-${Math.floor(Date.now() / 1000)}`;

    // Cria cobranca PIX na AbacatePay
    const ar = await axios.post(`${ABACATEPAY_API}/transparents/create`, {
      method: 'PIX',
      data: {
        amount: cents,
        expiresIn: 60 * 60, // 1h
        description: p.name,
        externalId: extId,
        metadata: { order_id: orderId, plan },
      },
    }, {
      headers: { Authorization: `Bearer ${ABACATEPAY_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });

    const data = ar.data?.data;
    if (!data?.id || !data?.brCode) {
      console.error('[/api/pay/create] resposta inesperada:', ar.data);
      return res.status(502).json({ error: 'falha ao gerar PIX' });
    }

    console.log('[/api/pay/create] AbacatePay PIX criado:', data.id, 'p/', orderId, '(', cents, 'cents)');

    // grava na order pra webhook + polling acharem
    const patchPay = {
      bill_id: data.id,
      abacate_charge_id: data.id,
      abacate_brcode: data.brCode,
      abacate_qrcode: data.brCodeBase64,
      abacate_status: 'PENDING',
      payment_method: 'pix',
      payment_amount: cents / 100,
      plan,
    };
    if (p.includes_video) patchPay.video_upsell_status = 'pending_photo';
    try { await supaFetch('PATCH', `orders?id=eq.${orderId}`, patchPay); } catch (e) { console.error('[/api/pay/create] patch err:', e.message); }

    res.json({
      ok: true,
      paymentId: data.id,
      brCode: data.brCode,
      brCodeBase64: data.brCodeBase64,
      amount: cents,
      expiresAt: data.expiresAt,
    });
  } catch (e) {
    console.error('[/api/pay/create] erro:', e.response?.data || e.message);
    res.status(500).json({ error: 'erro interno', detail: String(e.response?.data?.error || e.message) });
  }
});

// Status do pagamento — frontend faz polling pra detectar quando paga
router.get('/api/pay/status', async (req, res) => {
  try {
    const orderId = req.query.orderId;
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=status,abacate_status,abacate_charge_id`);
    const o = rows?.[0];
    if (!o) return res.status(404).json({ error: 'nao encontrado' });
    const paid = o.status === 'paid' || o.status === 'delivered' || o.abacate_status === 'PAID';
    res.json({ ok: true, paid, status: o.status, abacate_status: o.abacate_status });
  } catch (e) {
    res.status(500).json({ error: 'erro interno' });
  }
});

// Valida o pagamento no InfinitePay e marca o pedido como pago (LEGADO).
router.post('/api/pay/verify', async (req, res) => {
  try {
    if (!INFINITEPAY_HANDLE) return res.status(503).json({ error: 'pagamento ainda nao configurado (handle)' });
    const { orderId, transaction_nsu, slug } = req.body || {};
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });
    if (!transaction_nsu || !slug) return res.status(400).json({ error: 'transaction_nsu/slug obrigatorios' });

    // Confirma no InfinitePay (server-side; cliente nao consegue forjar)
    let chk = null;
    try {
      const r = await axios.post('https://api.checkout.infinitepay.io/payment_check',
        { handle: INFINITEPAY_HANDLE, order_nsu: orderId, transaction_nsu, slug },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      chk = r.data;
    } catch (e) { chk = { success: false, error: e.response?.data || e.message }; }

    const paid = !!(chk && (chk.paid === true || (chk.success === true && chk.paid !== false)));
    if (!paid) return res.json({ ok: true, paid: false, detail: chk });

    // Idempotente: se ja estava pago, nao reprocessa (evita entrega dupla no reload)
    const cur = await supaFetch('GET', `orders?id=eq.${orderId}&select=status,paid_at,original_audio_url,full_audio_urls,plan`);
    const o = Array.isArray(cur) && cur[0] ? cur[0] : null;
    const already = o && (o.paid_at || ['paid', 'delivered'].includes((o.status || '').toLowerCase()));
    if (o && !already) {
      // garante full_audio_urls (a entrega do n8n manda full_audio_urls[0]/[1])
      let fau = Array.isArray(o.full_audio_urls) ? o.full_audio_urls.filter(Boolean) : [];
      if (!fau.length && o.original_audio_url) fau = [o.original_audio_url];
      const patch = {
        status: 'paid', paid_at: new Date().toISOString(),
        payment_method: 'infinitepay', payment_amount: (chk.paid_amount || chk.amount || null),
        bill_id: 'ip_' + orderId,
      };
      if (fau.length) patch.full_audio_urls = fau;
      await supaFetch('PATCH', `orders?id=eq.${orderId}`, patch);
      // Dispara a ENTREGA reusando o webhook que JA entrega (formato AbacatePay):
      // ele acha o pedido por bill_id e manda a musica completa + marca entregue.
      if (N8N_PAY_WEBHOOK_URL) {
        try {
          await axios.post(N8N_PAY_WEBHOOK_URL,
            { event: 'billing.paid', data: { billing: { id: 'ip_' + orderId } } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
        } catch (e) { console.error('[/api/pay/verify] webhook entrega falhou:', e.message); }
      }
      // Video pra qualquer plano com includes_video=true (completa, promo_*).
      if (require('../lib/payPlans').isVideoPlan(o.plan)) {
        try { require('../lib/brindeVideo').generateBrindeForOrder(orderId); } catch (e) { console.error('[/api/pay/verify] brinde gen falhou:', e.message); }
      }
      console.log('[/api/pay/verify] ✅ PAGO + entrega disparada:', orderId);
    }
    res.json({ ok: true, paid: true });
  } catch (e) {
    console.error('[/api/pay/verify] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

module.exports = router;
