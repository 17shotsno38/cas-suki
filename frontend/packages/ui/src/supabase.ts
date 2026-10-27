import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this portal, then restart Vite.");
  }
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export type SupabaseProfile = {
  id: string;
  name: string;
  email: string;
  role: "resident" | "admin";
  utility: string | null;
  phone_number: string | null;
  address: string | null;
  barangay: string | null;
  district: string | null;
  city: string | null;
  postal_code: string | null;
  profile_image: string | null;
  sms_alerts: boolean;
  notify_maintenance: boolean;
  notify_email_digest: boolean;
  immediate_email_alerts: boolean;
};

export function profileActor(profile: SupabaseProfile) {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role,
    utility: profile.utility,
    phoneNumber: profile.phone_number ?? "",
    address: profile.address ?? "",
    barangay: profile.barangay ?? "",
    district: profile.district ?? "",
    city: profile.city ?? "",
    postalCode: profile.postal_code ?? "",
    profileImage: profile.profile_image,
    smsAlerts: profile.sms_alerts,
    maintenanceAlerts: profile.notify_maintenance,
    emailDigest: profile.notify_email_digest,
    immediateEmailAlerts: profile.immediate_email_alerts,
  };
}

export function raiseSupabaseError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}
