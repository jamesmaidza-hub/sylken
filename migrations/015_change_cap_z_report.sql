-- Largest change the till will give, the bill-and-coin count at cash-up, and the Z-report.

-- A cap on change, so a mistyped amount (P1000 instead of P100) is stopped. 0 = no limit.
alter table tenant_settings
  add column max_change numeric(12,2) not null default 500 check (max_change >= 0);

-- How many of each note and coin were in the drawer when a run was cashed up: { "200": 1, "0.5": 4, ... }.
alter table till_runs add column cash_breakdown jsonb;

-- The Z-report: a frozen summary of a run, made when it is cashed up, numbered in order, and never changed.
create table z_reports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  till_run_id   uuid not null unique references till_runs(id),
  z_no          integer not null,
  generated_at  timestamptz not null default now(),
  generated_by  uuid references users(id),
  payload       jsonb not null,
  unique (tenant_id, z_no)
);
alter table z_reports enable row level security;
alter table z_reports force row level security;
create policy tenant_isolation on z_reports
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create function z_report_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'a Z-report is a record and is never changed or deleted';
end $$;
create trigger z_reports_immutable before update or delete on z_reports for each row execute function z_report_immutable();

-- Once a run is cashed up its row is locked: it cannot be reopened, re-dated or re-floated. (Sales that reach the
-- server after cash-up are still accepted and flagged late; they are separate rows.)
create function till_run_locked() returns trigger language plpgsql as $$
begin
  if current_setting('sylken.purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.status = 'closed' then
    raise exception 'run % is cashed up and locked', old.run_no;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger till_runs_locked before update or delete on till_runs for each row execute function till_run_locked();
