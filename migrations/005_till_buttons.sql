-- Quick-sale buttons for the till's touch layout: the shop picks the items it sells most,
-- each with a short label and a colour. Stored as a list of {code, label, color}.

alter table tenant_settings
  add column till_buttons jsonb not null default '[]';
