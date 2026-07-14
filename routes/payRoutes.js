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
const { createWooviCharge, WOOVI_APP_ID } = require('../lib/woovi');
const { createAsaasPixCharge, ASAAS_CUSTOMER_ID } = require('../lib/asaas');

const router = express.Router();

// Provedor de PIX ativo. 'woovi' ou 'abacate'. Default segue AbacatePay pra não
// mudar nada sem querer; setar PIX_PROVIDER=woovi no Coolify pra virar a chave.
const PIX_PROVIDER = (process.env.PIX_PROVIDER || 'abacate').toLowerCase();

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
  let abacateAttempted = false; // p/ opsMonitor: só registra outcome se chegou a chamar a AbacatePay
  try {
    const { orderId, plan: clientPlan } = req.body || {};
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'orderId invalido' });

    // 🔒 Carrega o pedido — inclui a VARIANTE DE PREÇO fixada nele (fonte da
    // verdade). Também é a trava "sem prévia = sem pagamento" (evita pago-sem-música).
    const _ord = await supaFetch('GET', `orders?id=eq.${orderId}&select=preview_audio_url,status,paid_at,price_variant`);
    const _oo = Array.isArray(_ord) && _ord[0];
    if (!_oo) return res.status(404).json({ error: 'pedido nao encontrado' });

    // 🔒 PLANO/PREÇO derivado do PEDIDO, NUNCA do cliente. Se a variante de teste
    // está fixada no pedido, FORÇA o plano dela (o cliente vê e paga sempre o
    // MESMO preço, em qualquer device). Control usa o plano escolhido. O valor
    // SEMPRE sai de PAY_PLANS[plan].cents (allowlist server-side).
    const variant = ['control', 'p2990', 'p2900', 'p29', 'p37', 'p47', 'p67'].includes(_oo.price_variant) ? _oo.price_variant : null;
    const TEST_PLAN = { p2990: 'test29', p2900: 'test2900', p29: 'test29', p37: 'test37', p47: 'test47', p67: 'test67' };
    const plan = TEST_PLAN[variant] || (['musica', 'completa'].includes(clientPlan) ? clientPlan : 'musica');
    const p = PAY_PLANS[plan];
    if (!p) return res.status(400).json({ error: 'plano invalido' });
    const cents = p.cents;
    const variantPatch = {}; // variante já persistida no pedido (price_variant)
    if (variant) console.log('[/api/pay/create] variante do pedido:', variant, '→ plano:', plan, 'order:', orderId);
    if (!_oo.preview_audio_url) {
      console.warn('[/api/pay/create] BLOQUEADO sem prévia — order', orderId, 'status', _oo.status);
      return res.status(409).json({ error: 'sem_previa', message: 'A prévia da sua música ainda não ficou pronta — não dá pra pagar ainda. Aguarde uns minutinhos ou fale com a gente 💛' });
    }

    // Provedor efetivo: normalmente PIX_PROVIDER (env). Override POR REQUEST só
    // com token de teste (headers X-Pay-Test + X-Force-Provider) — permite validar
    // um provedor novo em produção sem virar a chave global pra todos os clientes.
    let useProvider = PIX_PROVIDER;
    const _testTok = process.env.PAY_TEST_TOKEN || '';
    const _forced = String(req.headers['x-force-provider'] || '').toLowerCase();
    if (_testTok && req.headers['x-pay-test'] === _testTok && ['asaas', 'woovi', 'abacate'].includes(_forced)) {
      useProvider = _forced;
      console.log('[/api/pay/create] OVERRIDE de teste → provider:', useProvider, 'order:', orderId);
    }

    // ═══ ASAAS — PIX DIRETO (conta própria LUPELIUS, sem intermediário) ═══
    // Mesma resposta shape (brCode + brCodeBase64=data-URI do QR) → frontend não muda.
    // externalReference embute orderId+plan pro webhook amarrar o pedido.
    if (useProvider === 'asaas') {
      if (!ASAAS_CUSTOMER_ID) return res.status(503).json({ error: 'ASAAS nao configurado (ASAAS_CUSTOMER_ID)' });
      let charge;
      try {
        charge = await createAsaasPixCharge({ orderId, valueCents: cents, description: p.name, externalReference: `${orderId}-${plan}` });
      } catch (e) {
        console.error('[/api/pay/create asaas] erro:', e.response?.data || e.message);
        return res.status(502).json({ error: 'falha ao gerar PIX (asaas)', detail: String(e.response?.data?.errors?.[0]?.description || e.message) });
      }
      const patchPay = {
        bill_id: charge.id,
        abacate_charge_id: charge.id,
        abacate_brcode: charge.brCode,
        abacate_qrcode: charge.qrImageBase64,
        abacate_status: 'PENDING',
        payment_method: 'pix_asaas',
        payment_amount: cents / 100,
        plan,
        ...variantPatch,
      };
      if (p.includes_video) patchPay.video_upsell_status = 'brinde_pending';
      try { await supaFetch('PATCH', `orders?id=eq.${orderId}`, patchPay); } catch (e) { console.error('[/api/pay/create asaas] patch err:', e.message); }
      console.log('[/api/pay/create] ASAAS PIX criado:', charge.id, 'p/', orderId, '(', cents, 'cents)');
      return res.json({
        ok: true,
        paymentId: charge.id,
        brCode: charge.brCode,
        brCodeBase64: charge.qrImageBase64,
        amount: cents,
        expiresAt: charge.expiresAt,
      });
    }

    // ═══ WOOVI (ex-OpenPix) — provedor ativo quando PIX_PROVIDER=woovi ═══
    // Mesma resposta shape do AbacatePay (brCode + brCodeBase64=qrCodeImage URL)
    // → frontend não muda. correlationID embute orderId+plan pro webhook amarrar.
    if (useProvider === 'woovi') {
      if (!WOOVI_APP_ID) return res.status(503).json({ error: 'Woovi nao configurado (WOOVI_APP_ID)' });
      const correlationID = `${orderId}-${plan}-${Math.floor(Date.now() / 1000)}`;
      let charge;
      try {
        charge = await createWooviCharge({ correlationID, valueCents: cents, comment: p.name });
      } catch (e) {
        console.error('[/api/pay/create woovi] erro:', e.response?.data || e.message);
        return res.status(502).json({ error: 'falha ao gerar PIX (woovi)', detail: String(e.response?.data?.error || e.message) });
      }
      const patchPay = {
        bill_id: charge.correlationID || correlationID,
        abacate_charge_id: charge.globalID || charge.identifier || correlationID,
        abacate_brcode: charge.brCode,
        abacate_qrcode: charge.qrCodeImage,
        abacate_status: 'PENDING',
        payment_method: 'pix_woovi',
        payment_amount: cents / 100,
        plan,
        ...variantPatch,
      };
      if (p.includes_video) patchPay.video_upsell_status = 'brinde_pending';
      try { await supaFetch('PATCH', `orders?id=eq.${orderId}`, patchPay); } catch (e) { console.error('[/api/pay/create woovi] patch err:', e.message); }
      console.log('[/api/pay/create] WOOVI PIX criado:', correlationID, 'p/', orderId, '(', cents, 'cents)');
      return res.json({
        ok: true,
        paymentId: charge.correlationID || correlationID,
        brCode: charge.brCode,
        brCodeBase64: charge.qrCodeImage,   // URL da imagem do QR (funciona como <img src>)
        amount: cents,
        expiresAt: charge.expiresDate || null,
      });
    }

    // ═══ ABACATEPAY (default) ═══
    if (!ABACATEPAY_API_KEY) return res.status(503).json({ error: 'AbacatePay nao configurado (ABACATEPAY_API_KEY)' });

    // SEMPRE cria PIX novo com externalId unico — evita dedup do AbacatePay
    // (que retornava cobranca antiga com valor errado quando o cliente trocava plano)
    const extId = `${orderId}-${plan}-${Math.floor(Date.now() / 1000)}`;

    // Cria cobranca PIX na AbacatePay
    abacateAttempted = true;
    const ar = await axios.post(`${ABACATEPAY_API}/transparents/create`, {
      method: 'PIX',
      data: {
        amount: cents,
        expiresIn: 60 * 60, // 1h
        description: p.name,
        externalId: extId,
        metadata: { order_id: orderId, plan, price_variant: variant || undefined },
      },
    }, {
      headers: { Authorization: `Bearer ${ABACATEPAY_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });

    const data = ar.data?.data;
    if (!data?.id || !data?.brCode) {
      console.error('[/api/pay/create] resposta inesperada:', ar.data);
      try { require('../lib/opsMonitor').recordAbacateOutcome(false); } catch (_) {}
      return res.status(502).json({ error: 'falha ao gerar PIX' });
    }

    try { require('../lib/opsMonitor').recordAbacateOutcome(true); } catch (_) {}
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
      ...variantPatch,
    };
    if (p.includes_video) patchPay.video_upsell_status = 'brinde_pending';
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
    // só registra falha do Abacate se a request chegou a ser disparada (não em erro pré-gate)
    if (abacateAttempted) { try { require('../lib/opsMonitor').recordAbacateOutcome(false); } catch (_) {} }
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
