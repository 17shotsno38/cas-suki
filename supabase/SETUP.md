# Supabase database setup and SQLite data transfer

The portals use Supabase Auth and Supabase tables for sign-in and application records. Express APIs still handle Gmail and Meta publishing; keep their private credentials server-side. SQLite remains in use by those APIs for Gmail OAuth state and notification delivery bookkeeping.

## Create the Supabase schema

1. Create a Supabase project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. In **SQL Editor**, run `migrations/20261021233428_initial_schema.sql`.
3. Run `migrations/20261022220000_runtime_compatibility_and_legacy_import.sql`.
   - If the initial migration was already applied, run this compatibility migration if you have not already, then continue with the profile policy migration below.
   - Confirm both complete and check **Database → Tables** for the CivicAlert and legacy-import tables.
4. Run `migrations/20261023001000_profile_self_service.sql` to enable resident profile editing without allowing residents to change their role or utility.
5. Create each utility administrator through **Authentication → Users**. Do not set `role` or `utility` in user metadata. Assign roles to accounts you control:

   ```sql
   update public.profiles
   set role = 'admin', utility = 'CEPALCO'
   where email = 'your-cepalco-admin@example.com';
   ```

   For Water District, use `utility = 'Water District'`.

## Configure the portals and APIs

1. In Supabase **Project Settings → API**, copy the **Project URL** and the **publishable/anon key**.
2. For each frontend portal (`frontend/apps/resident-web`, `frontend/apps/cepalco-web`, and `frontend/apps/water-web`), create a local `.env.local` file based on that portal's `.env.example` and set:

   ```text
   VITE_SUPABASE_URL=your_project_url
   VITE_SUPABASE_ANON_KEY=your_publishable_or_anon_key
   ```

   The publishable/anon key is intended for browser use; database RLS policies protect records. Restart Vite after changing these values.
3. For each backend API environment (`backend/apps/resident-api`, `backend/apps/cepalco-api`, and `backend/apps/water-api`), set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` using the URL and the **service_role/secret key**. The service-role key is server-only: never put it in any frontend `.env.local`, `VITE_*` variable, chat message, or source control.
4. Keep the existing API-specific Gmail and Meta environment variables configured. Those integrations still use their API's local SQLite database for Gmail connections and delivery records. Keep `GMAIL_TOKEN_ENCRYPTION_KEY` stable and use the same SQLite file for the APIs that need to share those records.
5. Start the APIs and portals with `npm run dev:all`. Utility administrators sign in using the Supabase Auth email/password account whose profile has that utility's admin role. Residents register in the Resident portal; with email confirmation enabled, confirm the message before signing in.

## Resumable SQLite import

Keep the existing SQLite file as the untouched source/backup. The importer never selects or transfers password hashes. Existing scrypt passwords cannot be transferred, and it sends no invitations; residents must register with Supabase Auth using the same email address to link their historic reports and delivery records.

1. Install project dependencies with `npm install`.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a server-only environment (the backend `.env.example` files show the variable names). The script also honors `DATABASE_PATH`; otherwise it reads `backend/data/civicalert.sqlite`.
3. Run the SQL migrations above, then run `npm run db:import:sqlite` from the project root.
4. The import uses upserts and retains source record IDs where possible, so it can be safely rerun. Reports without a matching profile remain staged. The database trigger links a newly registered profile by normalized email and transfers that resident's reports. Rerun the importer after residents register to link notification delivery history and Gmail connection records. Check the command's aggregate counts and Supabase tables after each run.
5. Keep the Supabase service-role key server-only. Do not put it in a `VITE_*` variable, commit it, or paste it into chat. Never delete the SQLite source until the Supabase data has been verified.

The importer preserves encrypted Gmail refresh tokens without decrypting or printing them. Continue using the same `GMAIL_TOKEN_ENCRYPTION_KEY` on the server. OAuth state is short-lived and is intentionally not migrated.

## Security, behavior, and known limitations

The schema enables RLS and defines resident/admin access policies. Supabase Auth's profile trigger always creates a resident profile; user metadata cannot grant utility-admin access. Admin role assignments must be made in the Supabase SQL Editor by a trusted project owner. The database has Realtime publication configured, but these portals currently refresh data through requests rather than live Realtime subscriptions.

Advisories and work orders created in a portal are saved in Supabase. Immediate provider delivery is delegated to that utility's API after the announcement is saved; if the API is unavailable or missing server credentials, the advisory remains saved and the UI reports the delivery error. Scheduled announcements are stored in Supabase but the existing background scheduler still reads SQLite, so do not rely on scheduled delivery until a Supabase-backed scheduler is deployed. Gmail/Meta delivery and persistent OAuth state need a reachable utility API and its server-side environment configuration.

Do not paste project keys, database passwords, OAuth secrets, or service-role credentials into chat or source files.
