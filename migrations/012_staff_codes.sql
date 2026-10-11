-- Every sale is rung under a cashier's 2-letter code and every script is started under a dispenser's.
-- The code belongs to a login (unique within the pharmacy) and is copied onto the sale or script when it is recorded,
-- so the record keeps the code even if the person later leaves or their code changes.

alter table users add column staff_code text check (staff_code ~ '^[A-Z]{2}$');
create unique index users_staff_code on users (tenant_id, staff_code) where staff_code is not null;

alter table sales add column cashier_code text check (cashier_code ~ '^[A-Z]{2}$');
alter table scripts add column initiated_code text check (initiated_code ~ '^[A-Z]{2}$');
