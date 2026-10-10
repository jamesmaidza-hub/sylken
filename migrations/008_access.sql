-- Security section 1: access and roles (docs/security/requirements.md 1.x).
--  * roles become a set: assistant, dispenser, pharmacist, manager
--  * second factor (TOTP) for pharmacists and managers, with one-time recovery codes
--  * lockout after repeated failures
--  * sessions stored as token hashes, with idle and absolute limits
--  * a dispensed script is checked by someone other than the person who dispensed it

-- ---------------------------------------------------------------- roles
alter table users add column roles text[];
update users set roles = case role
  when 'owner' then array['pharmacist','manager']   -- the owner-pharmacist keeps everything they could do
  when 'pharmacist' then array['pharmacist']
  else array['assistant'] end;
alter table users alter column roles set not null;
alter table users drop column role;
alter table users add constraint users_roles_valid
  check (cardinality(roles) > 0 and roles <@ array['assistant','dispenser','pharmacist','manager']::text[]);

-- ---------------------------------------------------------------- second factor and lockout
alter table users
  add column totp_secret      text,          -- sealed with the server key (src/security/crypto.ts), never plain
  add column totp_enabled_at  timestamptz,   -- null until the first code has been typed back correctly
  add column totp_last_step   bigint,        -- last 30-second step used, so a code can't be replayed
  add column failed_logins    integer not null default 0,
  add column locked_until     timestamptz,
  add column password_changed_at timestamptz not null default now();

create table recovery_codes (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  text not null,                  -- sha-256 of a random code; the code itself is shown once
  used_at    timestamptz,
  primary key (user_id, code_hash)
);
alter table recovery_codes enable row level security;
alter table recovery_codes force row level security;
create policy tenant_isolation on recovery_codes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Login runs before a pharmacy is known, so it reads through this narrow function.
drop function auth_lookup(text);
create function auth_lookup(p_email text)
returns table (user_id uuid, tenant_id uuid, password_hash text, active boolean, roles text[],
               totp_enabled boolean, locked_until timestamptz)
language sql security definer set search_path = public as $$
  select id, tenant_id, password_hash, active, roles, totp_enabled_at is not null, locked_until
    from users where lower(email) = lower(p_email)
$$;

-- ---------------------------------------------------------------- sessions
-- Everyone logs in again after this migration. Only a hash of each token is kept, so a copy
-- of the database can't be used to take over a session.
drop table sessions;
create table sessions (
  token_hash    text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  mfa_pending   boolean not null default false,   -- password checked, second factor still owed
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,             -- absolute end, however active the session is
  ip            text,
  user_agent    text
);
create index sessions_user on sessions (user_id);

-- ---------------------------------------------------------------- independent checking
-- A dispensed script is checked once, by someone other than the person who dispensed it.
create table script_checks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  script_id   uuid not null unique references scripts(id),
  checked_by  uuid not null references users(id),
  checked_at  timestamptz not null default now()
);
alter table script_checks enable row level security;
alter table script_checks force row level security;
create policy tenant_isolation on script_checks
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create function script_check_guard() returns trigger language plpgsql as $$
declare s record;
begin
  if tg_op <> 'INSERT' then
    if tg_op = 'DELETE' and current_setting('sylken.purge', true) = 'on' then return old; end if;
    raise exception 'a script check is a record and is never changed';
  end if;
  select status, dispensed_by into s from scripts where id = new.script_id;
  if s.status is distinct from 'dispensed' then
    raise exception 'only a dispensed script can be checked';
  end if;
  if s.dispensed_by is not null and s.dispensed_by = new.checked_by then
    raise exception 'the person who dispensed a script cannot check it' using errcode = 'P0001', hint = 'own_check';
  end if;
  return new;
end $$;
create trigger script_checks_guard before insert or update or delete on script_checks
  for each row execute function script_check_guard();
