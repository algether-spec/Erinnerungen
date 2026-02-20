do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'shopping_items'
  ) and not exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'reminder_items'
  ) then
    execute 'alter table public.shopping_items rename to reminder_items';
  end if;
end
$$;

create table if not exists public.reminder_items (
  id bigint generated always as identity primary key,
  sync_code text not null,
  item_id text,
  text text not null,
  erledigt boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_codes (
  sync_code text primary key,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table public.reminder_items
  add column if not exists item_id text;

update public.reminder_items
set item_id = 'legacy-' || id::text
where item_id is null or length(trim(item_id)) = 0;

alter table public.reminder_items
  alter column item_id set not null;

insert into public.sync_codes (sync_code, last_used_at)
select distinct sync_code, now()
from public.reminder_items
where sync_code is not null and length(trim(sync_code)) > 0
on conflict (sync_code) do update
set last_used_at = greatest(public.sync_codes.last_used_at, excluded.last_used_at);

create index if not exists reminder_items_sync_code_idx
  on public.reminder_items (sync_code);

create index if not exists reminder_items_sync_code_position_idx
  on public.reminder_items (sync_code, position);

create unique index if not exists reminder_items_sync_code_item_id_uidx
  on public.reminder_items (sync_code, item_id);

create index if not exists sync_codes_last_used_at_idx
  on public.sync_codes (last_used_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_reminder_items_updated_at on public.reminder_items;
create trigger trg_reminder_items_updated_at
before update on public.reminder_items
for each row execute function public.set_updated_at();

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.reminder_items to anon, authenticated;
grant select, insert, update on public.sync_codes to anon, authenticated;

do $$
begin
  if exists (
    select 1 from pg_class where relkind = 'S' and relname = 'reminder_items_id_seq'
  ) then
    execute 'grant usage, select on sequence public.reminder_items_id_seq to anon, authenticated';
  end if;

  if exists (
    select 1 from pg_class where relkind = 'S' and relname = 'shopping_items_id_seq'
  ) then
    execute 'grant usage, select on sequence public.shopping_items_id_seq to anon, authenticated';
  end if;
end
$$;

alter table public.reminder_items enable row level security;
alter table public.sync_codes enable row level security;

drop policy if exists "reminder_items_select_by_code" on public.reminder_items;
create policy "reminder_items_select_by_code"
on public.reminder_items
for select
using (true);

drop policy if exists "reminder_items_insert_by_code" on public.reminder_items;
create policy "reminder_items_insert_by_code"
on public.reminder_items
for insert
with check (
  sync_code is not null and length(sync_code) > 0
  and item_id is not null and length(item_id) > 0
);

drop policy if exists "reminder_items_update_by_code" on public.reminder_items;
create policy "reminder_items_update_by_code"
on public.reminder_items
for update
using (true)
with check (
  sync_code is not null and length(sync_code) > 0
  and item_id is not null and length(item_id) > 0
);

drop policy if exists "reminder_items_delete_by_code" on public.reminder_items;
create policy "reminder_items_delete_by_code"
on public.reminder_items
for delete
using (true);

drop policy if exists "sync_codes_select" on public.sync_codes;
create policy "sync_codes_select"
on public.sync_codes
for select
using (true);

drop policy if exists "sync_codes_insert" on public.sync_codes;
create policy "sync_codes_insert"
on public.sync_codes
for insert
with check (sync_code is not null and length(sync_code) > 0);

drop policy if exists "sync_codes_update" on public.sync_codes;
create policy "sync_codes_update"
on public.sync_codes
for update
using (true)
with check (sync_code is not null and length(sync_code) > 0);
