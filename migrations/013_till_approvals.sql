-- Supervisor approval at the till. A discount, a price change or a refund needs a supervisor (or manager) to type their
-- staff code and second PIN; the till gets an approval id back and sends it with the sale. The server checks each
-- discounted, re-priced or refunded sale against its approvals, and an approval is used for one sale only.

create table till_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  approver_id    uuid not null references users(id),
  approver_code  text not null,
  action         text not null check (action in ('discount','price','refund')),
  cashier_id     uuid references users(id),                  -- the login at the till when it was asked
  detail         jsonb not null default '{}',
  issued_at      timestamptz not null default now(),
  used_sale_id   uuid references sales(id)
);
create index till_approvals_open on till_approvals (tenant_id, issued_at) where used_sale_id is null;

alter table till_approvals enable row level security;
alter table till_approvals force row level security;
create policy tenant_isolation on till_approvals
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
