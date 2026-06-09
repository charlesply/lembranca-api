// validators — helpers compartilhados de validacao/normalizacao de input.
// Antes duplicados em routes/{payRoutes, orderReadRoutes, orderWriteRoutes}.

// isUuid — testa formato UUID (com ou sem hifens). Estrito o suficiente pra
// evitar SQL injection via param `:id` quando concatenamos em URLs do PostgREST.
const isUuid = (s) => /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(String(s || ''));

// clip — corta string em `n` chars, retornando null pra entrada vazia/null.
// Usado pra coagir varchar/text antes de PATCH/POST no Supabase, garantindo
// que o cliente nunca consiga estourar limite de coluna ou injetar payload.
const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

module.exports = { isUuid, clip };
