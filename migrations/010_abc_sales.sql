-- Sales per item over a past period, imported from the old system, so the ABC list has something to rank
-- before sylken has trading history of its own. Kept apart from usage_history, which feeds suggested min/max
-- levels from whole months of units; this is a value for any date range.

create table abc_sales_snapshot (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  item_id      uuid not null references items(id) on delete cascade,
  period_from  date not null,
  period_to    date not null,
  qty_units    numeric(14,3) not null,
  sales_excl   numeric(14,2) not null,        -- excl VAT
  cost         numeric(14,2) not null,
  source       text not null,
  primary key (item_id, period_from, period_to, source),
  check (period_to >= period_from)
);
create index abc_sales_snapshot_tenant on abc_sales_snapshot (tenant_id, source, period_from);

alter table abc_sales_snapshot enable row level security;
alter table abc_sales_snapshot force row level security;
create policy tenant_isolation on abc_sales_snapshot
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
