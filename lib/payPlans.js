// payPlans — PRECO FIXO NO SERVIDOR (cliente NAO consegue alterar o valor).
// O front so manda o identificador do plano; backend decide o preco/descricao.
//
// Usado por:
//   - routes/payRoutes.js (/api/pay/create) — cria PIX com o valor correto
//   - /api/order/:id/proof (ainda em server.js) — valida valor do comprovante
//   - lib/abacatePay (futuro) — fonte unica da verdade
const PAY_PLANS = {
  musica:      { cents: 1990, name: 'Musica personalizada - Lembranca Cantada' },
  completa:    { cents: 2990, name: 'Musica + Video personalizado com foto - Lembranca Cantada', includes_video: true },
  // legado (nao ofertado no site novo, mantido por compatibilidade de links antigos)
  video_letra: { cents: 2990, name: 'Musica + Video personalizado com foto - Lembranca Cantada', includes_video: true },
  // PROMO Dia dos Namorados 2026 — APENAS pra lista de recovery whatsapp/email.
  // Mesmo preco do `musica` (R$19,90) mas INCLUI video karaoke (igual `completa`).
  // NAO exposto na landing publica — so via /promo/:id pra leads filtrados.
  // Sera removido apos a campanha (12-14/06).
  promo_namorados_2026: {
    cents: 1990,
    name: 'Musica + Video Karaoke - Promo Dia dos Namorados',
    includes_video: true,
    promo: true,
  },
};

module.exports = { PAY_PLANS };
