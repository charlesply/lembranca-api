// payPlans — PRECO FIXO NO SERVIDOR (cliente NAO consegue alterar o valor).
// O front so manda o identificador do plano; backend decide o preco/descricao.
//
// Usado por:
//   - routes/payRoutes.js (/api/pay/create) — cria PIX com o valor correto
//   - /api/order/:id/proof (ainda em server.js) — valida valor do comprovante
//   - lib/abacatePay (futuro) — fonte unica da verdade
const PAY_PLANS = {
  musica:      { cents: 1990, name: 'Musica personalizada - Lembranca Cantada' },
  completa:    { cents: 2990, name: 'Musica + Video personalizado com foto - Lembranca Cantada' },
  // legado (nao ofertado no site novo, mantido por compatibilidade de links antigos)
  video_letra: { cents: 2990, name: 'Musica + Video personalizado com foto - Lembranca Cantada' },
};

module.exports = { PAY_PLANS };
