-- Applied to project vkoluuojtrsyagttzchx as migration 'speaker_window_extension'
-- Let the project owner (service key only) re-open a participant's upload window, e.g. to ask for newly added words.
alter table public.speakers add column if not exists extended_until timestamptz;

create or replace function private.speaker_recent(p uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.speakers s
    where s.id = p and s.withdrawn_at is null
      and (s.created_at > now() - interval '3 days' or s.extended_until > now())
  )
$$;

-- the public site must never be able to set it on its own registration
drop policy if exists "anyone may register as a speaker" on public.speakers;
create policy "anyone may register as a speaker" on public.speakers
  for insert to anon, authenticated
  with check (withdrawn_at is null and created_at >= now() - interval '5 minutes' and extended_until is null);
