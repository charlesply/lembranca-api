// promoRoutes — rotas admin pra gerenciar campanhas promocionais
// (hoje so namorados_2026; arquitetura permite mais campanhas no futuro).
//
// TODAS as rotas exigem ?secret=$ADMIN_API_SECRET (ou fallback ABACATEPAY_WEBHOOK_SECRET).
//
// Rotas (5):
//   GET  /api/admin/promo/namorados/eligible
//        → proxima pagina da fila (filtro completo: preview_sent + romantico +
//          nunca pagou + nao recebeu campanha). ?limit=10
//
//   POST /api/admin/promo/namorados/preview
//        → recebe orderId no body, retorna o TEXTO do whatsapp que seria
//          enviado (DRY-RUN, nao toca em nada). Pra voce revisar antes.
//
//   POST /api/admin/promo/namorados/send-one
//        → envia pra 1 lead especifico. ?confirm=YES obrigatorio.
//          Body: {orderId, approvedBy?}.
//
//   POST /api/admin/promo/namorados/send-batch
//        → envia pros proximos N elegiveis. ?confirm=YES&n=10 obrigatorios.
//          Body opcional: {delaySeconds:30} (delay entre envios)
//
//   GET  /api/admin/promo/namorados/stats
//        → totais (sent, clicked, converted, by_template)

const express = require('express');
const promo = require('../lib/promoNamorados');

const router = express.Router();

function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_API_SECRET || process.env.ABACATEPAY_WEBHOOK_SECRET;
  if (!expected || req.query.secret !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// GET /api/admin/promo/namorados/eligible?limit=10
router.get('/api/admin/promo/namorados/eligible', adminAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 100));
    const beforeCreatedAt = req.query.before || null;
    const list = await promo.listEligible({ limit, beforeCreatedAt });
    res.json({
      ok: true,
      total: list.length,
      campaign: promo.CAMPAIGN_NAME,
      leads: list.map(o => ({
        id: o.id,
        phone: o.phone,
        relationship: o.relationship,
        honoree_name: o.honoree_name,
        customer_name: o.customer_name,
        has_email: !!o.customer_email,
        created_at: o.created_at,
        template_key: promo.pickTemplate(o),
      })),
    });
  } catch (e) {
    console.error('[promo/eligible]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/promo/namorados/preview
// Body: { orderId } → retorna { text, template_key, phone } SEM enviar
router.post('/api/admin/promo/namorados/preview', adminAuth, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId obrigatorio' });
    const r = await promo.sendOne(orderId, { dryRun: true });
    res.json(r);
  } catch (e) {
    console.error('[promo/preview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/promo/namorados/send-one
// Body: { orderId, approvedBy } + ?confirm=YES
router.post('/api/admin/promo/namorados/send-one', adminAuth, async (req, res) => {
  if (req.query.confirm !== 'YES') {
    return res.status(400).json({ error: 'precisa de ?confirm=YES pra enviar de verdade' });
  }
  try {
    const { orderId, approvedBy } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId obrigatorio' });
    const r = await promo.sendOne(orderId, { approvedBy });
    res.json(r);
  } catch (e) {
    console.error('[promo/send-one]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/promo/namorados/send-batch?confirm=YES&n=10
// Body opcional: { delaySeconds: 30, approvedBy: 'manual' }
// Envia em sequencia com delay (pra Evolution nao engasgar).
router.post('/api/admin/promo/namorados/send-batch', adminAuth, async (req, res) => {
  if (req.query.confirm !== 'YES') {
    return res.status(400).json({ error: 'precisa de ?confirm=YES pra enviar batch de verdade' });
  }
  const n = Math.max(1, Math.min(parseInt(req.query.n, 10) || 10, 50));
  const delaySeconds = Math.max(0, Math.min(parseInt(req.body?.delaySeconds, 10) || 30, 600));
  const approvedBy = req.body?.approvedBy || 'manual-batch';

  try {
    const leads = await promo.listEligible({ limit: n });
    if (!leads.length) return res.json({ ok: true, sent: 0, results: [], note: 'fila vazia' });

    // Responde rapido + processa em background pra nao timeout
    res.json({ ok: true, queued: leads.length, delaySeconds, note: 'processando em background — checar stats em 2-5min' });

    (async () => {
      for (let i = 0; i < leads.length; i++) {
        const o = leads[i];
        try {
          const r = await promo.sendOne(o.id, { approvedBy });
          console.log(`[promo batch] ${i+1}/${leads.length}`, o.id.slice(0,8), r.whatsapp_status || (r.ok?'sent':'failed'));
        } catch (e) {
          console.error(`[promo batch] ${i+1}/${leads.length} falhou:`, e.message);
        }
        if (i < leads.length - 1 && delaySeconds > 0) {
          await new Promise(r => setTimeout(r, delaySeconds * 1000));
        }
      }
      console.log('[promo batch] completo —', leads.length, 'leads processados');
    })().catch(e => console.error('[promo batch] background catastrofico:', e.message));
  } catch (e) {
    console.error('[promo/send-batch]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/promo/namorados/stats
router.get('/api/admin/promo/namorados/stats', adminAuth, async (req, res) => {
  try {
    const s = await promo.stats();
    res.json({ ok: true, campaign: promo.CAMPAIGN_NAME, ...s });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
