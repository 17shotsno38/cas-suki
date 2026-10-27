drop policy if exists profiles_update_resident_self on public.profiles;

create policy profiles_update_resident_self
  on public.profiles for update to authenticated
  using (
    id = (select auth.uid())
    and role = 'resident'
    and utility is null
  )
  with check (
    id = (select auth.uid())
    and role = 'resident'
    and utility is null
  );
