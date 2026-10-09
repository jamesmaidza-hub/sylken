-- sylken stage 3: dispensing. Patients (main members and dependants), doctors, medical aids,
-- allergies and alerts, scripts with lines, labels, owed items, repeats and the register of
-- scheduled medicines. A script is a draft until a pharmacist dispenses it; from then on it is
-- never edited, only reversed. The register is read from the stock ledger, so it can't drift.

alter table tenant_settings
  add column dispensing_fee      numeric(10,2) not null default 0,       -- per script line, incl VAT
  add column default_supply_days integer not null default 30,
  add column repeat_valid_days   integer not null default 180,           -- repeats may be dispensed this long after the script date
  add column register_schedules  smallint[] not null default '{}',       -- schedules kept in the controlled-medicine register
  add column label_width_mm      integer not null default 59,
  add column label_height_mm     integer not null default 46,
  add column label_footer        text default 'Keep out of reach of children';

-- The shop's own list of medical aids. Claim rules and fee models come with stage 4.
create table medical_aids (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  code        text,
  message     text,                                        -- shown on every script for its members
  active      boolean not null default true,
  unique (tenant_id, name)
);

create table doctors (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  surname      text not null,
  initials     text,
  title        text not null default 'Dr',
  practice_no  text,
  phone        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index doctors_surname on doctors (tenant_id, upper(surname));

-- A patient is a main member (or private patient) or a dependant under a main member.
-- Medical aid and member number are kept on the main member only; dependants use theirs.
create table patients (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  surname         text not null,
  first_names     text,
  title           text,
  id_no           text,                                    -- Omang or passport number
  date_of_birth   date,
  sex             text check (sex in ('F','M','X')),
  phone           text,
  address         text,
  main_member_id  uuid references patients(id),
  medical_aid_id  uuid references medical_aids(id),
  member_no       text,
  dependant_code  text,                                    -- "00" for the main member, "01", "02"... for dependants
  doctor_id       uuid references doctors(id),             -- usual doctor
  account_id      uuid references customer_accounts(id),   -- customer account the patient's share goes on
  notes           text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (main_member_id is null or (medical_aid_id is null and member_no is null)),
  check (main_member_id is distinct from id)
);
create index patients_surname_trgm on patients using gin (upper(surname) gin_trgm_ops);
create index patients_member_no on patients (tenant_id, member_no);
create index patients_id_no on patients (tenant_id, id_no);
create index patients_main on patients (main_member_id);

-- Allergies and alerts shown on every script for the patient. Removed ones are kept for the record.
create table patient_flags (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  patient_id  uuid not null references patients(id) on delete cascade,
  kind        text not null check (kind in ('allergy','alert')),
  text        text not null,
  detail      text,                                        -- e.g. the reaction
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  removed_by  uuid references users(id),
  removed_at  timestamptz
);
create index patient_flags_patient on patient_flags (patient_id);

-- Directions for labels, typed as a short code and expanded.
create table directions (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  code       text not null,
  text       text not null,
  primary key (tenant_id, code)
);

create table scripts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  script_no       integer,                                 -- given when dispensed
  status          text not null default 'draft' check (status in ('draft','dispensed','reversed')),
  patient_id      uuid not null references patients(id),
  doctor_id       uuid references doctors(id),
  rx_date         date not null,                           -- date written on the prescription
  repeat_of       uuid references scripts(id),             -- the original script, when this supplies a repeat
  bill_medical_aid boolean not null default true,          -- false: the patient pays even though they have a medical aid
  -- Medical aid as it stood when dispensed, kept for claims (stage 4).
  medical_aid_id  uuid references medical_aids(id),
  member_no       text,
  dependant_code  text,
  total           numeric(12,2) not null default 0,        -- incl VAT
  vat             numeric(12,2) not null default 0,
  cost            numeric(14,4) not null default 0,        -- excl VAT, of the full prescribed quantity
  fees            numeric(12,2) not null default 0,
  claim_total     numeric(12,2) not null default 0,        -- to claim from the medical aid
  patient_total   numeric(12,2) not null default 0,        -- for the patient to pay
  note            text,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  dispensed_by    uuid references users(id),
  dispensed_at    timestamptz,
  reversed_by     uuid references users(id),
  reversed_at     timestamptz,
  reverse_reason  text,
  unique (tenant_id, script_no)
);
create index scripts_patient on scripts (patient_id, created_at);
create index scripts_dispensed on scripts (tenant_id, dispensed_at);

create table script_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  script_id       uuid not null references scripts(id) on delete cascade,
  line_no         integer not null,
  item_id         uuid not null references items(id),
  qty_units       integer not null check (qty_units > 0),  -- prescribed for this supply, charged in full
  supply_units    integer not null check (supply_units >= 0),  -- handed over now; the rest is owed
  directions      text not null,
  supply_days     integer check (supply_days > 0),
  repeats         smallint not null default 0 check (repeats >= 0),  -- further supplies allowed (original scripts)
  repeat_of_line  uuid references script_lines(id),        -- on a repeat: the original script's line
  icd10           text[] not null default '{}',
  no_claim        boolean not null default false,          -- patient pays for this line even on medical aid
  item_total      numeric(12,2) not null default 0,        -- incl VAT
  fee             numeric(12,2) not null default 0,        -- incl VAT
  line_total      numeric(12,2) not null default 0,
  vat_rate        numeric(6,4) not null default 0,
  line_vat        numeric(12,2) not null default 0,
  unit_cost       numeric(16,6),                           -- excl VAT
  check (supply_units <= qty_units),
  unique (script_id, line_no)
);
create index script_lines_item on script_lines (item_id);
create index script_lines_repeat on script_lines (repeat_of_line);

-- What a dispensed script still owes the patient, and each later supply against it.
create table owed_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  script_line_id  uuid not null unique references script_lines(id),
  qty_units       integer not null check (qty_units > 0),
  cancelled_at    timestamptz,
  cancelled_by    uuid references users(id),
  cancel_reason   text,
  created_at      timestamptz not null default now()
);

create table owed_supplies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  owed_item_id  uuid not null references owed_items(id),
  qty_units     integer not null check (qty_units > 0),
  supplied_by   uuid references users(id),
  supplied_at   timestamptz not null default now()
);
create index owed_supplies_owed on owed_supplies (owed_item_id);

-- A script paid at the till: the sale says which script, and its script lines took no stock
-- (the stock left when the script was dispensed).
alter table sales add column script_id uuid references scripts(id);
alter table sale_lines add column script_line_id uuid references script_lines(id);
create index sales_script on sales (script_id) where script_id is not null;

do $$
declare t text;
begin
  foreach t in array array['medical_aids','doctors','patients','patient_flags','directions','scripts','script_lines',
    'owed_items','owed_supplies']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;

-- A dispensed script is a legal record: it may only be reversed, never changed or deleted.
create function script_guard() returns trigger language plpgsql as $$
declare keep text[] := array['status','reversed_by','reversed_at','reverse_reason'];
begin
  if current_setting('sylken.purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if old.status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and old.status = 'dispensed' and new.status = 'reversed'
     and (to_jsonb(new) - keep) = (to_jsonb(old) - keep) then
    return new;
  end if;
  raise exception 'script % is dispensed and can only be reversed', old.script_no;
end $$;
create trigger scripts_guard before update or delete on scripts for each row execute function script_guard();

create function script_line_guard() returns trigger language plpgsql as $$
declare st text;
begin
  if current_setting('sylken.purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into st from scripts where id = case when tg_op = 'INSERT' then new.script_id else old.script_id end;
  if st is null and tg_op = 'DELETE' then
    return old;                               -- a draft being discarded takes its lines with it
  end if;
  if st is distinct from 'draft' then
    raise exception 'lines of a dispensed script cannot be changed';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger script_lines_guard before insert or update or delete on script_lines for each row execute function script_line_guard();

create function owed_supply_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'owed supplies are a record of stock handed over and are never changed';
end $$;
create trigger owed_supplies_immutable before update or delete on owed_supplies for each row execute function owed_supply_immutable();

-- Pharmacies created before dispensing existed get the starter list of label directions.
insert into directions (tenant_id, code, text)
select t.id, d.code, d.text from tenants t cross join (values
  ('1T1D', 'Take ONE tablet ONCE a day'),
  ('1T2D', 'Take ONE tablet TWICE a day'),
  ('1T3D', 'Take ONE tablet THREE times a day'),
  ('1T4D', 'Take ONE tablet FOUR times a day'),
  ('2T3D', 'Take TWO tablets THREE times a day'),
  ('1TN', 'Take ONE tablet at NIGHT'),
  ('1TM', 'Take ONE tablet in the MORNING'),
  ('1C2D', 'Take ONE capsule TWICE a day'),
  ('1C3D', 'Take ONE capsule THREE times a day'),
  ('5ML3D', 'Take 5 ml THREE times a day'),
  ('10ML3D', 'Take 10 ml THREE times a day'),
  ('PRN', 'Use when needed, as directed'),
  ('APPLY2D', 'Apply thinly TWICE a day'),
  ('AD', 'Use as directed')
) as d(code, text)
on conflict do nothing;
