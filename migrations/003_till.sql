-- sylken stage 2: tills, till runs, sales with tenders, petty cash, customer accounts, cash-up.
-- Sales, runs and till entries carry ids made by the till itself, so an offline till can resend
-- them safely. Amounts are in Pula incl VAT; refunds are stored with negative amounts.

alter table tenant_settings
  add column default_float   numeric(12,2) not null default 0,     -- cash left in the drawer to start a run
  add column vat_number      text,                                 -- printed on till slips
  add column receipt_footer  text,
  add column timezone        text not null default 'Africa/Gaborone',  -- trading days are counted in shop time
  add column cash_rounding   numeric(6,2) not null default 0.05;       -- cash due is rounded to this (5 thebe); 0.01 = none

-- Per-tenant counters (till run numbers, sale numbers).
create table tenant_counters (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  value      bigint not null default 0,
  primary key (tenant_id, name)
);

create table tills (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  code          text not null,                                     -- short, printed on slips: "T1"
  name          text not null,
  active        boolean not null default true,
  last_seen_at  timestamptz,                                       -- last time the till synced
  last_pending  integer,                                           -- what it still had queued then
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);

-- A till run is one drawer session (a shift), from opening float to cash-up.
create table till_runs (
  id             uuid primary key,                                 -- made by the till
  tenant_id      uuid not null references tenants(id) on delete cascade,
  till_id        uuid not null references tills(id),
  run_no         integer not null,
  opening_float  numeric(12,2) not null default 0 check (opening_float >= 0),
  opened_at      timestamptz not null,
  opened_by      uuid references users(id),
  status         text not null default 'open' check (status in ('open','closed')),
  closed_at      timestamptz,
  closed_by      uuid references users(id),
  float_kept     numeric(12,2),                                    -- cash left in the drawer after cash-up
  note           text,
  unique (tenant_id, run_no)
);
create index till_runs_till on till_runs (till_id, opened_at);

create table customer_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  account_no    text not null,
  name          text not null,
  phone         text,
  credit_limit  numeric(12,2),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, account_no)
);

-- Debtors ledger. Positive = the customer owes more. Balance = sum(amount).
create table account_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  account_id   uuid not null references customer_accounts(id),
  kind         text not null check (kind in ('charge','payment','adjustment')),
  amount       numeric(12,2) not null check (amount <> 0),
  ref_type     text,                                               -- 'sale', 'till_entry'
  ref_id       uuid,
  note         text,
  user_id      uuid references users(id),
  occurred_at  timestamptz not null default now()
);
create index account_entries_account on account_entries (account_id, occurred_at);

create table sales (
  id               uuid primary key,                               -- made by the till
  tenant_id        uuid not null references tenants(id) on delete cascade,
  sale_no          integer not null,
  till_run_id      uuid not null references till_runs(id),
  kind             text not null check (kind in ('sale','refund')),
  refund_of        uuid references sales(id),
  occurred_at      timestamptz not null,
  recorded_at      timestamptz not null default now(),
  user_id          uuid references users(id),
  account_id       uuid references customer_accounts(id),
  medical_aid      text,                                           -- scheme name for a medical aid tender
  member_no        text,
  total            numeric(12,2) not null,                         -- incl VAT; negative for refunds
  rounding         numeric(6,2) not null default 0,                -- cash rounding: payments = total + rounding
  vat              numeric(12,2) not null,
  cost             numeric(14,4) not null default 0,               -- excl VAT, at average cost
  cash_tendered    numeric(12,2),
  change_given     numeric(12,2),
  late             boolean not null default false,                 -- reached the server after its run was cashed up
  unique (tenant_id, sale_no)
);
create index sales_run on sales (till_run_id);
create index sales_time on sales (tenant_id, occurred_at);

create table sale_lines (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  sale_id      uuid not null references sales(id) on delete cascade,
  line_no      integer not null,
  item_id      uuid not null references items(id),
  qty_units    integer not null check (qty_units <> 0),            -- negative on refunds
  list_total   numeric(12,2) not null,                             -- at the item's price when rung up
  line_total   numeric(12,2) not null,                             -- what was charged, incl VAT
  vat_rate     numeric(6,4) not null,
  line_vat     numeric(12,2) not null,
  unit_cost    numeric(16,6),                                      -- excl VAT
  primary key (sale_id, line_no)
);
create index sale_lines_item on sale_lines (item_id);

create table sale_payments (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  sale_id    uuid not null references sales(id) on delete cascade,
  line_no    integer not null,
  tender     text not null check (tender in ('cash','card','cheque','eft','account','medical_aid')),
  amount     numeric(12,2) not null,                               -- applied to the sale (cash net of change)
  reference  text,                                                 -- card slip, cheque or EFT reference
  primary key (sale_id, line_no)
);

-- Money in or out of a drawer that is not a sale: petty cash paid out, account payments taken in.
create table till_entries (
  id           uuid primary key,                                   -- made by the till
  tenant_id    uuid not null references tenants(id) on delete cascade,
  till_run_id  uuid not null references till_runs(id),
  kind         text not null check (kind in ('petty_cash','account_payment')),
  tender       text not null check (tender in ('cash','card','cheque','eft')),
  amount       numeric(12,2) not null check (amount > 0),
  account_id   uuid references customer_accounts(id),
  note         text,
  user_id      uuid references users(id),
  occurred_at  timestamptz not null,
  recorded_at  timestamptz not null default now(),
  late         boolean not null default false
);
create index till_entries_run on till_entries (till_run_id);

-- What the system expected and what was counted, per tender, when a run was cashed up.
create table till_run_counts (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  till_run_id  uuid not null references till_runs(id) on delete cascade,
  tender       text not null,
  expected     numeric(12,2) not null,
  counted      numeric(12,2) not null,
  primary key (till_run_id, tender)
);

-- Anything a till sent that the server could not record, kept so nothing is lost silently.
create table till_rejects (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  till_id     uuid references tills(id),
  op          jsonb not null,
  error       text not null,
  resolved    boolean not null default false,
  at          timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['tenant_counters','tills','till_runs','customer_accounts','account_entries','sales',
    'sale_lines','sale_payments','till_entries','till_run_counts','till_rejects']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;

-- Sales, their lines and payments are records of money that changed hands: never edited.
-- A mistake is put right with a refund. Only deleting a whole pharmacy removes them.
create function sale_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'sales are never edited or deleted; ring up a refund instead';
end $$;
create trigger sales_immutable before update or delete on sales for each row execute function sale_immutable();
create trigger sale_lines_immutable before update or delete on sale_lines for each row execute function sale_immutable();
create trigger sale_payments_immutable before update or delete on sale_payments for each row execute function sale_immutable();

-- Pharmacies created before the till existed get one till to start with.
insert into tills (tenant_id, code, name) select id, 'T1', 'Till 1' from tenants on conflict do nothing;
