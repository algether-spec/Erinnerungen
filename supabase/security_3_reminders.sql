-- =============================================================
-- security_3_reminders.sql – Sicherheits-Härtung Erinnerungen
--
-- Schließt die offenen Regeln bei reminder_items (vorher konnte JEDER,
-- auch ohne Anmeldung, alle Erinnerungen lesen, ändern und löschen)
-- und bei sync_codes.
--
-- Verträglich mit altem und neuem Erinnerungen-Client: beide melden sich
-- anonym an und treten dem Code per use_sync_code bei (= Mitglied).
-- Voraussetzung: security_1.sql (Einkaufsliste) ist ausgeführt.
--
-- Ausführen: Supabase Dashboard → SQL Editor → NICHTS markieren →
-- komplett ausführen. Mehrfaches Ausführen ist unschädlich.
-- Am Ende prüft das Skript sich selbst: bei einem Fehler wird ALLES
-- zurückgerollt und eine Meldung angezeigt. Bei Erfolg erscheint
-- eine Tabelle mit genau 4 Regeln für reminder_items.
-- =============================================================


-- -------------------------------------------------------------
-- 0. ALLE bestehenden Regeln von reminder_items und sync_codes entfernen
--    (u. a. "shopping_items_*_by_code" mit true für {public}).
--    Regeln werden mit ODER verknüpft: eine offene Regel hebelt alle
--    strengen Regeln aus.
-- -------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('reminder_items', 'sync_codes')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end
$$;


-- -------------------------------------------------------------
-- 1. Rechte: ohne Anmeldung kein Zugriff, angemeldet nur per Regeln
--    sync_codes wird nur über use_sync_code & Co. (security definer) genutzt.
-- -------------------------------------------------------------
alter table public.reminder_items enable row level security;
alter table public.sync_codes enable row level security;

revoke all on public.reminder_items from anon;
grant select, insert, update, delete on public.reminder_items to authenticated;

revoke all on public.sync_codes from anon, authenticated;


-- -------------------------------------------------------------
-- 2. Prüfung der Zeilen beim Schreiben
--    Fotos stehen als "__IMG__:data:image/..." in text UND title
--    → bis 6 MB (wie apply_shopping_ops), sonst normale Grenzen.
-- -------------------------------------------------------------
create or replace function public.reminder_item_is_valid(
  p_sync_code text,
  p_item_id text,
  p_text text,
  p_title text,
  p_note text,
  p_position integer
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    p_sync_code ~ '^[A-Z]{4}[0-9]{4}$'
    and p_sync_code <> 'HELP0000'
    and length(trim(p_item_id)) between 1 and 160
    and length(trim(p_text)) between 1 and 6000000
    and length(trim(p_title)) between 1 and 6000000
    and length(p_note) <= 20000
    and p_position >= 0,
    false
  );
$$;

revoke all on function public.reminder_item_is_valid(text, text, text, text, text, integer) from public, anon;
grant execute on function public.reminder_item_is_valid(text, text, text, text, text, integer) to authenticated;


-- -------------------------------------------------------------
-- 3. reminder_items: nur Mitglieder des Codes
-- -------------------------------------------------------------
create policy "reminder_items_select_by_membership"
on public.reminder_items
for select
to authenticated
using (public.has_sync_membership(sync_code, auth.uid()));

create policy "reminder_items_insert_by_membership"
on public.reminder_items
for insert
to authenticated
with check (
  public.reminder_item_is_valid(sync_code, item_id, text, title, note, position)
  and public.has_sync_membership(sync_code, auth.uid())
);

create policy "reminder_items_update_by_membership"
on public.reminder_items
for update
to authenticated
using (public.has_sync_membership(sync_code, auth.uid()))
with check (
  public.reminder_item_is_valid(sync_code, item_id, text, title, note, position)
  and public.has_sync_membership(sync_code, auth.uid())
);

create policy "reminder_items_delete_by_membership"
on public.reminder_items
for delete
to authenticated
using (public.has_sync_membership(sync_code, auth.uid()));


-- -------------------------------------------------------------
-- 4. Selbstkontrolle – bricht bei Abweichung ab (alles wird zurückgerollt)
-- -------------------------------------------------------------
do $$
declare
  v_count integer;
  v_bad integer;
begin
  select count(*),
         count(*) filter (
           where roles <> '{authenticated}'
              or coalesce(qual, '') || coalesce(with_check, '') not like '%has_sync_membership%'
         )
  into v_count, v_bad
  from pg_policies
  where schemaname = 'public' and tablename = 'reminder_items';

  if v_count <> 4 or v_bad <> 0 then
    raise exception 'KONTROLLE FEHLGESCHLAGEN: reminder_items hat % Regeln, davon % offen', v_count, v_bad;
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sync_codes') then
    raise exception 'KONTROLLE FEHLGESCHLAGEN: sync_codes hat noch Regeln';
  end if;

  if has_table_privilege('anon', 'public.reminder_items', 'select')
     or has_table_privilege('anon', 'public.sync_codes', 'select')
     or has_table_privilege('authenticated', 'public.sync_codes', 'select') then
    raise exception 'KONTROLLE FEHLGESCHLAGEN: Tabelle ohne Anmeldung lesbar';
  end if;
end
$$;

-- Ergebnis anzeigen: erwartet genau 4 Zeilen, alle {authenticated}
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('reminder_items', 'sync_codes')
order by tablename, cmd;
