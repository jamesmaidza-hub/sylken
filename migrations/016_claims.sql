-- Medical aid claims: dispensed scripts sent as Allegra Connect XML batch files (the format AFA
-- uses for Pula Medical Aid Fund). A batch is kept exactly as it was sent and never changed, so
-- every claim can be traced to the file it went in. A script is claimed once; if it is reversed
-- after it was sent, the next batch carries a reversal for it.

alter table tenant_settings
  add column practice_no text;                             -- the pharmacy's practice (BHF) number with the medical aids

create table claim_batches (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  batch_no        integer not null,
  medical_aid_id  uuid not null references medical_aids(id),
  test            boolean not null,                        -- test batches go to the medical aid's test server and don't count as claimed
  date_from       date not null,
  date_to         date not null,
  num_claims      integer not null,
  total           numeric(12,2) not null,
  file_name       text not null,
  xml             text not null,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  unique (tenant_id, batch_no)
);
create index claim_batches_created on claim_batches (tenant_id, created_at);

create table claim_batch_scripts (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  batch_id    uuid not null references claim_batches(id),
  script_id   uuid not null references scripts(id),
  kind        text not null check (kind in ('Request','Reversal')),
  test        boolean not null,
  amount      numeric(12,2) not null,
  primary key (batch_id, script_id, kind)
);
-- Outside test batches a script is claimed at most once, and reversed at most once.
create unique index claim_batch_scripts_once on claim_batch_scripts (script_id, kind) where not test;

do $$
declare t text;
begin
  foreach t in array array['claim_batches','claim_batch_scripts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;

create function claim_batch_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'claim batches are a record of what was sent and are never changed';
end $$;
create trigger claim_batches_immutable before update or delete on claim_batches for each row execute function claim_batch_immutable();
create trigger claim_batch_scripts_immutable before update or delete on claim_batch_scripts for each row execute function claim_batch_immutable();
