-- Login happens before a tenant is known, so it can't go through row-level security.
-- This function returns only what login needs, for one email address.
create function auth_lookup(p_email text)
returns table (user_id uuid, tenant_id uuid, password_hash text, active boolean)
language sql security definer set search_path = public as $$
  select id, tenant_id, password_hash, active from users where lower(email) = lower(p_email)
$$;
