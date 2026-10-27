alter table public.advisories
  add column if not exists priority text not null default 'Normal',
  add column if not exists service_starts_at timestamptz,
  add column if not exists estimated_restoration_at timestamptz;

alter table public.reports
  add column if not exists legacy_source_id bigint unique;

create table if not exists public.social_posts (
  advisory_id bigint not null references public.advisories(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  post_id text not null,
  permalink_url text,
  published_at timestamptz not null default now(),
  primary key (advisory_id, platform)
);

create table if not exists public.legacy_user_links (
  legacy_user_id bigint primary key,
  email text not null,
  role text not null check (role in ('resident', 'admin')),
  utility text,
  profile_id uuid references public.profiles(id) on delete set null,
  constraint legacy_user_links_role_utility_check check (
    (role = 'resident' and utility is null)
    or (role = 'admin' and utility is not null)
  )
);

create index if not exists legacy_user_links_email_idx
  on public.legacy_user_links (lower(email));

create table if not exists public.legacy_import_reports (
  legacy_source_id bigint primary key,
  legacy_user_id bigint not null references public.legacy_user_links(legacy_user_id) on delete cascade,
  reference text not null unique,
  title text not null,
  utility text not null check (utility in ('CEPALCO', 'Water District')),
  area text not null,
  details text not null default '',
  status text not null default 'Received',
  created_at timestamptz not null
);

alter table public.legacy_user_links enable row level security;
alter table public.legacy_import_reports enable row level security;
alter table public.social_posts enable row level security;

revoke all on public.legacy_user_links, public.legacy_import_reports from anon, authenticated;
grant all on public.legacy_user_links, public.legacy_import_reports to service_role;
grant select on public.social_posts to anon, authenticated;
grant insert, update, delete on public.social_posts to authenticated;

create policy social_posts_read_public
  on public.social_posts for select to anon, authenticated
  using (exists (
    select 1 from public.advisories
    where id = advisory_id and publication_status = 'published'
  ));
create policy social_posts_manage_utility
  on public.social_posts for all to authenticated
  using (exists (
    select 1 from public.advisories
    where id = advisory_id and public.is_utility_admin(utility)
  ))
  with check (exists (
    select 1 from public.advisories
    where id = advisory_id and public.is_utility_admin(utility)
  ));

create or replace function public.link_legacy_records()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  imported_count integer;
begin
  update public.legacy_user_links as links
  set profile_id = profiles.id
  from public.profiles
  where links.profile_id is null
    and lower(links.email) = lower(profiles.email)
    and links.role = profiles.role
    and (links.role = 'resident' or links.utility = profiles.utility);

  insert into public.reports (
    legacy_source_id, reference, user_id, title, utility, area, details, status, created_at
  )
  select legacy_reports.legacy_source_id, legacy_reports.reference, links.profile_id,
    legacy_reports.title, legacy_reports.utility, legacy_reports.area,
    legacy_reports.details, legacy_reports.status, legacy_reports.created_at
  from public.legacy_import_reports as legacy_reports
  join public.legacy_user_links as links using (legacy_user_id)
  where links.profile_id is not null
  on conflict (legacy_source_id) do update set
    user_id = excluded.user_id,
    title = excluded.title,
    utility = excluded.utility,
    area = excluded.area,
    details = excluded.details,
    status = excluded.status,
    created_at = excluded.created_at;

  get diagnostics imported_count = row_count;
  return imported_count;
end;
$$;

revoke all on function public.link_legacy_records() from public, anon, authenticated;
grant execute on function public.link_legacy_records() to service_role;

create or replace function public.link_legacy_records_after_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.legacy_user_links
  set profile_id = new.id
  where profile_id is null
    and lower(email) = lower(new.email)
    and role = new.role
    and (role = 'resident' or utility = new.utility);
  perform public.link_legacy_records();
  return new;
end;
$$;

create trigger profiles_link_legacy_records
  after insert on public.profiles
  for each row execute function public.link_legacy_records_after_profile_insert();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'social_posts'
  ) then
    alter publication supabase_realtime add table public.social_posts;
  end if;
end;
$$;
