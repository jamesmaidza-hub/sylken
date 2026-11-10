-- Handheld scanner uploads (CipherLab and similar batch terminals). The file the handheld made is
-- kept exactly as uploaded, with a fingerprint, so every count it added can be traced back to it
-- and the same file can't be added to a count twice. Uploading only fills in counts: stock moves
-- when someone with stock take rights reviews the differences and posts the count.

create table stock_take_uploads (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  stock_take_id  uuid not null references stock_takes(id) on delete cascade,
  file_name      text not null,
  file_sha256    text not null,
  raw_text       text not null,
  qty_unit       text not null check (qty_unit in ('packs','units')),
  mode           text not null check (mode in ('add','set')),
  status         text not null default 'pending' check (status in ('pending','added','discarded')),
  scans          integer not null,                         -- readable lines in the file
  matched_items  integer not null,
  unknown_codes  jsonb not null default '[]',              -- [{code, qty}] not found in the item list
  skipped_lines  jsonb not null default '[]',              -- [{line, text, reason}]
  uploaded_by    uuid references users(id),
  uploaded_at    timestamptz not null default now(),
  decided_by     uuid references users(id),
  decided_at     timestamptz
);
create index stock_take_uploads_take on stock_take_uploads (stock_take_id, uploaded_at);
-- A file's counts go into a stock take at most once.
create unique index stock_take_uploads_once on stock_take_uploads (stock_take_id, file_sha256) where status = 'added';

alter table stock_take_uploads enable row level security;
alter table stock_take_uploads force row level security;
create policy tenant_isolation on stock_take_uploads
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The file and what it said never change; only a pending upload can be marked added or discarded.
create function stock_take_upload_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('sylken.purge', true) = 'on' then return old; end if;
    raise exception 'scanner uploads are kept as a record and are never deleted';
  end if;
  if old.status <> 'pending' or new.status = 'pending'
     or (new.raw_text, new.file_sha256, new.file_name, new.qty_unit, new.mode, new.scans, new.matched_items,
         new.unknown_codes, new.skipped_lines, new.uploaded_by, new.uploaded_at, new.stock_take_id, new.tenant_id)
        is distinct from
        (old.raw_text, old.file_sha256, old.file_name, old.qty_unit, old.mode, old.scans, old.matched_items,
         old.unknown_codes, old.skipped_lines, old.uploaded_by, old.uploaded_at, old.stock_take_id, old.tenant_id) then
    raise exception 'a scanner upload can only be added or discarded once, and its file never changes';
  end if;
  return new;
end $$;
create trigger stock_take_uploads_guard before update or delete on stock_take_uploads
  for each row execute function stock_take_upload_guard();
