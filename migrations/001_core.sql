-- sylken stage 1: tenants, items, stock ledger, receiving, stock takes.
-- Every business table carries tenant_id and is protected by row-level security.
-- The app connects as sylken_app (no BYPASSRLS) and sets app.tenant_id per transaction.

create extension if not exists pg_trgm;

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name        text not null,
  address     text,
  phone       text,
  country     text not null default 'BW',
  currency    text not null default 'BWP',
  created_at  timestamptz not null default now()
);

-- Shop-specific rules live here, never in code.
create table tenant_settings (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  vat_rate               numeric(6,4) not null default 0.14,     -- Botswana standard VAT
  default_markup         numeric(8,4) not null default 0.50,     -- on cost, before VAT
  retail_rounding        numeric(8,2) not null default 0.01,     -- round retail up to this step
  allow_negative_stock   boolean not null default false,         -- block selling stock never received
  minmax_min_days        integer not null default 7,             -- min = ADU x this
  minmax_max_days        integer not null default 28,            -- max = ADU x this
  minmax_usage_months    integer not null default 6,             -- months of sales used for ADU
  max_sane_cost          numeric(14,2) not null default 50000,   -- costs above this are quarantined on import
  updated_at             timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  email          text not null,
  name           text not null,
  role           text not null check (role in ('owner','pharmacist','assistant')),
  password_hash  text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (tenant_id, email)
);
create unique index users_email_global on users (lower(email));

create table sessions (
  token       text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  expires_at  timestamptz not null
);

create table suppliers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  code        text,
  name        text not null,
  phone       text,
  email       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create table bins (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  unique (tenant_id, name)
);

-- Item master. Prices are per pack; stock is counted in units (pack_size units per pack).
create table items (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  stock_code         text not null,
  description        text not null default '',
  pack_size          integer not null default 1 check (pack_size > 0),
  pack_size_known    boolean not null default false,
  sell_loose         boolean not null default false,          -- may be sold per unit
  cost_per_pack      numeric(14,4),                           -- last cost, excl VAT
  avg_cost_per_pack  numeric(14,4),                           -- weighted average cost
  retail_per_pack    numeric(14,2) not null default 0,        -- selling price incl VAT
  vat_rate           numeric(6,4),                            -- null = tenant default
  markup_override    numeric(8,4),                            -- null = tenant default
  schedule           smallint,                                -- drug schedule, null = unknown
  status             text not null default 'active'
                       check (status in ('active','dormant','quarantined','discontinued')),
  status_reason      text,
  supplier_id        uuid references suppliers(id),
  external_refs      jsonb not null default '{}'::jsonb,      -- e.g. {"compharm_stock_id": 28}
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, stock_code)
);
create index items_desc_trgm on items using gin (description gin_trgm_ops);
create index items_tenant_status on items (tenant_id, status);

create table item_barcodes (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  barcode    text not null,
  primary key (tenant_id, barcode)
);
create index item_barcodes_item on item_barcodes (item_id);

create table item_bins (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  bin_id     uuid not null references bins(id) on delete cascade,
  position   smallint not null default 1,
  primary key (item_id, bin_id)
);

-- Current stock per item, maintained only by the ledger trigger below.
create table stock_levels (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  item_id        uuid primary key references items(id) on delete cascade,
  on_hand_units  integer not null default 0,
  min_units      numeric(14,3),                -- reorder levels may be fractional (Compharm derives them from usage)
  max_units      numeric(14,3),
  minmax_source  text check (minmax_source in ('manual','calculated','imported')),
  updated_at     timestamptz not null default now()
);

create table adjustment_reasons (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  code       text not null,
  label      text not null,
  active     boolean not null default true,
  primary key (tenant_id, code)
);

-- The stock ledger. Append-only. id may be generated by the client (offline tills)
-- so re-sending the same movement is a no-op.
create table stock_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  item_id         uuid not null references items(id),
  kind            text not null check (kind in
                    ('opening','receipt','supplier_return','sale','sale_return',
                     'dispense','adjustment','stocktake','transfer_in','transfer_out')),
  qty_units       integer not null check (qty_units <> 0),   -- signed: + into stock, - out
  unit_cost       numeric(16,6),                             -- excl VAT, per unit
  unit_retail     numeric(16,6),                             -- incl VAT, per unit
  reason_code     text,
  ref_type        text,                                      -- 'supplier_invoice', 'stock_take', ...
  ref_id          uuid,
  note            text,
  user_id         uuid references users(id),
  device_id       text,                                      -- till or station that recorded it
  occurred_at     timestamptz not null default now(),
  recorded_at     timestamptz not null default now()
);
create index stock_movements_item_time on stock_movements (item_id, occurred_at);
create index stock_movements_tenant_kind_time on stock_movements (tenant_id, kind, occurred_at);

create function stock_movement_apply() returns trigger language plpgsql as $$
begin
  insert into stock_levels (tenant_id, item_id, on_hand_units)
       values (new.tenant_id, new.item_id, new.qty_units)
  on conflict (item_id) do update
       set on_hand_units = stock_levels.on_hand_units + excluded.on_hand_units,
           updated_at = now();
  return new;
end $$;
create trigger stock_movements_apply after insert on stock_movements
  for each row execute function stock_movement_apply();

create function stock_movement_immutable() returns trigger language plpgsql as $$
begin
  -- Only deleting a whole tenant (sylken.purge = on) may remove ledger rows.
  if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'stock movements are append-only; post a correcting movement instead';
end $$;
create trigger stock_movements_immutable before update or delete on stock_movements
  for each row execute function stock_movement_immutable();

-- Effective-dated price history (cost excl VAT, retail incl VAT, both per pack).
create table price_history (
  id               bigserial primary key,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  item_id          uuid not null references items(id) on delete cascade,
  cost_per_pack    numeric(14,4),
  retail_per_pack  numeric(14,2),
  effective_from   timestamptz not null,
  source           text not null,                            -- 'import', 'receipt', 'manual', 'reprice'
  user_id          uuid references users(id)
);
create index price_history_item on price_history (item_id, effective_from);

-- Monthly usage imported from the old system (history before sylken's own ledger).
create table usage_history (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  item_id          uuid not null references items(id) on delete cascade,
  period           date not null,                            -- first day of month
  sold_units       integer not null default 0,
  purchased_units  integer not null default 0,
  source           text not null,
  primary key (item_id, period, source)
);

create table supplier_invoices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  supplier_id   uuid not null references suppliers(id),
  invoice_no    text not null,
  invoice_date  date not null,
  status        text not null default 'draft' check (status in ('draft','posted')),
  note          text,
  posted_at     timestamptz,
  posted_by     uuid references users(id),
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  unique (tenant_id, supplier_id, invoice_no)
);

create table supplier_invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  invoice_id       uuid not null references supplier_invoices(id) on delete cascade,
  item_id          uuid not null references items(id),
  qty_packs        numeric(12,3) not null default 0,
  bonus_packs      numeric(12,3) not null default 0,         -- free stock, no cost
  cost_per_pack    numeric(14,4) not null,                   -- excl VAT
  update_retail    boolean not null default true,            -- reprice by markup rule on post
  line_no          integer not null
);

create table stock_takes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  bin_id      uuid references bins(id),                      -- null = whole shop
  status      text not null default 'counting' check (status in ('counting','posted','cancelled')),
  started_at  timestamptz not null default now(),
  started_by  uuid references users(id),
  posted_at   timestamptz,
  posted_by   uuid references users(id)
);

create table stock_take_lines (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  stock_take_id    uuid not null references stock_takes(id) on delete cascade,
  item_id          uuid not null references items(id),
  expected_units   integer not null,                         -- snapshot when the count started
  counted_units    integer,
  counted_at       timestamptz,
  counted_by       uuid references users(id),
  primary key (stock_take_id, item_id)
);

create table audit_log (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid references users(id),
  action      text not null,
  entity      text not null,
  entity_id   text,
  detail      jsonb,
  at          timestamptz not null default now()
);

-- Row-level security: one policy per tenant table.
do $$
declare t text;
begin
  foreach t in array array['tenant_settings','users','suppliers','bins','items','item_barcodes',
    'item_bins','stock_levels','adjustment_reasons','stock_movements','price_history',
    'usage_history','supplier_invoices','supplier_invoice_lines','stock_takes',
    'stock_take_lines','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
