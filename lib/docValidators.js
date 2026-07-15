// lib/docValidators — validação de CPF/CNPJ (formato + dígito verificador).
// Usado no checkout A/B (variante B, ASAAS exige documento válido pro cliente).
// Fonte da verdade é o backend; o front valida também só pra UX.

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

function isValidCpf(cpf) {
  cpf = onlyDigits(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false; // rejeita 000..., 111...
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += +cpf[i] * (10 - i);
  let d1 = (sum * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== +cpf[9]) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += +cpf[i] * (11 - i);
  let d2 = (sum * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === +cpf[10];
}

function isValidCnpj(cnpj) {
  cnpj = onlyDigits(cnpj);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base) => {
    const len = base.length;
    let pos = len - 7, sum = 0;
    for (let i = 0; i < len; i++) { sum += +base[i] * pos--; if (pos < 2) pos = 9; }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(cnpj.slice(0, 12));
  if (d1 !== +cnpj[12]) return false;
  const d2 = calc(cnpj.slice(0, 13));
  return d2 === +cnpj[13];
}

// Valida CPF (11 díg) ou CNPJ (14 díg) pelo comprimento.
function isValidCpfCnpj(v) {
  const d = onlyDigits(v);
  if (d.length === 11) return isValidCpf(d);
  if (d.length === 14) return isValidCnpj(d);
  return false;
}

module.exports = { onlyDigits, isValidCpf, isValidCnpj, isValidCpfCnpj };
