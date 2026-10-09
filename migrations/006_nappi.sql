-- NAPPI codes: the product code medical aids use on claims. Each shop types or imports its own;
-- sylken ships no NAPPI list. Script lines keep the code the item had, for stage 4 claims.

alter table items add column nappi_code text check (nappi_code ~ '^[0-9]{6,9}(-[0-9]{1,3})?$');
create index items_nappi on items (tenant_id, nappi_code) where nappi_code is not null;

alter table script_lines add column nappi_code text;
