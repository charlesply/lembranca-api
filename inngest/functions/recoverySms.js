// inngest/functions/recoverySms — SMS de RECUPERAÇÃO por EVENTO (sem cron).
//
// Mesma ideia do e-mail, mas disparado POR PEDIDO:
//   1) a prévia fica pronta → generateSong dispara 'sms/recovery.scheduled' {orderId}
//   2) esta função espera 7min (durável, não prende processo)
//   3) se o cliente NÃO pagou nesse tempo → envia 1 SMS INDIVIDUAL pra aquele pedido
//
// NADA de cron, NADA de lote — 1 pedido, 1 SMS. (O incidente 28/ago foi o cron de
// varredura enviando 40 numa chamada só; isso NÃO existe mais.)
// 🔒 GATE: sms.sendRecoverySms respeita SMS_ENABLED (no-op se desligado).
const { inngest } = require('../client');
const { supaFetch } = require('../../lib/supabase');
const sms = require('../../lib/sms');

// tempo pra dar chance de pagar antes de mandar o SMS (default 7min)
const DELAY = process.env.SMS_RECOVERY_DELAY || '7m';

const recoverySms = inngest.createFunction(
  { id: 'recovery-sms', name: 'SMS recuperação (7min pós-prévia, por pedido)' },
  { event: 'sms/recovery.scheduled' },
  async ({ event, step }) => {
    const orderId = event.data && event.data.orderId;
    if (!orderId) return { skipped: 'no_orderId' };

    // espera o tempo de dar chance de pagar (step.sleep é durável no Inngest)
    await step.sleep('aguarda-pagamento', DELAY);

    // depois do tempo, reavalia e envia SÓ se ainda não pagou
    return await step.run('envia-se-nao-pagou', async () => {
      const rows = await supaFetch('GET',
        `orders?id=eq.${orderId}&select=id,customer_name,phone,paid_at,status,preview_audio_url,sms_sent_at,email_opt_out`);
      const o = Array.isArray(rows) && rows[0];
      if (!o) return { skipped: 'not_found' };
      const paid = o.paid_at || ['paid', 'delivered'].includes(String(o.status || '').toLowerCase());
      if (paid) return { skipped: 'ja_pagou' };
      if (o.email_opt_out) return { skipped: 'opt_out' };
      if (!o.phone || !o.preview_audio_url) return { skipped: 'inelegivel' };
      if (o.sms_sent_at) return { skipped: 'ja_enviado' };

      const r = await sms.sendRecoverySms(o); // 1 SMS individual (respeita SMS_ENABLED)
      if (r && r.ok) {
        await supaFetch('PATCH', `orders?id=eq.${orderId}`,
          { sms_sent_at: new Date().toISOString(), sms_type: 'recovery' }).catch(() => {});
        return { orderId, sent: true };
      }
      return { orderId, sent: false, result: r };
    });
  }
);

module.exports = { recoverySms };
