// phoneVariants — gera todas as variantes razoaveis de um telefone brasileiro
// (com/sem 55, com/sem 9 do celular). Usado em buscas no DB pra nao perder
// cliente por inconsistencia de cadastro.

function digits(p) { return String(p || '').replace(/\D/g, '').slice(0, 15); }

// Retorna Set com TODAS as variantes possiveis do telefone passado.
function variants(p) {
  p = digits(p);
  if (!p) return new Set();
  const out = new Set([p]);
  // c/s 55
  if (p.startsWith('55')) out.add(p.slice(2));
  else out.add('55' + p);
  // c/s 9 do celular (so se for movel 11 digitos)
  const m = p.startsWith('55') ? p.slice(2) : p;
  if (m.length === 11 && m[2] === '9') {
    out.add((p.startsWith('55') ? '55' : '') + m.slice(0, 2) + m.slice(3));
  }
  if (m.length === 10) {
    out.add((p.startsWith('55') ? '55' : '') + m.slice(0, 2) + '9' + m.slice(2));
  }
  return out;
}

module.exports = { digits, variants };
