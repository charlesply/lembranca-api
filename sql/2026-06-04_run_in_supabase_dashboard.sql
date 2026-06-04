-- ═══════════════════════════════════════════════════════════════
-- MIGRATION URGENTE · ORDERS — colunas faltando
-- ═══════════════════════════════════════════════════════════════
-- Como rodar:
-- 1. https://supabase.com/dashboard/project/wedkbwsijfikbkaqnugz/sql
-- 2. New query → cole tudo abaixo → Run
-- 3. Volte aqui e me avise — vou reverter o codigo defensivo
--    (que joga payment_method/payment_amount/proof_* fora) pra voltar
--    a persistir audit data do PIX.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS proof_url       text,
  ADD COLUMN IF NOT EXISTS proof_hash      text,
  ADD COLUMN IF NOT EXISTS proof_ai_data   jsonb,
  ADD COLUMN IF NOT EXISTS proof_status    varchar(30),
  ADD COLUMN IF NOT EXISTS payment_method  varchar(40),
  ADD COLUMN IF NOT EXISTS payment_amount  numeric(10,2),
  ADD COLUMN IF NOT EXISTS plan            varchar(30);

-- indices uteis (anti-duplicata + dashboard de revisao)
CREATE INDEX IF NOT EXISTS idx_orders_proof_hash
  ON orders(proof_hash) WHERE proof_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_proof_status
  ON orders(proof_status) WHERE proof_status IS NOT NULL;

-- BUCKET 'receipts' — fazer manualmente no Storage do Dashboard:
--   Storage → New bucket → name: receipts · public: OFF
-- (so o service-role escreve; signed URLs pra leitura)
