-- Till operating rules (james, 2026-10-11): blind opening and closing, one open run per till, runs
-- anchored to a cashier, supervisor approval for discounts over the cashier limit, price overrides,
-- voids, refunds and cash payouts, a change limit, card approval codes or gateway tokens, logged
-- no-sales, cash drops, counted notes and coins, and a Z report that locks the run.

-- ---------------------------------------------------------------- shop limits
alter table tenant_settings
  add column max_change            numeric(12,2) not null default 200  check (max_change >= 0),           -- more change than this is refused (a typing slip)
  add column cash_drop_threshold   numeric(12,2) not null default 2000 check (cash_drop_threshold >= 0),  -- cash in the drawer above this asks for a cash drop
  add column cashier_discount_pct  numeric(5,2)  not null default 10   check (cashier_discount_pct between 0 and 100),  -- discounts above this need a supervisor
  add column card_terminal         text not null default 'standalone' check (card_terminal in ('standalone','integrated'));

-- ---------------------------------------------------------------- supervisor approvals
-- A supervisor typed their staff code and second PIN on the till to allow one thing on one sale
-- (or one drawer entry). The row is the proof; the sale or entry points at it.
create table till_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  till_id        uuid not null references tills(id),
  subject_id     uuid not null,                                     -- the sale or till entry it was given for (made by the till)
  action         text not null check (action in ('discount','price_override','void','refund','petty_cash','no_sale','cash_drop')),
  detail         jsonb not null default '{}',
  approved_by    uuid not null references users(id),
  approver_code  text,
  cashier_code   text,
  at             timestamptz not null default now()
);
create index till_approvals_subject on till_approvals (subject_id);

-- ---------------------------------------------------------------- runs: one open per till, anchored to a cashier
alter table till_runs
  add column cashier_id      uuid references users(id),             -- whose drawer this is: the cashier who counted the float in
  add column cashier_code    text check (cashier_code ~ '^[A-Z]{2}$'),
  add column expected_float  numeric(12,2),                         -- what the last run on this till left in the drawer; managers only
  add column recorded_at     timestamptz not null default now();     -- server time the run reached the server
update till_runs set cashier_id = opened_by where cashier_id is null;

-- ---------------------------------------------------------------- sales: why a line's price changed, refunds, card tokens
alter table sales add column refund_approval_id uuid references till_approvals(id);
alter table sale_lines
  add column adjust       text check (adjust in ('discount','override')),   -- null: charged at the list price
  add column approval_id  uuid references till_approvals(id);
alter table sale_payments
  add column gateway_token    text,                                 -- from an integrated card terminal
  add column gateway_payload  jsonb;

-- ---------------------------------------------------------------- cash drops
alter table till_entries drop constraint till_entries_kind_check;
alter table till_entries add constraint till_entries_kind_check check (kind in ('petty_cash','account_payment','cash_drop'));
alter table till_entries add column approval_id uuid references till_approvals(id);
alter table till_entries add constraint till_entries_drop_approved check (kind <> 'cash_drop' or (approval_id is not null and tender = 'cash'));

-- ---------------------------------------------------------------- till events: no-sales, voids, price mismatches
create table till_events (
  id           uuid primary key,                                    -- made by the till
  tenant_id    uuid not null references tenants(id) on delete cascade,
  till_id      uuid not null references tills(id),
  till_run_id  uuid references till_runs(id),
  kind         text not null check (kind in ('no_sale','void','price_mismatch')),
  priority     text not null default 'normal' check (priority in ('normal','high')),
  reason       text,
  detail       jsonb not null default '{}',
  approval_id  uuid references till_approvals(id),
  cashier_code text,
  user_id      uuid references users(id),
  occurred_at  timestamptz not null,
  recorded_at  timestamptz not null default now()
);
create index till_events_run on till_events (till_run_id, occurred_at);
create index till_events_time on till_events (tenant_id, occurred_at);

-- ---------------------------------------------------------------- cash-up: notes and coins counted, variance, Z report
create table till_run_cash_counts (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  till_run_id   uuid not null references till_runs(id) on delete cascade,
  denomination  numeric(8,2) not null check (denomination > 0),
  qty           integer not null check (qty >= 0),
  primary key (till_run_id, denomination)
);
alter table till_run_counts add column variance numeric(12,2) generated always as (counted - expected) stored;

create table z_reports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  till_run_id  uuid not null unique references till_runs(id),
  z_no         integer not null,
  payload      jsonb not null,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  unique (tenant_id, z_no)
);

-- What is waiting to go to the accounting system or a central server. Nothing is linked yet, so
-- rows wait as 'no_target' until one is set up; the Z report itself is complete either way.
create table export_outbox (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('z_report')),
  ref_id      uuid not null,
  payload     jsonb not null,
  status      text not null default 'no_target' check (status in ('no_target','pending','sent','failed')),
  target      text,
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['till_approvals','till_events','till_run_cash_counts','z_reports','export_outbox']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- records that are never changed
create function till_record_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then
    return old;
  end if;
  raise exception '% are records of what happened at the till and are never changed or deleted', replace(tg_table_name, '_', ' ');
end $$;
do $$
declare t text;
begin
  foreach t in array array['till_entries','till_run_counts','till_approvals','till_events','till_run_cash_counts','z_reports']
  loop
    execute format('create trigger %I before update or delete on %I for each row execute function till_record_immutable()', t || '_immutable', t);
  end loop;
end $$;

-- A till has at most one open run, and a cashed-up run is locked. The only change an open run can
-- take is being cashed up.
create function till_run_guard() returns trigger language plpgsql as $$
declare other integer;
begin
  if tg_op = 'DELETE' then
    if current_setting('sylken.purge', true) = 'on' then return old; end if;
    raise exception 'till runs are never deleted';
  end if;
  if tg_op = 'INSERT' then
    perform 1 from tills where id = new.till_id for update;        -- one run opening at a time per till
    select run_no into other from till_runs where till_id = new.till_id and status = 'open' limit 1;
    if found then
      raise exception 'this till already has run % open; cash it up before opening another', other using errcode = 'P0001', hint = 'run_open';
    end if;
    if new.status <> 'open' then raise exception 'a run starts open'; end if;
    return new;
  end if;
  if old.status = 'closed' then
    raise exception 'run % has been cashed up and is locked', old.run_no;
  end if;
  if new.status <> 'closed' or new.id <> old.id or new.till_id <> old.till_id or new.run_no <> old.run_no
     or new.opening_float <> old.opening_float or new.opened_at <> old.opened_at
     or new.opened_by is distinct from old.opened_by or new.cashier_id is distinct from old.cashier_id
     or new.cashier_code is distinct from old.cashier_code or new.expected_float is distinct from old.expected_float
     or new.recorded_at <> old.recorded_at then
    raise exception 'an open run can only be cashed up, not changed';
  end if;
  return new;
end $$;
create trigger till_runs_guard before insert or update or delete on till_runs for each row execute function till_run_guard();
