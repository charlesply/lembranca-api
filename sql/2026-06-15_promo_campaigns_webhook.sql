-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-06-15 — promo_campaigns: tracking de webhook Resend (dashboard email)
--
-- Adiciona colunas pra receber callbacks do Resend e construir o dashboard:
--   email_opened_at   — quando Resend detectou abertura (tracking pixel)
--   email_bounced_at  — quando devolveu (hard/soft bounce)
--   email_complained_at — quando recipient marcou como spam (red flag)
--   email_delivered_at — quando o ISP confirmou entrega (vs sent)
--
-- Schema já tinha: email_sent_at, email_status, email_error, link_clicked_at,
-- converted_at — esses continuam.
--
-- IDEMPOTENTE: usa IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE promo_campaigns
  ADD COLUMN IF NOT EXISTS email_delivered_at  timestamptz,
  ADD COLUMN IF NOT EXISTS email_opened_at     timestamptz,
  ADD COLUMN IF NOT EXISTS email_bounced_at    timestamptz,
  ADD COLUMN IF NOT EXISTS email_complained_at timestamptz;

-- Índice pra agregar rápido nos dashboards.
CREATE INDEX IF NOT EXISTS idx_promo_campaigns_campaign_sent
  ON promo_campaigns (campaign_name, email_sent_at DESC)
  WHERE email_sent_at IS NOT NULL;
