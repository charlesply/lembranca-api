// recoveryRoutes — unsubscribe (LGPD/List-Unsubscribe) + teste do e-mail de recuperação.
const express = require('express');
const router = express.Router();
const { supaFetch } = require('../lib/supabase');
const { isUuid: _isUuid } = require('../lib/validators');
const { sendRecoveryEmail } = require('../lib/recoveryEmail');

// Marca email_opt_out=true em TODOS os pedidos com o mesmo e-mail do pedido.
async function _optOut(orderId) {
  const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=customer_email`);
  const email = Array.isArray(rows) && rows[0] && rows[0].customer_email;
  if (!email) return false;
  await supaFetch('PATCH', `orders?customer_email=eq.${encodeURIComponent(email)}`, {
    email_opt_out: true, email_opt_out_at: new Date().toISOString(),
  });
  console.log('[unsub] opt-out aplicado p/', email);
  return true;
}

// GET /unsub/:id — página de descadastro (link do rodapé do e-mail).
router.get('/unsub/:id', async (req, res) => {
  const id = req.params.id;
  let ok = false;
  if (_isUuid(id)) { try { ok = await _optOut(id); } catch (_) {} }
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Descadastro</title></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fef9f5;color:#2b1d14;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">
<div style="max-width:420px;background:#fff;border-radius:18px;padding:34px;text-align:center;box-shadow:0 12px 40px rgba(204,120,92,.1)">
<div style="font-size:40px">💛</div>
<h1 style="font-size:22px;color:#2b1d14">${ok ? 'Pronto, você foi descadastrado' : 'Tudo certo'}</h1>
<p style="color:#7a6354;font-size:15px;line-height:1.5">${ok ? 'Você não vai mais receber nossos lembretes por e-mail. Se mudar de ideia, é só criar uma nova música 💛' : 'Não encontramos esse cadastro, mas pode ficar tranquilo — você não receberá mais lembretes.'}</p>
<p style="margin-top:18px"><a href="https://app.lembrancacantada.com" style="color:#CC785C;text-decoration:none;font-weight:700">Voltar pro site</a></p>
</div></body></html>`);
});

// POST /unsub/:id — one-click (Gmail/Outlook List-Unsubscribe-Post).
router.post('/unsub/:id', async (req, res) => {
  const id = req.params.id;
  if (_isUuid(id)) { try { await _optOut(id); } catch (_) {} }
  res.status(200).json({ ok: true });
});

// GET /api/recovery/email_test?to=email&order=uuid[&v=A] — envia UM e-mail de
// teste (não marca recovery_email_sent). Nome distinto do /api/recovery/test do
// funil de WhatsApp (cronRoutes) pra não colidir.
router.get('/api/recovery/email_test', async (req, res) => {
  try {
    const to = String(req.query.to || '').trim();
    const orderId = String(req.query.order || '').trim();
    const v = ['A', 'B', 'C'].includes(String(req.query.v)) ? String(req.query.v) : undefined;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'to invalido' });
    if (!_isUuid(orderId)) return res.status(400).json({ error: 'order invalido' });
    const rows = await supaFetch('GET', `orders?id=eq.${orderId}&select=id,honoree_name,customer_name`);
    const o = Array.isArray(rows) && rows[0];
    if (!o) return res.status(404).json({ error: 'pedido nao encontrado' });
    const r = await sendRecoveryEmail({ ...o, customer_email: to, email_opt_out: false, recovery_email_sent: false }, { test: true, forceVariant: v });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
