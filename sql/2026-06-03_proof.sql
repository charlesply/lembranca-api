-- ============================================================
-- Migração: Validação IA de comprovantes PIX
-- Data: 2026-06-03
-- Endpoint que usa: POST /api/order/:id/proof  (server.js)
--
-- O que faz:
--   1. Adiciona colunas em `orders` pra armazenar o comprovante,
--      o hash anti-reuso, o JSON da leitura da IA e o status.
--   2. Cria índice em proof_hash pra detectar duplicatas rápido.
--
-- Passos manuais NO SUPABASE (UI, não dá pra automatizar):
--   3. Storage → New bucket → name: receipts  · public: OFF
--      (só o service-role escreve; signed URLs pra leitura)
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS proof_url      text,
  ADD COLUMN IF NOT EXISTS proof_hash     text,
  ADD COLUMN IF NOT EXISTS proof_ai_data  jsonb,
  ADD COLUMN IF NOT EXISTS proof_status   varchar(30);

-- Anti-reuso: detecta se o mesmo comprovante foi enviado em outro pedido.
CREATE INDEX IF NOT EXISTS idx_orders_proof_hash ON orders(proof_hash);

-- Pra dashboard de comprovantes em revisão manual.
CREATE INDEX IF NOT EXISTS idx_orders_proof_status ON orders(proof_status)
  WHERE proof_status IS NOT NULL;
