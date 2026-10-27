import { createClient } from "@supabase/supabase-js";
import { parseGmailImageAttachment } from "./gmail.js";

export type SocialPlatformResult = {
  platform: "facebook" | "instagram";
  status: "published" | "failed" | "not_configured";
  message?: string;
  id?: string;
  permalinkUrl?: string;
};

export type SocialDeliverySummary = {
  status: "published" | "partial" | "failed" | "not_configured";
  platforms: SocialPlatformResult[];
};
export type SocialPlatform = SocialPlatformResult["platform"];

function environment(portal: string, name: string): string {
  const utilityPrefix = portal === "cepalco" ? "CEPALCO" : portal === "water" ? "WATER" : "";
  const scopedName = utilityPrefix ? `${utilityPrefix}_${name}` : "";
  let value = (scopedName ? process.env[scopedName] : undefined)?.trim() ?? process.env[name]?.trim() ?? "";
  if (!value && name === "META_PUBLIC_BASE_URL") {
    value = process.env.ETA_PUBLIC_BASE_URL?.trim() ?? "";
  }
  return value;
}

function graphVersion(): string {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v24.0";
}

function graphBase(): string {
  return `https://graph.facebook.com/${graphVersion()}`;
}

function advisoryMessage(title: string, area: string, details: string, reference: string): string {
  return `${title}\n\nAffected area: ${area}\n\n${details}\n\nReference: ${reference}`;
}

async function fetchPermalink(id: string, fields: "permalink_url" | "permalink", accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${graphBase()}/${encodeURIComponent(id)}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`);
    const result = await response.json() as { permalink_url?: string; permalink?: string };
    if (!response.ok) return null;
    const permalink = fields === "permalink_url" ? result.permalink_url : result.permalink;
    return typeof permalink === "string" && /^https:\/\/(?:www\.)?(?:facebook\.com|instagram\.com)\//.test(permalink)
      ? permalink
      : null;
  } catch {
    return null;
  }
}

async function publishToFacebook(
  portal: string,
  title: string,
  area: string,
  details: string,
  reference: string,
  imageDataUrl: string | null,
): Promise<SocialPlatformResult> {
  const pageId = environment(portal, "META_FACEBOOK_PAGE_ID");
  const accessToken = environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN");
  if (!pageId || !accessToken) {
    return { platform: "facebook", status: "not_configured", message: "Facebook page publishing is not configured." };
  }

  const message = advisoryMessage(title, area, details, reference);
  try {
    if (imageDataUrl) {
      const attachment = parseGmailImageAttachment(imageDataUrl);
if (!attachment) {
  return { platform: "facebook", status: "failed", message: "The announcement image is invalid." };
}
      const form = new FormData();
      form.append("message", message);
      form.append("access_token", accessToken);
      form.append("source", new Blob([new Uint8Array(attachment.content)], { type: attachment.mimeType }), attachment.filename);
      const response = await fetch(`${graphBase()}/${encodeURIComponent(pageId)}/photos`, {
        method: "POST",
        body: form,
      });
      const result = await response.json() as { id?: string; post_id?: string; error?: { message?: string } };
      if (!response.ok || (!result.id && !result.post_id)) {
        return { platform: "facebook", status: "failed", message: result.error?.message || "Facebook could not publish the image." };
      }
      const id = result.post_id ?? result.id!;
      const permalinkUrl = await fetchPermalink(id, "permalink_url", accessToken);
      return { platform: "facebook", status: "published", id, permalinkUrl: permalinkUrl ?? `https://www.facebook.com/${encodeURIComponent(id)}`, ...(permalinkUrl ? {} : { message: "Facebook published the post, but its public link could not be confirmed." }) };
    }

    const response = await fetch(`${graphBase()}/${encodeURIComponent(pageId)}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message, access_token: accessToken }),
    });
    const result = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok || !result.id) {
      return { platform: "facebook", status: "failed", message: result.error?.message || "Facebook could not publish the announcement." };
    }
    const permalinkUrl = await fetchPermalink(result.id, "permalink_url", accessToken);
    return { platform: "facebook", status: "published", id: result.id, permalinkUrl: permalinkUrl ?? `https://www.facebook.com/${encodeURIComponent(result.id)}`, ...(permalinkUrl ? {} : { message: "Facebook published the post, but its public link could not be confirmed." }) };
  } catch (error) {
    return { platform: "facebook", status: "failed", message: error instanceof Error ? error.message : "Facebook publishing failed." };
  }
}

async function uploadToSupabaseStorage(
  advisoryId: number,
  imageDataUrl: string,
): Promise<string | null> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return null;

  try {
    const attachment = parseGmailImageAttachment(imageDataUrl);
    if (!attachment) return null;

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const extension = attachment.mimeType === "image/png" ? "png" : attachment.mimeType === "image/webp" ? "webp" : "jpg";
    const filename = `advisory-${advisoryId}-${Date.now()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("advisories")
      .upload(filename, Buffer.from(attachment.content), {
        contentType: attachment.mimeType,
        upsert: true,
      });

    if (uploadError) {
      if (uploadError.message?.toLowerCase().includes("bucket not found")) {
        await supabase.storage.createBucket("advisories", { public: true });
        const { error: retryError } = await supabase.storage
          .from("advisories")
          .upload(filename, Buffer.from(attachment.content), {
            contentType: attachment.mimeType,
            upsert: true,
          });
        if (retryError) {
          console.error("[social] Supabase storage upload retry failed:", retryError);
          return null;
        }
      } else {
        console.error("[social] Supabase storage upload failed:", uploadError);
        return null;
      }
    }

    const { data: { publicUrl } } = supabase.storage.from("advisories").getPublicUrl(filename);
    return publicUrl;
  } catch (err) {
    console.error("[social] Error uploading image to Supabase storage:", err);
    return null;
  }
}

async function publishToInstagram(
  portal: string,
  title: string,
  area: string,
  details: string,
  reference: string,
  imageDataUrl: string | null,
  advisoryId: number,
  publicBaseUrl: string,
): Promise<SocialPlatformResult> {
  const accountId = environment(portal, "META_INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const candidateTokens = [
    environment(portal, "META_INSTAGRAM_ACCESS_TOKEN"),
    environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN"),
  ].filter((token, index, self): token is string => Boolean(token) && self.indexOf(token) === index);

  if (!accountId || candidateTokens.length === 0) {
    return { platform: "instagram", status: "not_configured", message: "Instagram publishing is not configured." };
  }
  if (!imageDataUrl) {
    return { platform: "instagram", status: "failed", message: "Instagram publishing requires an announcement image." };
  }

  let imageUrl: string | null = await uploadToSupabaseStorage(advisoryId, imageDataUrl);

  if (!imageUrl) {
    const configuredPublicBaseUrl = environment(portal, "META_PUBLIC_BASE_URL") || publicBaseUrl;
    if (!configuredPublicBaseUrl) {
      return { platform: "instagram", status: "failed", message: "Instagram publishing requires either Supabase Storage or META_PUBLIC_BASE_URL to host the announcement image." };
    }
    imageUrl = `${configuredPublicBaseUrl.replace(/\/$/, "")}/advisories/${advisoryId}/image`;
  }

  const caption = advisoryMessage(title, area, details, reference);
  try {
    let container: { id?: string; error?: { message?: string; code?: number } } | null = null;
    let activeToken = candidateTokens[0];

    for (const token of candidateTokens) {
      activeToken = token;
      const containerResponse = await fetch(`${graphBase()}/${encodeURIComponent(accountId)}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ image_url: imageUrl, caption, access_token: token }),
      });
      container = await containerResponse.json() as { id?: string; error?: { message?: string; code?: number } };
      if (containerResponse.ok && container.id) {
        break;
      }
      const isAuthError = container.error?.code === 190 || /access token|decrypted|expired|invalid/i.test(container.error?.message ?? "");
      if (!isAuthError) {
        break;
      }
    }

    if (!container?.id) {
      return { platform: "instagram", status: "failed", message: container?.error?.message || "Instagram could not create the media container." };
    }

    const publishResponse = await fetch(`${graphBase()}/${encodeURIComponent(accountId)}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: container.id, access_token: activeToken }),
    });
    const published = await publishResponse.json() as { id?: string; error?: { message?: string } };
    if (!publishResponse.ok || !published.id) {
      return { platform: "instagram", status: "failed", message: published.error?.message || "Instagram could not publish the announcement." };
    }
    const permalinkUrl = await fetchPermalink(published.id, "permalink", activeToken);
    return { platform: "instagram", status: "published", id: published.id, ...(permalinkUrl ? { permalinkUrl } : { message: "Instagram published the post, but Meta did not return its permalink. Check the connected account permissions." }) };
  } catch (error) {
    return { platform: "instagram", status: "failed", message: error instanceof Error ? error.message : "Instagram publishing failed." };
  }
}

export async function publishAnnouncementToSocial(
  portal: string,
  _utility: string,
  advisoryId: number,
  reference: string,
  title: string,
  area: string,
  details: string,
  imageDataUrl: string | null,
  selectedPlatforms: SocialPlatform[] = ["facebook"],
): Promise<SocialDeliverySummary> {
  const platforms = await Promise.all(selectedPlatforms.map(platform => platform === "facebook"
    ? publishToFacebook(portal, title, area, details, reference, imageDataUrl)
    : publishToInstagram(portal, title, area, details, reference, imageDataUrl, advisoryId, environment(portal, "META_PUBLIC_BASE_URL"))));

  const configuredPlatforms = platforms.filter(result => result.status !== "not_configured");
  const published = platforms.filter(result => result.status === "published").length;

  let status: SocialDeliverySummary["status"];
  if (configuredPlatforms.length === 0) status = "not_configured";
  else if (published === configuredPlatforms.length && published > 0) status = "published";
  else if (published > 0) status = "partial";
  else status = "failed";

  return { status, platforms };
}

export function socialConfiguration(portal: string) {
  const facebook = Boolean(environment(portal, "META_FACEBOOK_PAGE_ID") && environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN"));
  const hasPublicStorage = Boolean(
    (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) ||
    environment(portal, "META_PUBLIC_BASE_URL")
  );
  const instagram = Boolean(
    environment(portal, "META_INSTAGRAM_BUSINESS_ACCOUNT_ID") &&
    (environment(portal, "META_INSTAGRAM_ACCESS_TOKEN") || environment(portal, "META_FACEBOOK_PAGE_ACCESS_TOKEN")) &&
    hasPublicStorage
  );
  return { facebook, instagram };
}
