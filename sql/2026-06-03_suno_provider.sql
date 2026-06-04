-- ============================================================
-- Migração: adiciona rastreamento de provider (sunoapi.org vs cookie)
-- Data: 2026-06-03
-- Usado por: lib/sunoProvider.js + inngest/functions/generateSong.js
--
-- O que faz:
--   1. Coluna suno_provider — qual rota gerou ('api' | 'cookie')
--   2. Coluna suno_task_id  — taskId da sunoapi.org (quando provider='api')
--   3. Índice em suno_task_id pra lookup rápido em logs e debug
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS suno_provider varchar(20),   -- 'api' | 'cookie'
  ADD COLUMN IF NOT EXISTS suno_task_id  text;          -- taskId quando provider='api'

CREATE INDEX IF NOT EXISTS idx_orders_suno_task_id
  ON orders(suno_task_id) WHERE suno_task_id IS NOT NULL;
