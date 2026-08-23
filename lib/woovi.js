// lib/woovi — integração PIX com a Woovi (ex-OpenPix). Fallback/substituto do
// AbacatePay quando a geração de QR PIX deles cai.
//
// Docs: https://developers.woovi.com/
//   Criar cobrança: POST https://api.woovi.com/api/v1/charge
//     Header: Authorization: <APP_ID>  (o AppID do painel Woovi É o header, sem "Bearer")
//     Body:   { correlationID, value (centavos, int), comment, expiresIn (s) }
//     Resp:   { charge: { brCode, qrCodeImage (URL), correlationID, value,
//                         expiresDate, status, globalID, identifier, ... } }
//   Confirmação: webhook OPENPIX:CHARGE_COMPLETED → /api/webhooks/woovi
const axios = require('axios');

const WOOVI_APP_ID = process.env.WOOVI_APP_ID || '';
const WOOVI_API = process.env.WOOVI_API || 'https://api.woovi.com/api/v1';

// Cria uma cobrança PIX. Retorna o objeto `charge` da Woovi (ou lança).
// customer (opcional): { name, taxID(cpf/cnpj só dígitos), email, phone } — associa
// o pagador ao charge (nota fiscal / conciliação). Woovi aceita como opcional.
async function createWooviCharge({ correlationID, valueCents, comment, customer }) {
  if (!WOOVI_APP_ID) throw new Error('WOOVI_APP_ID ausente');
  const body = {
    correlationID,
    value: valueCents,      // centavos (int)
    comment: (comment || 'Lembrança Cantada').slice(0, 140),
    expiresIn: 60 * 60,     // 1h
  };
  if (customer && customer.taxID) {
    body.customer = {
      name: (customer.name || 'Cliente').slice(0, 100),
      taxID: String(customer.taxID),
      ...(customer.email ? { email: customer.email } : {}),
      ...(customer.phone ? { phone: String(customer.phone) } : {}),
    };
  }
  const r = await axios.post(`${WOOVI_API}/charge`, body, {
    headers: { Authorization: WOOVI_APP_ID, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  const charge = r.data?.charge || r.data;
  if (!charge || !charge.brCode) {
    const err = new Error('woovi_sem_brcode');
    err.response = { data: r.data };
    throw err;
  }
  return charge;
}

module.exports = { createWooviCharge, WOOVI_APP_ID };
