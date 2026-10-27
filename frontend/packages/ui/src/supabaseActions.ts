import type { Advisory, Portal, ServiceReport, SMSRecord, WorkOrder } from "./prototypeStore.js";
import { getSupabase, profileActor, raiseSupabaseError, type SupabaseProfile } from "./supabase.js";

type ActionOptions = RequestInit;

function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    value,
  ]));
}

export async function supabaseAction<T>(
  portal: Portal,
  path: string,
  options: ActionOptions,
): Promise<T> {
  const supabase = getSupabase();
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
  const utility = portal === "cepalco" ? "CEPALCO" : portal === "water" ? "Water District" : null;
  const profileForPortal = async (): Promise<SupabaseProfile> => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) throw new Error(error?.message || "Please sign in to continue.");
    const { data, error: profileError } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    if (profileError) throw new Error(profileError.message);
    const profile = data as SupabaseProfile;
    if (portal === "resident" ? profile.role !== "resident" : profile.role !== "admin" || profile.utility !== utility) {
      throw new Error("This account is not authorized for this portal.");
    }
    return profile;
  };

  if (path === "/auth/login" && method === "POST") {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(body.email ?? "").trim(),
      password: String(body.password ?? ""),
    });
    if (error || !data.user || !data.session) throw new Error(error?.message || "Sign in failed.");
    const { data: profile, error: profileError } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
    if (profileError) throw new Error(profileError.message);
    const actor = profileActor(profile as SupabaseProfile);
    if (portal === "resident" ? actor.role !== "resident" : actor.role !== "admin" || actor.utility !== utility) {
      await supabase.auth.signOut();
      throw new Error("This account is not authorized for this portal.");
    }
    return { token: data.session.access_token, actor } as T;
  }

  if (path === "/auth/register" && method === "POST") {
    const { data, error } = await supabase.auth.signUp({
      email: String(body.email ?? "").trim().toLowerCase(),
      password: String(body.password ?? ""),
      options: { data: { name: String(body.name ?? "").trim() } },
    });
    if (error) throw new Error(error.message);
    if (!data.user || !data.session) {
      throw new Error("Check your email to confirm your account, then sign in. If confirmation is disabled, check the Supabase Auth settings.");
    }
    const { error: profileError } = await supabase.from("profiles").update({
      name: String(body.name ?? "").trim(),
      phone_number: String(body.phoneNumber ?? ""),
      address: String(body.address ?? ""),
      barangay: String(body.barangay ?? ""),
      district: String(body.district ?? ""),
      city: String(body.city ?? ""),
      postal_code: String(body.postalCode ?? ""),
      sms_alerts: body.smsAlerts !== false,
      immediate_email_alerts: body.immediateEmailAlerts === true,
      terms_accepted_at: new Date().toISOString(),
    }).eq("id", data.user.id);
    raiseSupabaseError(profileError);
    const { data: profile, error: readError } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
    if (readError) throw new Error(readError.message);
    return { token: data.session.access_token, actor: profileActor(profile as SupabaseProfile) } as T;
  }

  if (path === "/auth/me") return { actor: profileActor(await profileForPortal()) } as T;

  if (path === "/auth/profile" && method === "PATCH") {
    const profile = await profileForPortal();
    if (typeof body.email === "string" && body.email.trim().toLowerCase() !== profile.email.toLowerCase()) {
      throw new Error("Changing your email is not supported from this profile form. Keep the email connected to your Supabase Auth account.");
    }
    const { error } = await supabase.from("profiles").update({
      name: body.name,
      phone_number: body.phoneNumber,
      address: body.address,
      barangay: body.barangay,
      district: body.district,
      city: body.city,
      postal_code: body.postalCode,
      profile_image: body.profileImage,
      sms_alerts: body.smsAlerts,
      notify_maintenance: body.maintenanceAlerts,
      notify_email_digest: body.emailDigest,
      immediate_email_alerts: body.immediateEmailAlerts,
    }).eq("id", profile.id);
    raiseSupabaseError(error);
    const { data, error: readError } = await supabase.from("profiles").select("*").eq("id", profile.id).single();
    if (readError) throw new Error(readError.message);
    return { actor: profileActor(data as SupabaseProfile) } as T;
  }

  if (path === "/auth/password" && method === "POST") {
    const profile = await profileForPortal();
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: String(body.currentPassword ?? ""),
    });
    if (verifyError) throw new Error("Current password is incorrect.");
    const { error } = await supabase.auth.updateUser({ password: String(body.newPassword ?? "") });
    raiseSupabaseError(error);
    return { ok: true } as T;
  }

  if (path === "/advisories" && method === "GET") {
    let query = supabase.from("advisories").select("*").order("id", { ascending: false });
    if (utility) query = query.eq("utility", utility);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map(row => row.id);
    const { data: posts, error: postError } = ids.length
      ? await supabase.from("social_posts").select("advisory_id,platform,permalink_url").in("advisory_id", ids)
      : { data: [], error: null };
    if (postError) throw new Error(postError.message);
    const links = new Map<number, Record<string, string>>();
    for (const post of posts ?? []) {
      const existing = links.get(post.advisory_id) ?? {};
      existing[post.platform] = post.permalink_url ?? "";
      links.set(post.advisory_id, existing);
    }
    return (data ?? []).map(row => ({
      ...toCamel(row),
      imageUrl: row.image_data_url,
      facebookUrl: links.get(row.id)?.facebook || null,
      instagramUrl: links.get(row.id)?.instagram || null,
      channels: row.channels,
    })) as Advisory[] as T;
  }

  if (path === "/advisories" && method === "POST") {
    await profileForPortal();
    const scheduledAt = String(body.scheduledAt ?? "") || null;
    const { data, error } = await supabase.from("advisories").insert({
      reference: `${portal === "water" ? "WD" : "CE"}-${Date.now().toString(36).toUpperCase()}`,
      title: body.title,
      utility,
      type: body.type ?? "Service disruption",
      area: body.area,
      details: body.details,
      status: scheduledAt ? "Scheduled" : "Monitoring",
      priority: body.priority ?? "Normal",
      service_starts_at: body.serviceStartsAt || null,
      estimated_restoration_at: body.estimatedRestorationAt || null,
      image_data_url: body.imageDataUrl || null,
      latitude: body.latitude || null,
      longitude: body.longitude || null,
      scheduled_at: scheduledAt,
      publication_status: scheduledAt ? "scheduled" : "published",
      channels: body.channels ?? [],
    }).select("*").single();
    if (error) throw new Error(error.message);
    let delivery: Record<string, unknown> | null = null;
    {
      const apiBaseUrl = ({
        resident: import.meta.env.VITE_RESIDENT_API_URL || "http://localhost:4101",
        cepalco: import.meta.env.VITE_CEPALCO_API_URL || "http://localhost:4102",
        water: import.meta.env.VITE_WATER_API_URL || "http://localhost:4103",
      })[portal].replace(/\/+$/, "");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Your Supabase session expired after the advisory was saved. Sign in again to send it.");
      const response = await fetch(`${apiBaseUrl}/advisories/${data.id}/deliver`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const deliveryResult: unknown = await response.json();
      if (!response.ok) {
        const message = deliveryResult && typeof deliveryResult === "object" && "error" in deliveryResult
          ? String(deliveryResult.error)
          : `Provider delivery failed with status ${response.status}.`;
        throw new Error(`Advisory was saved in Supabase, but provider delivery failed: ${message}`);
      }
      delivery = deliveryResult as Record<string, unknown>;
    }
    return {
      ...toCamel(data),
      channels: data.channels,
      emailDelivery: delivery?.emailDelivery ?? null,
      socialDelivery: delivery?.socialDelivery ?? null,
      socialLinks: delivery?.socialLinks ?? [],
      smsQueued: delivery?.smsQueued ?? 0,
    } as T;
  }

  const advisoryStatus = path.match(/^\/advisories\/(\d+)\/status$/);
  if (advisoryStatus && method === "PATCH") {
    await profileForPortal();
    const { error, count } = await supabase.from("advisories").update({ status: body.status }, { count: "exact" })
      .eq("id", Number(advisoryStatus[1])).eq("utility", utility);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Advisory not found or access denied.");
    return { ok: true } as T;
  }

  if (path === "/work-orders" && method === "GET") {
    let query = supabase.from("work_orders").select("*").order("starts_at");
    if (utility) query = query.eq("utility", utility);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []).map(toCamel) as WorkOrder[] as T;
  }

  if (path === "/work-orders" && method === "POST") {
    await profileForPortal();
    const { data, error } = await supabase.from("work_orders").insert({
      reference: `${portal === "water" ? "WD" : "CE"}-WO-${Date.now().toString(36).toUpperCase()}`,
      title: body.title,
      utility,
      area: body.area,
      description: body.description ?? "",
      starts_at: body.startsAt,
      ends_at: body.endsAt,
    }).select("*").single();
    if (error) throw new Error(error.message);
    return toCamel(data) as T;
  }

  if (path === "/reports" && method === "POST") {
    const profile = await profileForPortal();
    const { data, error } = await supabase.from("reports").insert({
      reference: `CAS-R-${Date.now().toString(36).toUpperCase()}`,
      user_id: profile.id,
      title: body.issue,
      utility: body.utility,
      area: body.area,
      details: body.details ?? "",
    }).select("*").single();
    if (error) throw new Error(error.message);
    return toCamel(data) as T;
  }

  if (path === "/reports" && method === "GET") {
    await profileForPortal();
    const { data, error } = await supabase.from("reports").select("*").order("id", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(toCamel) as ServiceReport[] as T;
  }

  const reportStatus = path.match(/^\/reports\/(\d+)\/status$/);
  if (reportStatus && method === "PATCH") {
    await profileForPortal();
    const { error, count } = await supabase.from("reports").update({ status: body.status }, { count: "exact" })
      .eq("id", Number(reportStatus[1])).eq("utility", utility);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Report not found or access denied.");
    return { ok: true } as T;
  }

  if (path === "/network" && method === "GET") {
    await profileForPortal();
    const { data, error } = await supabase.from("network_readings").select("*").eq("utility", utility).order("id");
    if (error) throw new Error(error.message);
    return (data ?? []).map(toCamel) as T;
  }

  if (path === "/inbox" && method === "GET") {
    if (portal !== "resident") throw new Error("The simulated SMS inbox is available only to residents.");
    const profile = await profileForPortal();
    const { data, error } = await supabase.from("sms_deliveries")
      .select("id,resident_id,read_at,created_at,advisories(reference,title,utility,area)")
      .eq("resident_id", profile.id).order("id", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(message => {
      const advisory = message.advisories as unknown as { reference: string; title: string; utility: string; area: string };
      return {
        id: message.id,
        recipientId: message.resident_id,
        recipient: profile.name,
        phoneNumber: profile.phone_number ?? "",
        utility: advisory.utility,
        reference: advisory.reference,
        body: `${advisory.utility} advisory for ${advisory.area}: ${advisory.title}`,
        createdAt: message.created_at,
        status: "Simulated",
        read: message.read_at !== null,
      };
    }) as SMSRecord[] as T;
  }

  const inboxRead = path.match(/^\/inbox\/(\d+)\/read$/);
  if (inboxRead && method === "PATCH") {
    if (portal !== "resident") throw new Error("The simulated SMS inbox is available only to residents.");
    const profile = await profileForPortal();
    const { error, count } = await supabase.from("sms_deliveries").update({ read_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", Number(inboxRead[1])).eq("resident_id", profile.id);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Inbox message not found or access denied.");
    return { ok: true } as T;
  }

  throw new Error(`Unsupported Supabase action: ${method} ${path}`);
}
