-- The second step at login becomes a second PIN instead of an authenticator app (james,
-- 2026-10-11). The PIN is stored only as a salted scrypt hash, like the password. Anyone who
-- had set up an authenticator chooses a PIN at their next login.

alter table users add column second_pin_hash text;
alter table users drop column totp_secret, drop column totp_enabled_at, drop column totp_last_step;
drop table recovery_codes;

drop function auth_lookup(text);
create function auth_lookup(p_email text)
returns table (user_id uuid, tenant_id uuid, password_hash text, active boolean, roles text[],
               pin_set boolean, locked_until timestamptz)
language sql security definer set search_path = public as $$
  select id, tenant_id, password_hash, active, roles, second_pin_hash is not null, locked_until
    from users where lower(email) = lower(p_email)
$$;
