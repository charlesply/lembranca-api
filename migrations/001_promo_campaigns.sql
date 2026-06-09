-- Migration 001 — Tabela promo_campaigns pra controlar envios de promo
-- Aplicar via Supabase Dashboard -> SQL Editor.
--
-- Garante:
-- - 1 lead nao recebe a mesma campanha 2x (UNIQUE(order_id, campaign_name))
-- - Auditoria completa de cada envio: whatsapp, email, click, conversao
-- - Performance no monitor diario (INDEX em camp_name + sent_at)

CREATE TABLE IF NOT EXISTS promo_campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  campaign_name     varchar(40) NOT NULL,        -- 'namorados_2026'
  template_key      varchar(40),                 -- 'romantico_esposo' | 'romantico_namorada' | ...
  whatsapp_sent_at  timestamptz,
  email_sent_at     timestamptz,
  link_clicked_at   timestamptz,
  converted_at      timestamptz,                 -- copiado de orders.paid_at quando virar venda
  whatsapp_status   varchar(20),                 -- queued | sent | failed | banned
  whatsapp_error    text,
  email_status      varchar(20),                 -- queued | sent | bounced | failed
  email_error       text,
  approved_by       varchar(40),                 -- 'manual' | 'auto'
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 1 lead so pode receber 1x cada campanha
CREATE UNIQUE INDEX IF NOT EXISTS promo_campaigns_unique_order_camp
  ON promo_campaigns(order_id, campaign_name);

-- Lookup por campanha+status — usado pelo cron monitor
CREATE INDEX IF NOT EXISTS promo_campaigns_camp_status
  ON promo_campaigns(campaign_name, whatsapp_sent_at);

-- Lookup por order (pra mostrar historico no admin)
CREATE INDEX IF NOT EXISTS promo_campaigns_order
  ON promo_campaigns(order_id);

COMMENT ON TABLE promo_campaigns IS
  'Controle de envios de campanhas promocionais (Dia dos Namorados 2026 etc).
  1 linha por (order_id, campaign_name). Anti-duplicidade garantida por UNIQUE.';
