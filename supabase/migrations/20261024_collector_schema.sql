-- Applied to project vkoluuojtrsyagttzchx as migration 'collector_schema'
-- Speech collector: contributors can ADD speakers and recordings; nothing public can read, change or delete.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table public.speakers (
  id uuid primary key,
  created_at timestamptz not null default now(),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  age_band text check (age_band in ('18-24','25-34','35-44','45-54','55-64','65+','prefer_not')),
  gender text check (gender in ('female','male','non_binary','self_describe','prefer_not')),
  first_language text check (char_length(first_language) <= 60),
  accent_note text check (char_length(accent_note) <= 120),
  country text check (char_length(country) <= 60),
  region text check (char_length(region) <= 60),
  mic_type text check (mic_type in ('laptop_builtin','phone_builtin','wired_headset','bluetooth_headset','usb_mic','other')),
  environment text check (environment in ('quiet_room','normal_room','noisy')),
  adult_confirmed boolean not null check (adult_confirmed),
  consent_version text not null check (char_length(consent_version) <= 40),
  consent_at timestamptz not null,
  user_agent text check (char_length(user_agent) <= 300),
  campaign text check (char_length(campaign) <= 60),
  app_version text check (char_length(app_version) <= 40),
  withdrawn_at timestamptz
);

create table public.recordings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  speaker_id uuid not null references public.speakers(id) on delete cascade,
  label text not null check (label ~ '^[A-Za-z0-9]{1,20}$'),
  round integer not null check (round between 1 and 20),
  storage_path text not null unique check (char_length(storage_path) <= 120),
  sample_rate integer not null check (sample_rate between 8000 and 48000),
  native_sample_rate integer check (native_sample_rate between 3000 and 384000),
  duration_ms integer not null check (duration_ms between 100 and 8000),
  peak_dbfs real, rms_dbfs real, noise_floor_dbfs real, snr_db real, clipped_fraction real,
  quality_flag text check (char_length(quality_flag) <= 60),
  retries integer check (retries between 0 and 50),
  device_label text check (char_length(device_label) <= 120),
  endpoint_reason text check (char_length(endpoint_reason) <= 30),
  unique (speaker_id, label, round)
);
create index recordings_speaker_idx on public.recordings (speaker_id);
alter table public.speakers enable row level security;
alter table public.recordings enable row level security;

-- helpers run with owner rights so policies can check tables the public cannot read
create or replace function private.speaker_recent(p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.speakers s where s.id = p and s.withdrawn_at is null and s.created_at > now() - interval '3 days')
$$;
create or replace function private.recording_quota_ok(p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.recordings r where r.speaker_id = p) < 400
$$;
create or replace function private.upload_ok(folder text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return folder ~ '^[0-9a-f-]{36}$' and private.speaker_recent(folder::uuid);
exception when others then
  return false;
end $$;
revoke all on function private.speaker_recent(uuid), private.recording_quota_ok(uuid), private.upload_ok(text) from public;
grant execute on function private.speaker_recent(uuid), private.recording_quota_ok(uuid), private.upload_ok(text) to anon, authenticated;

create policy "anyone may register as a speaker" on public.speakers
  for insert to anon, authenticated
  with check (withdrawn_at is null and created_at >= now() - interval '5 minutes');
create policy "contributors may add recordings for their own new speaker id" on public.recordings
  for insert to anon, authenticated
  with check (private.speaker_recent(speaker_id) and private.recording_quota_ok(speaker_id) and storage_path like (speaker_id::text || '/%'));

-- private bucket: small WAV files only, at <speaker-uuid>/<Label>_r<round>.wav, and only for a speaker registered in the last 3 days
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 1048576, array['audio/wav','audio/x-wav','audio/wave'])
on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = excluded.allowed_mime_types;

create policy "contributors may upload their own recordings" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'recordings'
    and name ~ '^[0-9a-f-]{36}/[A-Za-z0-9]{1,20}_r[0-9]{1,2}\.wav$'
    and private.upload_ok((storage.foldername(name))[1])
  );
