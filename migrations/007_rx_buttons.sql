-- Quick buttons for the dispensary's touch layout: the items the shop dispenses most,
-- in the same {code, label, color} form as the till's buttons.

alter table tenant_settings
  add column rx_buttons jsonb not null default '[]';
