// gadsConversionsRoutes — CONVERSÃO OFFLINE do Google Ads (importação por CSV).
//
// PROBLEMA: a conversão de compra dispara no gtag da volta pro site. PIX paga no
// app do banco e NUNCA volta → o Google subconta ~1/4 das vendas e o Smart Bidding
// dá lance em cima de sinal baixo. Solução oficial: importar as vendas pagas por
// gclid, server-side, num CSV que o Google busca sozinho (importação agendada).
//
// Esta rota devolve o CSV das vendas pagas dos últimos 30 dias QUE TÊM gclid
// (capturado no 1º toque — ver analytics.js / coluna orders.gclid). O Google
// deduplica por gclid + nome da conversão + horário e ainda usa Order ID como
// trava explícita → reentregar as mesmas linhas todo dia é seguro por desenho
// (sem fila, sem tabela nova; a verdade é a própria tabela orders).
//
// Config no painel do Google Ads (feita pelo dono da conta): criar a ação de
// conversão de IMPORTAÇÃO com o nome EXATO de GOOGLE_ADS_CONVERSAO_NOME e apontar
// a importação agendada pra esta URL + usuário/senha. Pra não contar 2×, deixar a
// importada como conversão PRIMÁRIA de lance e a web (gtag) como secundária.
const express = require('express');
const crypto = require('crypto');
const { supaFetch } = require('../lib/supabase');

const router = express.Router();

// Comparação em tempo CONSTANTE: hash de 256 bits dos dois lados + timingSafeEqual
// (sempre 32 bytes, sem vazar tamanho). `===` sairia no 1º byte diferente e o
// tempo é medível → dava pra descobrir o segredo byte a byte.
function eqConst(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Autoriza por HTTP Basic (usuário+senha) OU ?k=<segredo> (2ª porta p/ conferir
// com curl). ARMADILHA 5: FALHA FECHADO — sem segredo configurado, 503 e para
// (nunca `if (!segredo || confere)`, que aceitaria qualquer request).
function autorizar(req) {
  const KEY = process.env.GADS_CSV_KEY || '';
  const USER = process.env.GADS_CSV_USER || 'google';
  if (!KEY) return { ok: false, code: 503 };
  // 2ª porta: ?k=
  const k = req.query.k;
  if (k != null && eqConst(k, KEY)) return { ok: true };
  // HTTP Basic (o formulário do Google exige URL + usuário + senha)
  const h = String(req.headers.authorization || '');
  if (h.toLowerCase().startsWith('basic ')) {
    const txt = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    // indexOf e NÃO split(':'): a senha pode ter dois-pontos; partir truncaria.
    const i = txt.indexOf(':');
    if (i >= 0) {
      // Sem && que saia cedo: avalia os dois antes de combinar (tempo constante).
      const okU = eqConst(txt.slice(0, i), USER);
      const okP = eqConst(txt.slice(i + 1), KEY);
      if (okU && okP) return { ok: true };
    }
  }
  return { ok: false, code: 401 };
}

// ARMADILHA 1: o Google quer o fuso com os quatro dígitos COLADOS (+0000), não
// +00:00 (ISO 8601). Com dois-pontos ele recusa toda linha. Deslocamento
// explícito, não Parameters:TimeZone (não depende de dois lados concordarem).
const horaGoogle = (iso) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ') + '+0000';

// Escape CSV: gclid é URL-safe e Order ID é uuid (nenhum morde). O NOME da
// conversão morde — vem de config, escrito por gente; vírgula deslocaria as
// colunas à direita em silêncio e o Google leria o horário como valor.
const esc = (v) => /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

const CABECALHO = 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID';

router.get('/api/gads/conversions.csv', async (req, res) => {
  const auth = autorizar(req);
  if (!auth.ok) {
    if (auth.code === 503) return res.status(503).send('GADS_CSV_KEY nao configurada');
    // ARMADILHA 4: responde 401 COM desafio (não um 404 discreto) — quem não
    // mandou credencial precisa saber que existe credencial pra mandar.
    res.set('WWW-Authenticate', 'Basic realm="gads-conversions"');
    return res.status(401).send('credencial necessaria');
  }

  const NOME = process.env.GOOGLE_ADS_CONVERSAO_NOME || 'Compra PIX (importada)';
  const DIAS = Number(process.env.GADS_CSV_DIAS || 30);

  try {
    const desde = new Date(Date.now() - DIAS * 864e5).toISOString();
    const linhas = [];
    // ARMADILHA 2: o PostgREST corta em 1000 (teto do servidor; .limit(5000) não
    // levanta). Pagina com limit+offset e para quando o lote vier incompleto.
    for (let offset = 0; offset < 500000; offset += 1000) {
      const page = await supaFetch('GET',
        `orders?select=id,gclid,paid_at,payment_amount,amount_cents` +
        `&paid_at=gte.${encodeURIComponent(desde)}&gclid=not.is.null` +
        `&order=paid_at.desc&limit=1000&offset=${offset}`);
      // ARMADILHA 3: erro NUNCA vira CSV vazio (o Google registraria "0 conversões
      // hoje" como verdade). supaFetch devolve null em falha → estoura pro 500.
      if (page === null) throw new Error('supaFetch null (falha na consulta)');
      for (const o of page) {
        if (!o.gclid || !o.paid_at) continue;
        const valor = (o.payment_amount != null ? Number(o.payment_amount) : (Number(o.amount_cents) || 0) / 100).toFixed(2);
        // Moeda: 100% BR hoje. Quando a operação /es/ escalar, derivar USD por
        // um sinal de locale do pedido (mandar tudo BRL faria US$9 entrar como R$9).
        const moeda = 'BRL';
        linhas.push([esc(o.gclid), esc(NOME), esc(horaGoogle(o.paid_at)), valor, moeda, esc(o.id)].join(','));
      }
      if (page.length < 1000) break;
    }

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Cache-Control', 'no-store, max-age=0'); // Google busca 1×/dia; nada de CDN velho
    res.set('Content-Disposition', 'attachment; filename="conversoes.csv"');
    return res.status(200).send(CABECALHO + '\n' + linhas.join('\n') + (linhas.length ? '\n' : ''));
  } catch (e) {
    console.error('[gads/conversions.csv] erro:', e.message);
    return res.status(500).send('erro ao montar conversoes'); // nunca CSV vazio
  }
});

module.exports = router;
