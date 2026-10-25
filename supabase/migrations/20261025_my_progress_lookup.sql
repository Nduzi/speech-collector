-- Applied to project vkoluuojtrsyagttzchx as migration 'my_progress_lookup' (+ revoke from authenticated)
-- Lets the public site ask "what has the participant with THIS id already recorded?", so someone can carry on from any
-- device with the ID shown on their thank-you page. It answers only for one exact, unguessable id (a random UUID),
-- returns no other participant's data, and cannot be used to list or search. Recordings set aside by the owner are not counted.
-- The Supabase advisor warns that anon can run a SECURITY DEFINER function: that is the intent here.
create or replace function public.my_progress(p uuid) returns jsonb
  language plpgsql stable security definer set search_path = ''
as $$
declare s public.speakers;
begin
  select * into s from public.speakers where id = p;
  if not found then return null; end if;
  if s.withdrawn_at is not null then return jsonb_build_object('withdrawn', true); end if;
  return jsonb_build_object(
    'name', s.display_name,
    'window_open', (s.created_at > now() - interval '3 days' or s.extended_until > now()),
    'recorded', coalesce((select jsonb_agg(jsonb_build_array(r.label, r.round)) from public.recordings r
                          where r.speaker_id = s.id and r.quality_flag not in ('no_speech', 'wrong_content')), '[]'::jsonb)
  );
end $$;

revoke all on function public.my_progress(uuid) from public;
revoke execute on function public.my_progress(uuid) from authenticated;
grant execute on function public.my_progress(uuid) to anon;
