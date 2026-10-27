import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { uiCopy } from "./prototypeCopy.js";
import { portalSettings as localPortalSettings, type PortalSettings } from "./prototypeSettings.js";
import {
  type Actor,
  type Advisory,
  type NetworkReading,
  type Portal,
  type ServiceReport,
  type SMSRecord,
  type Status,
  type WorkOrder,
} from "./prototypeStore.js";
import { GoogleMap, type CivicAlertMapAnnouncement, type CivicAlertMapLocation } from "./GoogleMaps.js";
import { getSupabase } from "./supabase.js";
import { supabaseAction } from "./supabaseActions.js";
import "./styles.css";

const portalSettings = localPortalSettings;
const REQUIRED_ANNOUNCEMENT_CHANNELS = ["facebook", "gmail"] as const;
const DEFAULT_ANNOUNCEMENT_CHANNELS = [...REQUIRED_ANNOUNCEMENT_CHANNELS];

type EmailDeliverySummary = {
  status: string;
  sent: number;
  failed: number;
  errors: Array<{ message: string; count?: number }>;
};

function copy(key: string): string {
  const value = (uiCopy as Record<string, string>)[key];
  if (value === undefined) throw new Error(`Missing frontend copy key: ${key}`);
  return value;
}

function settingsFor(portal: Portal): PortalSettings {
  return portalSettings[portal];
}

function requiredSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing prototype setting: ${name}.`);
  return value;
}

function isRequiredAnnouncementChannel(channel: string): boolean {
  return REQUIRED_ANNOUNCEMENT_CHANNELS.some(requiredChannel => requiredChannel === channel);
}

function apiBaseUrl(portal: Portal): string {
  return ({
    resident: import.meta.env.VITE_RESIDENT_API_URL || "http://localhost:4101",
    cepalco: import.meta.env.VITE_CEPALCO_API_URL || "http://localhost:4102",
    water: import.meta.env.VITE_WATER_API_URL || "http://localhost:4103",
  })[portal].replace(/\/+$/, "");
}

function announcementImageUrl(item: Advisory, portal: Portal): string | null {
  if (!item.imageUrl) return null;
  if (item.imageUrl.startsWith("data:")) return item.imageUrl;
  const imagePortal = portal === "resident"
    ? item.utility === "Water District" ? "water" : "cepalco"
    : portal;
  return `${apiBaseUrl(imagePortal)}${item.imageUrl}`;
}

async function readAnnouncementImage(file: FormDataEntryValue | null): Promise<string | null> {
  if (!(file instanceof File) || file.size === 0) return null;
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size > 15_000_000) throw new Error("Choose an image smaller than 15 MB.");
  const toDataUrl = (image: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read the selected image."));
      }
    };

    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(image);
  });

  if (file.size <= 1_000_000 && file.type === "image/jpeg") return toDataUrl(file);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Try another JPEG, PNG, or WebP file.");
  }

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image optimization is unavailable in this browser.");
    let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    for (let dimensionAttempt = 0; dimensionAttempt < 8; dimensionAttempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.76, 0.66, 0.56]) {
        const optimized = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(blob => blob
            ? resolve(blob)
            : reject(new Error("Could not optimize this image. Try another file.")), "image/jpeg", quality);
        });
        if (optimized.size <= 1_000_000) return await toDataUrl(optimized);
      }
      scale *= 0.8;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("This image could not be reduced below 1 MB. Choose a smaller or lower-resolution image.");
}

// ADDED: Convert existing API advisory records into validated map markers.
function mapAnnouncements(advisories: Advisory[]): CivicAlertMapAnnouncement[] {
  return advisories.flatMap(item => {
    const located = item as Advisory & { latitude?: unknown; longitude?: unknown };
    if (located.latitude === null || located.latitude === undefined ||
        located.longitude === null || located.longitude === undefined) return [];
    const latitude = Number(located.latitude);
    const longitude = Number(located.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
    return [{
      id: item.id,
      title: item.title,
      utility: item.utility,
      area: item.area,
      status: item.status,
      latitude,
      longitude,
    }];
  });
}

function Icon({ name, className = "h-5 w-5" }: { name: string; className?: string }) {
  const paths: Record<string, string> = {
    home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z",
    water: "M12 3s7 7 7 12a7 7 0 1 1-14 0c0-5 7-12 7-12Z",
    alert: "M12 3 2.9 19a1.4 1.4 0 0 0 1.2 2.1h15.8a1.4 1.4 0 0 0 1.2-2.1L12 3Zm0 6v4.5m0 3h.01",
    calendar: "M3 5h18v16H3zM8 3v4m8-4v4M3 10h18",
    map: "M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z M12 10h.01",
    people: "M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20m7-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7a4 4 0 0 1 0 7m4 9v-1.5a4 4 0 0 0-3-3.9",
    search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6ZM16 16l5 5",
    plus: "M12 5v14M5 12h14",
    pulse: "M3 12h4l2.4-7 4.2 14 2.5-7H21",
    shield: "M12 2.8 20 6v5.1c0 5.2-3.4 8.8-8 10.2-4.6-1.4-8-5-8-10.2V6l8-3.2Z",
    drop: "M12 3s7 7.1 7 12a7 7 0 1 1-14 0c0-4.9 7-12 7-12Zm-3 13a3 3 0 0 0 3 2",
    close: "m6 6 12 12M18 6 6 18",
    messages: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  };
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] || paths.home} /></svg>;
}

async function localAction<T>(portal: Portal, path: string, _token: string | null, options: RequestInit = {}): Promise<T> {
  const backendAction = path === "/email/gmail/status" || path === "/email/gmail/connect" ||
    path === "/social/status" || /^\/advisories\/\d+\/email-delivery\/retry$/.test(path);
  if (backendAction) {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (_token) headers.set("Authorization", `Bearer ${_token}`);
    const response = await fetch(`${apiBaseUrl(portal)}${path}`, { ...options, headers });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error
        : `Request failed with status ${response.status}.`;
      throw new Error(message);
    }
    return result as T;
  }
  return supabaseAction<T>(portal, path, options);
}

function Brand({ portal }: { portal: Portal }) {
  return <a href={`/?portal=${portal}`} className="flex items-center gap-3 font-bold tracking-tight text-slate-900 no-underline">
    <span className="brand-symbol grid h-10 w-10 place-items-center rounded-xl bg-[#9f1745] text-white shadow-md"><Icon name="shield" /></span>
    <span>{settingsFor(portal).brand}<small className="mt-0.5 block text-[9px] font-semibold tracking-[.15em] text-slate-500">{copy("copy_64e10aede474")}</small></span>
  </a>;
}

function Login({ portal, onLogin, onRegister, error, busy }: { portal: Portal; onLogin: (event: FormEvent<HTMLFormElement>) => void; onRegister: (event: FormEvent<HTMLFormElement>) => void; error: string; busy: boolean }) {
  if (portal === "resident") return <ResidentAuth onLogin={onLogin} onRegister={onRegister} error={error} busy={busy} />;
  const isWater = portal === "water";
  const isCepalco = portal === "cepalco";
  return <main className={`grid min-h-screen bg-white lg:grid-cols-2 ${isWater ? "water-login" : ""} ${isCepalco ? "cepalco-login" : ""}`}>
    <section className={`login-art relative flex min-h-[260px] flex-col justify-between overflow-hidden bg-gradient-to-br from-rose-900 via-rose-700 to-rose-600 p-7 text-white sm:p-10 lg:min-h-screen lg:px-16 ${isWater ? "auth-water" : ""}`}>
      <Brand portal={portal} />
      <div className="relative z-10 my-auto max-w-lg py-10"><p className="mb-3 text-xs font-bold tracking-[.16em] text-rose-200">{copy("copy_0310fc064cb0")}</p><h1 className="mb-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">{isWater ? copy("copy_8344ba8731a9") : copy("copy_c39c90b8a3a9")}</h1><p className="max-w-md text-sm leading-7 text-white/80">{isCepalco ? copy("copy_914bb312bf61") : `Use your assigned ${settingsFor(portal).label} account to manage service advisories and community response.`}</p></div>
      <div className="relative z-10 flex gap-8 text-xs text-white/75"><span><strong className="block text-lg text-white">{copy("copy_4d8974777af1")}</strong>{copy("copy_51d91d456fe8")}</span><span><strong className="block text-lg text-white">{copy("copy_4f7838402f37")}</strong>{copy("copy_dfcc74dff330")}</span></div>
    </section>
    <section className="grid place-items-center px-6 py-12"><div className="w-full max-w-md">
      <p className="mb-2 text-[10px] font-extrabold tracking-[.16em] text-[var(--brand)]">{`${settingsFor(portal).label.toUpperCase()} SECURE ACCESS`}</p>
      <h2 className="mb-2 text-2xl font-extrabold text-slate-900">{isCepalco ? copy("copy_fbb349900c63") : `${settingsFor(portal).label} team sign in`}</h2>
      <p className="mb-6 text-sm leading-6 text-slate-500">{copy("copy_8645e230969a")}</p>
      <form onSubmit={onLogin} className="space-y-4">
        <label className="block text-xs font-bold text-slate-700">{copy("copy_5726ba9b0cf2")}<input name="email" type="email" autoComplete="username" required placeholder={copy("copy_7a9b9768f336")} className="mt-2 block w-full rounded-lg border border-slate-200 px-3 py-3 text-sm font-normal outline-none focus:border-[var(--brand)]" /></label>
        <label className="block text-xs font-bold text-slate-700">{copy("copy_e7cf3ef4f17c")}<input name="password" type="password" autoComplete="current-password" required placeholder={copy("copy_c06bf9670174")} className="mt-2 block w-full rounded-lg border border-slate-200 px-3 py-3 text-sm font-normal outline-none focus:border-[var(--brand)]" /></label>
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-[var(--brand)] px-4 py-3 text-sm font-bold text-white hover:bg-[var(--brand-dark)] disabled:opacity-60">{busy ? copy("copy_8b9d3de8ae00") : copy("copy_7455c624c0b2")}</button>
      </form>
      <p className="mt-6 border-t border-slate-100 pt-5 text-center text-xs text-slate-500">{copy("copy_111135c73240")}</p>
    </div></section>
  </main>;
}

function ResidentAuth({ onLogin, onRegister, error, busy }: { onLogin: (event: FormEvent<HTMLFormElement>) => void; onRegister: (event: FormEvent<HTMLFormElement>) => void; error: string; busy: boolean }) {
  const locationDefaults = requiredSetting(settingsFor("resident").locationDefaults, "resident.locationDefaults");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [localError, setLocalError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const strength = password.length >= 12 && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
    ? "Strong" : password.length >= 8 ? "Good" : password.length ? "Needs 8 characters" : "";

  function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setLocalError(copy("copy_6c6e178ad2a8"));
      return;
    }
    setLocalError(copy("copy_e3b0c44298fc"));
    onRegister(event);
  }

  function switchMode(next: "login" | "register") {
    setMode(next);
    setLocalError(copy("copy_e3b0c44298fc"));
    setPassword("");
    setConfirmPassword("");
    const formContent = document.querySelector<HTMLElement>(".resident-auth-content");
    if (formContent) formContent.scrollTop = 0;
  }

  const inputClass = "block w-full rounded-xl border border-slate-300 bg-slate-50/60 px-3.5 py-3 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:bg-white focus:border-rose-600 focus:ring-4 focus:ring-rose-500/15";
  const labelClass = "block text-xs font-bold uppercase tracking-wider text-slate-700";

  return <main className="resident-auth relative min-h-screen flex flex-col justify-center overflow-x-hidden bg-slate-950 text-slate-100 selection:bg-rose-500 selection:text-white">
    {/* Ambient Aurora Glow Lighting */}
    <div className="pointer-events-none absolute -top-40 -left-40 h-[650px] w-[650px] rounded-full bg-rose-600/15 blur-[140px]" />
    <div className="pointer-events-none absolute -bottom-40 -right-40 h-[650px] w-[650px] rounded-full bg-indigo-600/15 blur-[140px]" />
    <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[800px] w-[800px] rounded-full bg-sky-500/5 blur-[160px]" />

    {/* Main Authentication Showcase Container */}
    <section className="resident-auth-wrap relative z-10 flex flex-1 items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
      <div className={`resident-auth-card w-full max-w-[1180px] grid overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-2xl transition-all duration-300 lg:grid-cols-[1.05fr_1fr] ${mode === "register" ? "resident-register-card max-w-[1260px] lg:grid-cols-[0.8fr_1.2fr]" : ""}`}>

        {/* Left Panel: Civic Authority & Telemetry Hero */}
        <aside className="resident-auth-art relative flex flex-col justify-between overflow-hidden border-b border-white/10 bg-gradient-to-br from-slate-950 via-slate-900/95 to-slate-900 p-8 text-white sm:p-10 lg:border-b-0 lg:border-r lg:p-12">
          <div className="pointer-events-none absolute inset-0 opacity-10 bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:16px_16px]" />

          <div className="relative z-10">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-rose-400">
              {copy("copy_89ef45eb41e5")}
            </p>
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15">
                <Icon name="shield" className="h-5 w-5 text-rose-300" />
              </span>
              <span className="text-sm font-extrabold tracking-wide">
                {copy("copy_57f90a2f0d6f")}
                <span className="ml-2 font-normal text-slate-300">{copy("copy_a5e005832c4e")}</span>
              </span>
            </div>
          </div>

          <div className="relative z-10 my-8 max-w-lg lg:my-6">
            <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/15 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-rose-300">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
              {mode === "register" ? copy("copy_82e9d65b52ad") : copy("copy_47a64da286f4")}
            </span>
            <h1 className="mb-4 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
              {mode === "register" ? copy("copy_6abdc4acc7a5") : copy("copy_3ab7b05a2c0a")}
            </h1>
            <p className="mb-6 text-sm leading-relaxed text-slate-300">
              {mode === "register" ? copy("copy_a84c194716ff") : copy("copy_4a5daf58060f")}
            </p>

            {mode === "register" ? (
              <div className="space-y-3.5">
                {requiredSetting(settingsFor("resident").registerHighlights, "resident.registerHighlights").map(({ icon, title, detail }) => (
                  <div key={title} className="flex gap-3.5 rounded-xl border border-white/10 bg-white/5 p-3.5 transition hover:bg-white/10">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/30">
                      <Icon name={icon} className="h-4 w-4" />
                    </span>
                    <div>
                      <strong className="block text-xs font-bold text-white">{title}</strong>
                      <span className="mt-0.5 block text-xs leading-relaxed text-slate-300">{detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
                      <Icon name="shield" className="h-4 w-4 text-amber-400" />
                      CEPALCO Power Grid
                    </div>
                    <p className="mt-1 text-xs text-slate-300">Continuous feeder telemetry across 80 urban & rural barangays</p>
                    <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                      ● Active Dispatch
                    </span>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-xs font-bold text-cyan-300">
                      <Icon name="shield" className="h-4 w-4 text-cyan-400" />
                      Water District (COWD)
                    </div>
                    <p className="mt-1 text-xs text-slate-300">Pressure maintenance & emergency pipe repair advisories</p>
                    <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                      ● Live Feeds
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <span className="rounded-lg border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-slate-200">
                    {copy("copy_e678b8628ae8")}
                  </span>
                  <span className="rounded-lg border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-slate-200">
                    {copy("copy_246e670cb71d")}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="relative z-10 border-t border-white/10 pt-5">
            <div className="mb-3 flex flex-wrap gap-8 text-xs text-slate-400">
              <span>
                <strong className="block text-lg font-bold text-white">{copy("copy_4d8974777af1")}</strong>
                {copy("copy_51d91d456fe8")}
              </span>
              <span>
                <strong className="block text-lg font-bold text-white">{copy("copy_8c31e6e72230")}</strong>
                {copy("copy_dfcc74dff330")}
              </span>
            </div>
            <p className="m-0 text-[11px] text-slate-400">{copy("copy_a3c1dd22eac2")}</p>
          </div>
        </aside>

        {/* Right Panel: Clean Modern Authentication Form */}
        <section className="resident-auth-form flex flex-col justify-center bg-white p-6 sm:p-10 lg:p-12 text-slate-900">
          {/* Segmented Mode Switcher */}
          <div className="resident-auth-mode-switcher mb-6 flex rounded-xl bg-slate-100 p-1.5 ring-1 ring-slate-200/80">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${
                mode === "login"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-950"
              }`}
            >
              {copy("copy_c189840cf7e2")}
            </button>
            <button
              type="button"
              onClick={() => switchMode("register")}
              className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${
                mode === "register"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-950"
              }`}
            >
              {copy("copy_798ca2ce18bf")}
            </button>
          </div>

          <div className="resident-auth-content">
          <div className="mb-4 flex items-center justify-between">
            <p className="m-0 rounded-full bg-rose-50 px-3 py-1 text-xs font-bold tracking-wide text-rose-800">
              {mode === "register" ? copy("copy_5278b6dded60") : copy("copy_b80752d1ea40")}
            </p>
            <span className="text-xs text-slate-500">{copy("copy_d6acd37dc90e")}</span>
          </div>

          {mode === "login" ? (
            <>
              <h2 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">
                {copy("copy_54f9715d07d2")}
              </h2>
              <p className="mb-6 text-xs text-slate-500 font-normal">
                {copy("copy_75df0b478fe8")}
              </p>

              <form onSubmit={onLogin} className="space-y-4">
                <label className={labelClass}>
                  {copy("copy_f2488fd4ef4a")}
                  <input
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    placeholder={copy("copy_7b17fb0bd173")}
                    className={`${inputClass} mt-1.5`}
                  />
                </label>

                <label className={labelClass}>
                  <div className="flex items-center justify-between">
                    <span>{copy("copy_e7cf3ef4f17c")}</span>
                    <span className="text-[11px] font-normal text-slate-400 lowercase">{copy("copy_854fcaa4eae2")}</span>
                  </div>
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    placeholder={copy("copy_c06bf9670174")}
                    className={`${inputClass} mt-1.5`}
                  />
                </label>

                {(error || localError) && (
                  <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs font-semibold text-rose-800">
                    {localError || error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 py-3.5 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-600/25 transition active:scale-[0.99] disabled:opacity-60"
                >
                  {busy ? copy("copy_8b9d3de8ae00") : copy("copy_9ad3f03694b9")}
                </button>
              </form>

              <p className="mt-5 text-center text-xs text-slate-600">
                {copy("copy_5c5d4ae1083b")}
                <button onClick={() => switchMode("register")} className="font-bold text-rose-700 hover:underline">
                  {copy("copy_14272ede1c39")}
                </button>
              </p>

              <p className="mt-4 border-t border-slate-100 pt-4 text-center text-xs text-slate-400">
                {copy("copy_5df1da863fb0")}
              </p>
            </>
          ) : (
            <>
              <h2 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">
                {copy("copy_8d162b371011")}
              </h2>
              <p className="mb-4 text-xs leading-relaxed text-slate-500">
                {copy("copy_124ed6be4b83")}
              </p>

              <form onSubmit={submitRegistration} className="space-y-3.5">
                <label className={labelClass}>
                  {copy("copy_e52e32bd2ddb")}
                  <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                  <input
                    name="name"
                    required
                    maxLength={120}
                    autoComplete="name"
                    placeholder={copy("copy_d636827b1783")}
                    className={`${inputClass} mt-1.5`}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    {copy("copy_fa12ae8c3d6f")}
                    <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    <input
                      name="phoneNumber"
                      type="tel"
                      required
                      maxLength={40}
                      autoComplete="tel"
                      placeholder={copy("copy_65bc675f13d8")}
                      className={`${inputClass} mt-1.5`}
                    />
                    <small className="mt-1 block text-[11px] font-normal text-slate-500">{copy("copy_21c340f2cd3d")}</small>
                  </label>

                  <label className={labelClass}>
                    {copy("copy_97c04721f9d3")}
                    <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      placeholder={copy("copy_39a22add5269")}
                      className={`${inputClass} mt-1.5`}
                    />
                    <small className="mt-1 block text-[11px] font-normal text-slate-500">{copy("copy_f8fe71ad3fc4")}</small>
                  </label>
                </div>

                <fieldset className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <legend className="px-2 text-xs font-bold uppercase tracking-wider text-rose-800">
                    {copy("copy_856936b55ec1")}
                  </legend>
                  <div className="grid gap-3">
                    <label className={labelClass}>
                      {copy("copy_440467b52757")}
                      <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                      <input
                        name="address"
                        required
                        maxLength={240}
                        autoComplete="street-address"
                        placeholder={copy("copy_43bc6228d8b4")}
                        className={`${inputClass} mt-1.5`}
                      />
                    </label>

                    <div className="grid gap-3 sm:grid-cols-[1fr_130px]">
                      <label className={labelClass}>
                        {copy("copy_52630f30e6ef")}
                        <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                        <input
                          name="barangay"
                          list="resident-barangays"
                          required
                          maxLength={100}
                          autoComplete="address-level3"
                          placeholder={copy("copy_c3b5b226013a")}
                          className={`${inputClass} mt-1.5`}
                        />
                        <datalist id="resident-barangays">
                          {requiredSetting(settingsFor("resident").barangays, "resident.barangays").map(name => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      </label>

                      <label className={labelClass}>
                        {copy("copy_18c62c7ea10b")}
                        <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                        <input
                          name="postalCode"
                          required
                          maxLength={20}
                          autoComplete="postal-code"
                          placeholder={locationDefaults.postalCode}
                          defaultValue={locationDefaults.postalCode}
                          className={`${inputClass} mt-1.5`}
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className={labelClass}>
                        {copy("copy_338de443b2af")}
                        <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                        <select name="district" required defaultValue="" className={`${inputClass} mt-1.5`}>
                          <option value={copy("copy_e3b0c44298fc")} disabled>{copy("copy_11aaa5f43d2b")}</option>
                          {requiredSetting(settingsFor("resident").districts, "resident.districts").map(district => (
                            <option key={district}>{district}</option>
                          ))}
                        </select>
                      </label>

                      <label className={labelClass}>
                        {copy("copy_04b621f376b3")}
                        <input
                          name="city"
                          required
                          value={locationDefaults.city}
                          readOnly
                          className={`${inputClass} mt-1.5 bg-slate-100 text-slate-500`}
                        />
                      </label>
                    </div>
                  </div>
                </fieldset>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    {copy("copy_68ecf962332c")}
                    <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    <input
                      name="password"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      value={password}
                      onChange={event => setPassword(event.target.value)}
                      placeholder={copy("copy_977f3b2676a9")}
                      className={`${inputClass} mt-1.5`}
                    />
                    <small className="mt-1 block text-[11px] font-normal text-slate-500">{copy("copy_aa7e8499fa62")}</small>
                  </label>

                  <label className={labelClass}>
                    {copy("copy_b186ebc5096d")}
                    <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    <input
                      name="confirmPassword"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={event => setConfirmPassword(event.target.value)}
                      placeholder={copy("copy_210dfc7e4536")}
                      className={`${inputClass} mt-1.5`}
                    />
                    <div className="mt-1 flex items-center justify-between">
                      <small className="text-[11px] font-semibold text-slate-600">
                        {strength ? `Strength: ${strength}` : copy("copy_551df75ec882")}
                      </small>
                    </div>
                    {/* Visual strength meter bar */}
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full transition-all duration-300 ${
                          strength === "Strong"
                            ? "w-full bg-emerald-500"
                            : strength === "Good"
                            ? "w-2/3 bg-blue-500"
                            : strength
                            ? "w-1/3 bg-amber-500"
                            : "w-0"
                        }`}
                      />
                    </div>
                  </label>
                </div>

                {(error || localError) && (
                  <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                    {localError || error}
                  </p>
                )}

                <div className="space-y-2 pt-1">
                  <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                    <input name="termsAccepted" type="checkbox" required className="mt-0.5 h-4 w-4 rounded accent-rose-600" />
                    <span>
                      {copy("copy_bdb74034a9d2")}
                      <strong className="text-rose-700 ml-1">{copy("copy_add882140045")}</strong>
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                    <input name="smsAlerts" type="checkbox" defaultChecked className="mt-0.5 h-4 w-4 rounded accent-rose-600" />
                    <span>{copy("copy_e2d06d28e9c3")}</span>
                  </label>

                  <p className="m-0 pl-6 text-slate-500 text-[11px]">{copy("mandatoryAdvisoryEmailInfo")}</p>
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 py-3.5 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-600/25 transition active:scale-[0.99] disabled:opacity-60"
                >
                  {busy ? copy("copy_f2daf61e527b") : copy("copy_582e329beb8d")}
                </button>
              </form>

              <p className="mt-4 text-center text-xs text-slate-600">
                {copy("copy_04a38dd010ed")}
                <button onClick={() => switchMode("login")} className="font-bold text-rose-700 hover:underline">
                  {copy("copy_3233beba694b")}
                </button>
              </p>

              <p className="mt-3 border-t border-slate-100 pt-3 text-center text-xs text-slate-400">
                {copy("copy_d66ba85e9208")}
              </p>
            </>
          )}
          </div>
        </section>
      </div>
    </section>

  </main>;
}

function App({ portal }: { portal: Portal }) {
  const [token, setToken] = useState<string | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [page, setPage] = useState(new URLSearchParams(location.search).get("page") || "overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<{ advisories: Advisory[]; workOrders: WorkOrder[]; reports: ServiceReport[]; network: NetworkReading[] }>({ advisories: [], workOrders: [], reports: [], network: [] });
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<"advisory" | "work" | null>(null);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [inbox, setInbox] = useState<SMSRecord[]>([]);
  const [publishedDelivery, setPublishedDelivery] = useState<{ advisoryId: number; summary: EmailDeliverySummary } | null>(null);
  const [retryingEmail, setRetryingEmail] = useState(false);
  const isResident = portal === "resident";

  useEffect(() => {
    let active = true;
    try {
      const supabase = getSupabase();
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return;
        const accessToken = session?.access_token ?? null;
        setToken(accessToken);
        if (accessToken) {
          localStorage.setItem(`civicalert:${portal}:account`, accessToken);
        } else {
          localStorage.removeItem(`civicalert:${portal}:account`);
        }
      });
      void supabase.auth.getSession().then(({ data, error: sessionError }) => {
        if (!active) return;
        if (sessionError) {
          setError(sessionError.message);
          return;
        }
        setToken(data.session?.access_token ?? null);
      }).catch(err => {
        if (active) setError(err instanceof Error ? err.message : "Could not restore your Supabase session.");
      });
      return () => {
        active = false;
        subscription.unsubscribe();
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Supabase is not configured.");
    }
  }, [portal]);

  useEffect(() => {
    if (token && actor) void loadWorkspace();
  }, [token, actor, page]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void localAction<{ actor: Actor }>(portal, "/auth/me", token).then(response => {
      if (active) setActor(response.actor);
    }).catch(err => {
      if (!active) return;
      void getSupabase().auth.signOut();
      setActor(null);
      setToken(null);
      setError(err instanceof Error ? err.message : copy("copy_fd2a9a955861"));
    });
    return () => { active = false; };
  }, [token, portal]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const gmailResult = query.get("gmail");
    if (!gmailResult) return;
    const gmailErrors: Record<string, string> = {
      cancelled: "Gmail connection was cancelled.",
      invalid_state: "Gmail connection expired or could not be verified. Start Connect Gmail again.",
      redirect_uri: "Google rejected the callback URL. Confirm the authorized redirect URI exactly matches this API's callback URL.",
      oauth_client: "Google rejected the OAuth client. Check the client ID and secret in the API environment.",
      account_mismatch: "Connect the Gmail account configured as this utility's official sender address.",
      refresh_token: "Google did not provide a refresh token. Reconnect Gmail and approve offline access.",
      server_config: "Gmail OAuth is not fully configured on the API. Check the required Gmail environment variables.",
      invalid_grant: "Google authorization expired or was already used. Start Connect Gmail again.",
      google_error: "Google rejected the authorization request. Check the consent screen, test-user access, and Gmail API setup.",
    };
    const gmailError = query.get("gmailError");
    setToast(gmailResult === "connected"
      ? "Official Gmail account connected."
      : gmailErrors[gmailError ?? ""] ?? "Gmail connection did not complete. Check OAuth configuration and try again.");
    query.delete("gmail");
    query.delete("gmailError");
    const remainingQuery = query.toString();
    history.replaceState({}, "", `${location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${location.hash}`);
  }, []);

  async function loadWorkspace() {
    setLoading(true);
    try {
      if (isResident) {
        const [advisories, workOrders] = await Promise.all([
          localAction<Advisory[]>(portal, "/advisories", token),
          localAction<WorkOrder[]>(portal, "/work-orders", token),
        ]);
        setItems({ advisories, reports: [], workOrders, network: [] });
      } else {
        const [advisories, workOrders, network] = await Promise.all([
          localAction<Advisory[]>(portal, "/advisories", token),
          localAction<WorkOrder[]>(portal, "/work-orders", token),
          portal === "water" ? localAction<NetworkReading[]>(portal, "/network", token) : Promise.resolve([]),
        ]);
        setItems({ advisories, workOrders, reports: [], network });
      }
      setInbox(isResident ? await localAction<SMSRecord[]>(portal, "/inbox", token) : []);
      setError(copy("copy_e3b0c44298fc"));
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_e583d95bd720"));
    } finally {
      setLoading(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const form = new FormData(event.currentTarget);
    try {
      const response = await localAction<{ token: string; actor: Actor }>(portal, "/auth/login", null, { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
      localStorage.setItem(`civicalert:${portal}:account`, response.token);
      setActor(response.actor); setToken(response.token);
      history.replaceState({}, "", `/?portal=${portal}&view=portal`);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_26739f00e5f8"));
    } finally { setBusy(false); }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const data = new FormData(event.currentTarget);
    try {
      const response = await localAction<{ token: string; actor: Actor }>(portal, "/auth/register", null, { method: "POST", body: JSON.stringify({
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
        phoneNumber: data.get("phoneNumber"),
        address: data.get("address"),
        barangay: data.get("barangay"),
        district: data.get("district"),
        city: data.get("city"),
        postalCode: data.get("postalCode"),
        termsAccepted: data.get("termsAccepted") === "on",
        smsAlerts: data.get("smsAlerts") === "on",
      }) });
      localStorage.setItem(`civicalert:${portal}:account`, response.token);
      setActor(response.actor); setToken(response.token);
      history.replaceState({}, "", `/?portal=${portal}&view=portal`);
    } catch (err) { setError(err instanceof Error ? err.message : copy("copy_a4e72985120c")); }
    finally { setBusy(false); }
  }

  function navigate(nextPage: string) {
    setPage(nextPage); setMobileMenu(false);
    history.pushState({}, "", `/?portal=${portal}&view=portal&page=${nextPage}`);
  }

  async function retryFailedEmails() {
    if (!token || !publishedDelivery) return;
    setRetryingEmail(true);
    setError("");
    try {
      const summary = await localAction<EmailDeliverySummary>(
        portal,
        `/advisories/${publishedDelivery.advisoryId}/email-delivery/retry`,
        token,
        { method: "POST", body: JSON.stringify({}) },
      );
      setPublishedDelivery({ ...publishedDelivery, summary });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry email delivery.");
    } finally {
      setRetryingEmail(false);
    }
  }

  async function submitRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !modal) return;
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    const endpoint = modal === "advisory" ? "/advisories" : "/work-orders";
    try {
      await localAction(portal, endpoint, token, { method: "POST", body: JSON.stringify(body) });
      setModal(null);
      setToast(modal === "advisory" ? copy("copy_281a95eb4f15") : copy("copy_05c2120eac8d"));
      window.setTimeout(() => setToast(copy("copy_e3b0c44298fc")), 3200);
      await loadWorkspace();
    } catch (err) { setError(err instanceof Error ? err.message : copy("copy_abdb0d7935bb")); }
  }

  async function publishAnnouncement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((portal !== "cepalco" && portal !== "water") || !token) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const imageDataUrl = await readAnnouncementImage(form.get("announcementImage"));
      const selectedChannels = [...new Set([
        ...form.getAll("channels").map(String),
        ...REQUIRED_ANNOUNCEMENT_CHANNELS,
      ])];
      if (selectedChannels.length === 0) {
        throw new Error("Select at least one announcement channel.");
      }
      if (selectedChannels.some(channel => ["facebook", "instagram", "gmail"].includes(channel)) && !imageDataUrl) {
        throw new Error("Add an announcement image before publishing to Facebook, Instagram, or Gmail.");
      }
      const scheduledAtInput = String(form.get("scheduledAt") || "");
      const published = await localAction<{
        id: number;
        scheduledAt: string | null;
        facebookUrl?: string | null;
        instagramUrl?: string | null;
        emailDelivery?: EmailDeliverySummary | null;
        socialDelivery?: {
          platforms: Array<{ platform: string; status: string; message?: string; permalinkUrl?: string }>;
        } | null;
        smsQueued?: number;
      }>(portal, "/advisories", token, {
        method: "POST",
        body: JSON.stringify({
          title: form.get("title"),
          area: form.get("area"),
          type: form.get("category"),
          priority: form.get("priority"),
          serviceStartsAt: form.get("serviceStartsAt") || null,
          estimatedRestorationAt: form.get("estimatedRestorationAt") || null,
          details: form.get("details"),
          latitude: form.get("latitude") || null,
          longitude: form.get("longitude") || null,
          imageDataUrl,
          channels: selectedChannels,
          scheduledAt: scheduledAtInput ? new Date(scheduledAtInput).toISOString() : null,
        }),
      });
      if (published.emailDelivery) {
        setPublishedDelivery({ advisoryId: published.id, summary: published.emailDelivery });
      } else {
        setPublishedDelivery(null);
      }
      if (published.scheduledAt) {
        setToast(`Announcement scheduled for ${formatResidentDateTime(published.scheduledAt)}. No channel deliveries will start before then.`);
      } else {
        const deliveryResults: string[] = [];
        if (selectedChannels.includes("gmail")) {
          const summary = published.emailDelivery;
          deliveryResults.push(`Gmail: ${summary?.sent ? `${summary.sent} sent${summary.failed ? `, ${summary.failed} failed` : ""}` : summary?.failed ? `${summary.failed} failed` : summary?.status === "no_recipients" ? "no resident accounts" : "not sent"}`);
        }
        for (const platform of published.socialDelivery?.platforms ?? []) {
          deliveryResults.push(`${platform.platform}: ${platform.status}${platform.permalinkUrl ? ` — ${platform.permalinkUrl}` : ""}${platform.message ? ` (${platform.message})` : ""}`);
        }
        if (selectedChannels.includes("sms")) {
          deliveryResults.push(published.smsQueued
            ? `SMS: simulated inbox alert for ${published.smsQueued} resident(s)`
            : "SMS: no opted-in residents with phone numbers; no text was sent");
        }
        setToast(`Announcement saved. ${deliveryResults.join("; ")}`);
      }
      window.setTimeout(() => setToast(""), 5000);
      await loadWorkspace();
      navigate("incidents");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish announcement.");
    } finally {
      setBusy(false);
    }
  }

  async function updateAdvisoryStatus(item: Advisory) {
    const nextStatus: Status = item.status === "Under investigation" ? "Crew dispatched" : item.status === "Crew dispatched" ? "Resolved" : "Under investigation";
    setError(copy("copy_e3b0c44298fc"));
    try {
      await localAction(portal, `/advisories/${item.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setToast(copy("copy_630120fb8f96").replace("{status}", nextStatus));
      window.setTimeout(() => setToast(copy("copy_e3b0c44298fc")), 3200);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_fc9a5a3ff0fc"));
    }
  }

  async function updateReportStatus(item: ServiceReport) {
    if (!token) return;
    const nextStatus: Status = item.status === "Received" ? "Under investigation" : item.status === "Under investigation" ? "Crew dispatched" : item.status === "Crew dispatched" ? "Resolved" : "Received";
    setError(copy("copy_e3b0c44298fc"));
    try {
      await localAction(portal, `/reports/${item.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setToast(copy("copy_a3fb79f419d5").replace("{status}", nextStatus));
      window.setTimeout(() => setToast(copy("copy_e3b0c44298fc")), 3200);
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_c1c828c37712"));
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !actor) return;
    setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const form = new FormData(event.currentTarget);
    try {
      const response = await localAction<{ actor: Actor }>(portal, "/auth/profile", token, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          phoneNumber: form.get("phoneNumber"),
          address: form.get("address"),
          barangay: form.get("barangay"),
          district: form.get("district"),
          city: form.get("city"),
          postalCode: form.get("postalCode"),
          smsAlerts: form.get("smsAlerts") === "on",
          maintenanceAlerts: form.get("maintenanceAlerts") === "on",
          emailDigest: form.get("emailDigest") === "on",
          profileImage: profileImage === null ? actor.profileImage ?? null : profileImage || null,
        }),
      });
      setActor(response.actor);
      setProfileImage(null);
      setToast(copy("copy_8a2ad73ece0c"));
      window.setTimeout(() => setToast(copy("copy_e3b0c44298fc")), 3200);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_c2da79d0971c"));
    } finally { setBusy(false); }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    if (newPassword !== form.get("confirmPassword")) {
      setError(copy("copy_8298ff5890a5"));
      setBusy(false);
      return;
    }
    try {
      await localAction(portal, "/auth/password", token, {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      formElement.reset();
      setToast(copy("copy_00e34a98f659"));
      window.setTimeout(() => setToast(copy("copy_e3b0c44298fc")), 3200);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_7eb1480a3453"));
    } finally { setBusy(false); }
  }

  function signOut() {
    void getSupabase().auth.signOut();
    localStorage.removeItem(`civicalert:${portal}:account`);
    setActor(null); setToken(null); setItems({ advisories: [], workOrders: [], reports: [], network: [] });
    history.replaceState({}, "", `/?portal=${portal}`);
  }

  if (!token || !actor) return <Login portal={portal} onLogin={login} onRegister={register} error={error} busy={busy} />;

  const nav = settingsFor(portal).navigation;
  const advisories = items.advisories;
  const activeAdvisories = advisories.filter(item =>
    !["Resolved", "Operational"].includes(item.status) &&
    (item.publicationStatus === undefined || item.publicationStatus === "published"));
  const currentSettings = settingsFor(portal);
  const mainTitle = currentSettings.pageTitles[page] || currentSettings.pageTitles.overview;
  const pageDescription = currentSettings.pageDescriptions[page] || currentSettings.pageDescriptions.overview;
  const newButton = currentSettings.publishButtonLabel;
  const sectionItems = page === "scheduled" ? items.workOrders : page === "residents" ? items.reports : advisories;

  return <main className={`portal-${portal} min-h-screen`}>
    <header className="portal-header sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-7">
      <div className="flex items-center gap-3"><button onClick={() => setMobileMenu(!mobileMenu)} className="rounded-lg border border-slate-200 p-2 text-slate-600 lg:hidden" aria-label={copy("copy_dfc1e6d16ba5")}>{copy("copy_67cfd5703605")}</button><Brand portal={portal} /></div>
      <div className="flex items-center gap-4"><span className="hidden text-xs text-slate-500 sm:inline">{copy("copy_7a34ff85344e")}</span>{isResident ? <button onClick={() => navigate("profile")} className="flex items-center gap-2 text-xs font-semibold text-slate-700">{actor.profileImage ? <img src={actor.profileImage} alt={copy("copy_e3b0c44298fc")} className="h-8 w-8 rounded-full object-cover" /> : <span className="avatar grid h-8 w-8 place-items-center rounded-full bg-rose-50 text-rose-700">{actor.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}</span>}<span className="hidden sm:inline">{actor.name}</span></button> : <div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><span className="avatar grid h-8 w-8 place-items-center rounded-full bg-rose-50 text-rose-700">{actor.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}</span><span className="hidden sm:inline">{actor.name}</span></div>}</div>
    </header>
    <div className="portal-layout mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-7 lg:grid-cols-[225px_minmax(0,1fr)] lg:gap-6 lg:py-7">
      <aside className={`portal-sidebar ${mobileMenu ? "fixed inset-y-16 left-0 z-10 block w-[280px] overflow-y-auto shadow-xl" : "hidden"} h-fit rounded-xl border border-slate-200 bg-white p-3 lg:sticky lg:top-20 lg:block`}>
        <p className="px-3 pb-3 pt-2 text-[9px] font-extrabold tracking-[.14em] text-slate-400">{currentSettings.sidebarLabel}</p>
        {nav.map(({ key, label, icon }) => <button key={key} onClick={() => navigate(key)} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-semibold ${page === key ? "active-nav bg-rose-50 text-rose-800" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"}`}><Icon name={icon} className="h-4 w-4" />{label}{(key === "incidents" || (isResident && key === "advisories")) && activeAdvisories.length > 0 && <span className="nav-count ml-auto rounded-full bg-white px-2 py-0.5 text-[9px] text-rose-700">{activeAdvisories.length}</span>}{key === "inbox" && inbox.some(message => !message.read) && <span className="nav-count ml-auto rounded-full bg-white px-2 py-0.5 text-[9px] text-rose-700">{inbox.filter(message => !message.read).length}</span>}</button>)}
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-[10px] leading-5 text-slate-500"><strong className="block text-[11px] text-slate-700">{copy("copy_dd5f522c6551")}</strong>{isResident ? copy("copy_e3659a65afce") : copy("copy_053e2c45051b")}</div>
        <button onClick={signOut} className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-semibold text-slate-500 hover:bg-slate-50"><Icon name="shield" className="h-4 w-4" />{copy("copy_48f0d3d397d4")}</button>
      </aside>
      <section className="min-w-0">
        <div className="portal-page-heading mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="mb-2 text-[9px] font-extrabold tracking-[.15em] text-[var(--brand)]">{currentSettings.pageHeadingLabel}</p><h1 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{page === "overview" && isResident ? `${currentSettings.overviewGreetingPrefix} ${actor.name.split(" ")[0]}` : mainTitle}</h1><p className="m-0 text-xs text-slate-500">{pageDescription}</p></div>
          <div className="flex items-center gap-2">{(page === "overview" || (page === "incidents" && portal !== "cepalco")) && !isResident && <button onClick={() => portal === "water" || portal === "cepalco" ? navigate("publish") : setModal("advisory")} className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-3 py-2.5 text-xs font-bold text-white hover:bg-[var(--brand-dark)]"><Icon name="plus" className="h-4 w-4" />{newButton}</button>}{page === "scheduled" && !isResident && <button onClick={() => setModal("work")} className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-3 py-2.5 text-xs font-bold text-white"><Icon name="plus" className="h-4 w-4" />{copy("copy_311599f38345")}</button>}<span className="hidden rounded-full border border-slate-200 bg-white px-3 py-2 text-[10px] font-semibold text-slate-500 md:inline">{new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric" }).format(new Date())}</span></div>
        </div>
        {error && token && <div role="alert" className="mb-4 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><span>{error}</span><button onClick={() => setError(copy("copy_e3b0c44298fc"))} aria-label={copy("copy_2db046678b9c")}><Icon name="close" /></button></div>}
        {publishedDelivery && <div role="status" className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm ${publishedDelivery.summary.failed ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
          <span>{advisoryPublishMessage("", publishedDelivery.summary)}</span>
          {publishedDelivery.summary.failed > 0 && <button type="button" onClick={() => void retryFailedEmails()} disabled={retryingEmail} className="rounded-md border border-current px-3 py-2 text-xs font-semibold disabled:opacity-60">{retryingEmail ? "Retrying…" : "Retry failed email(s)"}</button>}
        </div>}
        {loading && <div className="mb-4 h-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full w-1/3 animate-pulse bg-[var(--brand)]" /></div>}
        {page === "overview" ? <Overview portal={portal} actor={actor} advisories={activeAdvisories} workOrders={items.workOrders} network={items.network} onNavigate={navigate} onAction={kind => kind === "advisory" && !isResident ? navigate("publish") : setModal(kind)} /> : isResident && page === "inbox" ? <VirtualInbox messages={inbox} onRead={async message => { await localAction(portal, `/inbox/${message.id}/read`, token, { method: "PATCH" }); await loadWorkspace(); }} /> : page === "profile" && isResident ? <ResidentProfile actor={actor} selectedImage={profileImage} saving={busy} onImageChange={setProfileImage} onSave={saveProfile} onPasswordChange={updatePassword} /> : page === "advisories" && isResident ? <ResidentAdvisories items={items.advisories} workOrders={items.workOrders} /> : (portal === "cepalco" || portal === "water") && page === "publish" ? portal === "water" ? <WaterPublishForm busy={busy} token={token} onCancel={() => navigate("overview")} onSubmit={publishAnnouncement} /> : <AnnouncementComposer portal={portal} busy={busy} token={token} onCancel={() => navigate("overview")} onSubmit={publishAnnouncement} /> : portal === "cepalco" && page === "incidents" ? <CepalcoDisruptions items={items.advisories} onStatusUpdate={updateAdvisoryStatus} /> : portal === "cepalco" && page === "scheduled" ? <CepalcoSchedule workOrders={items.workOrders} onCreate={() => setModal("work")} /> : portal === "water" && page === "incidents" ? <WaterAdvisories items={items.advisories} /> : portal === "water" && page === "scheduled" ? <WaterSchedule items={items.workOrders} onCreate={() => setModal("work")} /> : portal === "cepalco" && page === "restoration" ? <CepalcoRestorationMap advisories={advisories} /> : page === "restoration" ? <Network portal={portal} advisories={advisories} network={items.network} /> : page === "services" ? <Services advisories={items.advisories} /> : <section className="space-y-4">
          {page === "incidents" && <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex min-w-[230px] flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-slate-400"><Icon name="search" className="h-4 w-4" /><input className="w-full border-0 bg-transparent text-xs text-slate-800 outline-none" placeholder={copy("copy_7145ac5f783f")} onChange={event => document.querySelectorAll<HTMLElement>("[data-search-item]").forEach(card => { card.hidden = !card.innerText.toLowerCase().includes(event.target.value.toLowerCase()); })} /></label>{!isResident && <button onClick={() => setModal("advisory")} className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-xs font-bold text-white">{copy("copy_dd425feef83c")}{newButton}</button>}</div>}
          <div className="grid gap-3 xl:grid-cols-2">{sectionItems.map(item => <DataCard key={item.id} item={item} page={page} />)}{sectionItems.length === 0 && <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">{copy("copy_9b2835326f52")}</div>}</div>
        </section>}
      </section>
    </div>
    {toast && <div role={toast.startsWith("Announcement saved.") && /failed|not_configured|no resident accounts|no text was sent|not sent/i.test(toast) ? "alert" : "status"} className={`fixed bottom-5 right-5 z-40 rounded-lg px-4 py-3 text-sm font-medium text-white shadow-xl ${toast.startsWith("Announcement saved.") && /failed|not_configured|no resident accounts|no text was sent|not sent/i.test(toast) ? "bg-amber-800" : "bg-emerald-900"}`}>{toast}</div>}
    {modal && <RecordModal portal={portal} kind={modal} onClose={() => setModal(null)} onSubmit={submitRecord} />}
  </main>;
}

function ResidentProfile({ actor, selectedImage, saving, onImageChange, onSave, onPasswordChange }: { actor: Actor; selectedImage: string | null; saving: boolean; onImageChange: (image: string | null) => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onPasswordChange: (event: FormEvent<HTMLFormElement>) => void }) {
  const [imageError, setImageError] = useState("");
  const image = selectedImage === null ? actor.profileImage : selectedImage || null;
  function selectImage(file?: File) {
    setImageError("");
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 1024 * 1024) {
      setImageError("Choose a JPEG, PNG, or WebP image smaller than 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? onImageChange(reader.result) : setImageError("Could not read this image. Please try another file.");
    reader.onerror = () => setImageError("Could not read this image. Please try another file.");
    reader.readAsDataURL(file);
  }
  function downloadProfile() {
    const file = new Blob([JSON.stringify(actor, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "civicalert-resident-profile.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const fieldClass = "mt-1.5 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-[#64234f] focus:ring-2 focus:ring-[#64234f]/15 shadow-sm transition-all";
  const labelClass = "block text-xs font-semibold text-slate-700";
  return <div className="resident-profile-page space-y-4">
    <article className="resident-profile-card flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
      {image ? <img src={image} alt={`${actor.name} profile`} className="h-16 w-16 rounded-full border border-slate-200 object-cover shadow-sm" /> : <span className="avatar grid h-16 w-16 place-items-center rounded-full bg-rose-50 text-xl font-bold text-rose-700 shadow-sm">{actor.name.split(" ").map(part => part[0]).slice(0, 2).join("").toUpperCase()}</span>}
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-base font-bold text-slate-900">{actor.name}</strong><span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">{copy("copy_39882d1ad5ec")}</span></div><p className="mb-0 mt-1 text-xs text-slate-500">{actor.barangay || "Barangay not set"}{actor.district ? ` · ${actor.district}` : ""} {copy("copy_6e01f78b9eb4")}{actor.city || "Cagayan de Oro City"}</p><p className="mb-0 mt-1 text-xs text-slate-400">{copy("copy_cbbd7f35fdea")}{actor.email}</p></div>
      <div className="flex flex-wrap gap-2"><label className="cursor-pointer rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition-colors">{copy("copy_c5fbcb8b00ea")}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={event => selectImage(event.currentTarget.files?.[0])} /></label>{image && <button type="button" onClick={() => { onImageChange(""); setImageError(""); }} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 shadow-sm transition-colors">{copy("copy_c3812fc4acb8")}</button>}</div>
      {imageError && <p role="alert" className="w-full text-xs font-medium text-rose-700">{imageError}</p>}
    </article>

    <form onSubmit={onSave} className="space-y-4">
      <article className="resident-profile-card rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <h2 className="mb-4 mt-0 text-base font-bold text-slate-900">{copy("copy_3a8867786365")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>{copy("copy_f603e86165b0")}<input name="name" required maxLength={120} defaultValue={actor.name} autoComplete="name" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_09bf25ef3083")}<input name="email" type="email" required defaultValue={actor.email} autoComplete="email" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_ba148fbc44de")}<input name="phoneNumber" type="tel" maxLength={40} defaultValue={actor.phoneNumber || ""} autoComplete="tel" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_e7cf3ef4f17c")}<input type="password" value={copy("copy_6becb7727529")} readOnly className={`${fieldClass} bg-slate-50`} /><span className="mt-1 block text-xs font-normal text-slate-400">{copy("copy_9b9e587044c6")}</span></label>
        </div>
      </article>
      <article className="resident-profile-card rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-2"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_6f9f42ba937e")}</h2><span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-bold text-violet-700">{copy("copy_8a59897bdc1a")}</span></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={`${labelClass} sm:col-span-2`}>{copy("copy_432d86cc06aa")}<input name="address" maxLength={240} defaultValue={actor.address || ""} autoComplete="street-address" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_ad1315f3e999")}<input name="barangay" list="profile-barangays" maxLength={100} defaultValue={actor.barangay || ""} autoComplete="address-level3" className={fieldClass} /><datalist id="profile-barangays">{requiredSetting(settingsFor("resident").barangays, "resident.barangays").map(name => <option key={name} value={name} />)}</datalist></label>
          <label className={labelClass}>{copy("copy_ac3506fe618c")}<input name="postalCode" maxLength={20} defaultValue={actor.postalCode || ""} autoComplete="postal-code" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_c4473f4e49d0")}<input name="district" maxLength={80} defaultValue={actor.district || ""} className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_1f15f6d9f6b5")}<input name="city" maxLength={100} defaultValue={actor.city || ""} autoComplete="address-level2" className={fieldClass} /></label>
        </div>
      </article>
      <article className="resident-profile-card rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_327f37078430")}</h2><p className="mb-0 mt-1 text-xs text-slate-500">{copy("copy_1b1d2a642be6")}</p></div>
        <ProfilePreference name="smsAlerts" checked={actor.smsAlerts ?? true} title={copy("copy_ab3dd828aa41")} description={copy("copy_abe5bf56e7fd")} />
        <ProfilePreference name="maintenanceAlerts" checked={actor.maintenanceAlerts ?? true} title={copy("copy_c1d8fd5aca7b")} description={copy("copy_c59d87c00621")} />
        <ProfilePreference name="emailDigest" checked={actor.emailDigest ?? true} title={copy("copy_70c407729c22")} description={copy("copy_379b43036c4a")} />
        <p className="mb-0 mt-3 text-xs text-slate-500">{copy("mandatoryAdvisoryEmailInfo")}</p>
        <p className="mb-0 mt-2 text-xs text-slate-400">{copy("copy_516efbeb02d9")}</p>
      </article>
      <div className="flex justify-end"><button disabled={saving} className="rounded-xl bg-[#64234f] px-6 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-[#521c40] disabled:opacity-60 transition-colors">{saving ? copy("copy_395207583eb8") : copy("copy_1964f29935ed")}</button></div>
    </form>

    <article className="resident-profile-card rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="mb-1 mt-0 text-[11px] font-bold text-slate-900">{copy("copy_766b3efdf18a")}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={onPasswordChange} className="rounded-lg border border-slate-100 p-3">
          <div className="mb-3 flex items-center justify-between"><strong className="text-[9px] text-slate-800">{copy("copy_4e70f1fd24ba")}</strong><span className="text-[8px] text-slate-400">{copy("copy_8e05740c775c")}</span></div>
          <div className="grid gap-2 sm:grid-cols-3">
            <input name="currentPassword" type="password" autoComplete="current-password" required placeholder={copy("copy_72ed2bd767ce")} className="min-w-0 rounded-md border border-slate-200 px-2 py-2 text-[8px]" />
            <input name="newPassword" type="password" autoComplete="new-password" minLength={8} required placeholder={copy("copy_3dd9df4441fb")} className="min-w-0 rounded-md border border-slate-200 px-2 py-2 text-[8px]" />
            <input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required placeholder={copy("copy_1b07cd5191be")} className="min-w-0 rounded-md border border-slate-200 px-2 py-2 text-[8px]" />
          </div>
          <button disabled={saving} className="mt-3 rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-700 disabled:opacity-60">{copy("copy_fe45b4014135")}</button>
        </form>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 p-3"><span><strong className="block text-[9px] text-slate-800">{copy("copy_90c788511970")}</strong><small className="mt-1 block text-[8px] text-slate-500">{copy("copy_8600b2680c06")}</small></span><button type="button" disabled title={copy("copy_e215edc152ff")} className="rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-400">{copy("copy_67a926f7008e")}</button></div>
      </div>
    </article>
    <article className="resident-profile-card flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><div><h2 className="mb-1 mt-0 text-[10px] font-bold text-slate-900">{copy("copy_519ce5a1d593")}</h2><p className="m-0 text-[8px] text-slate-500">{copy("copy_107e0c28b8a3")}</p></div><button type="button" onClick={downloadProfile} className="rounded-md bg-[#64234f] px-3 py-2 text-[8px] font-bold text-white">{copy("copy_5c4238f6a831")}</button></article>
  </div>;
}

function ProfilePreference({ name, checked, title, description }: { name: string; checked: boolean; title: string; description: string }) {
  return <label className="resident-preference flex cursor-pointer items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-0">
    <span><strong className="block text-[9px] text-slate-800">{title}</strong><small className="mt-1 block text-[8px] leading-4 text-slate-500">{description}</small></span>
    <input type="checkbox" name={name} defaultChecked={checked} className="resident-preference-input sr-only" />
    <span aria-hidden="true" className="resident-toggle shrink-0" />
  </label>;
}

function advisoryPublishMessage(
  publishedMessage: string,
  delivery: EmailDeliverySummary,
): string {
  if (delivery.status === "no_recipients") return `${publishedMessage} ${copy("emailDeliveryNoRecipients")}`.trim();
  if (delivery.status === "sent") {
    return `${publishedMessage} ${copy("emailDeliverySent").replace("{sent}", String(delivery.sent))}`.trim();
  }
  if (delivery.status === "partial") {
    return `${publishedMessage} ${copy("emailDeliveryPartial")
      .replace("{sent}", String(delivery.sent))
      .replace("{failed}", String(delivery.failed))}${delivery.errors[0] ? ` ${delivery.errors[0].message}` : ""}`.trim();
  }
  return `${publishedMessage} ${copy("emailDeliveryFailed")
    .replace("{failed}", String(delivery.failed))}${delivery.errors[0] ? ` ${delivery.errors[0].message}` : ""}`.trim();
}

function GmailConnection({ portal, token }: { portal: "cepalco" | "water"; token: string | null }) {
  const [connection, setConnection] = useState<{ connected: boolean; senderEmail: string | null; connectionError?: string | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void localAction<typeof connection>(portal, "/email/gmail/status", token).then(result => {
      if (active) setConnection(result);
    }).catch(err => {
      if (active) setError(err instanceof Error ? err.message : copy("gmailConnectionFailed"));
    });
    return () => { active = false; };
  }, [portal, token]);

  async function connect() {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const result = await localAction<{ authorizationUrl: string }>(portal, "/email/gmail/connect", token, {
        method: "POST",
        body: JSON.stringify({}),
      });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("gmailConnectionFailed"));
      setBusy(false);
    }
  }

  return <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span><strong className="block text-[9px] text-slate-800">{copy("gmailConnectionTitle")}</strong><small className="mt-1 block text-[8px] text-slate-500">{copy("gmailConnectionInfo")}</small></span>
      {connection?.connected
        ? <span className="text-[9px] font-semibold text-emerald-700">{copy("gmailConnected")} {connection.senderEmail}</span>
        : <button type="button" onClick={() => void connect()} disabled={busy || !token} className="rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-700 disabled:opacity-60">
            {busy ? copy("gmailConnecting") : copy("gmailConnect")}
          </button>}
    </div>
    {connection?.connected && <button type="button" onClick={() => void connect()} disabled={busy || !token} className="mt-2 rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-700 disabled:opacity-60">{busy ? copy("gmailConnecting") : copy("gmailReconnect")}</button>}
    {!connection?.connected && !error && <p className="mb-0 mt-2 text-[8px] text-slate-500">{connection?.connectionError || (connection ? copy("gmailNotConnected") : "Checking Gmail connection…")}</p>}
    {error && <p role="alert" className="mb-0 mt-2 text-[8px] text-rose-700">{error}</p>}
  </div>;
}

function SocialConnectionStatus({ portal, token }: { portal: "cepalco" | "water"; token: string | null }) {
  const [status, setStatus] = useState<{ facebook: boolean; instagram: boolean } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    let active = true;
    void localAction<{ facebook: boolean; instagram: boolean }>(portal, "/social/status", token)
      .then(result => { if (active) setStatus(result); })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : "Could not check social publishing setup."); });
    return () => { active = false; };
  }, [portal, token]);

  if (error) return <p role="alert" className="mb-0 text-xs text-rose-700">{error}</p>;
  if (!status) return <p className="mb-0 text-xs text-slate-500">Checking social publishing setup…</p>;
  return <p className="mb-0 text-xs text-slate-600">
    Facebook: <strong className={status.facebook ? "text-emerald-700" : "text-amber-700"}>{status.facebook ? "configured" : "server setup required"}</strong>
    {" · "}
    Instagram: <strong className={status.instagram ? "text-emerald-700" : "text-amber-700"}>{status.instagram ? "configured" : "server setup required"}</strong>
    {" · Meta checks token validity when publishing"}
  </p>;
}

function Overview({ portal, actor, advisories, workOrders, network, onNavigate, onAction }: { portal: Portal; actor: Actor; advisories: Advisory[]; workOrders: WorkOrder[]; network: NetworkReading[]; onNavigate: (page: string) => void; onAction: (modal: "advisory" | "work") => void }) {
  const water = portal === "water";
  const resident = portal === "resident";
  if (resident) return <ResidentOverview actor={actor} advisories={advisories} onNavigate={onNavigate} />;
  if (portal === "cepalco") return <CepalcoOverview advisories={advisories} workOrders={workOrders} onNavigate={onNavigate} onPublish={() => onNavigate("publish")} onCreateWork={() => onAction("work")} />;
  const averagePressure = network.length
    ? Math.round(network.reduce((sum, reading) => sum + reading.pressurePsi, 0) / network.length)
    : 0;
  const metrics = requiredSetting(settingsFor("water").metrics, "water.metrics").map(metric => {
    const value = metric.key === "activeAdvisories"
      ? String(advisories.length).padStart(2, "0")
      : metric.key === "averagePressure"
        ? `${averagePressure} PSI`
        : metric.key === "scheduledMaintenance"
          ? String(workOrders.length).padStart(2, "0")
          : metric.value ?? "—";
    return { ...metric, value };
  });
  return <div className={`space-y-4 ${water ? "water-overview" : ""}`}>
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">{metrics.map(metric => <article key={metric.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-4 grid h-9 w-9 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name={metric.icon} /></div><strong className="block text-2xl font-extrabold tracking-tight text-slate-900">{metric.value}</strong><span className="mt-1 block text-[10px] text-slate-500">{metric.label}</span></article>)}</section>
    <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_310px]">
      <div className="space-y-4">
        <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="m-0 text-base font-bold text-slate-900">{water ? copy("copy_76a36db7bf88") : resident ? "Local advisory feed" : "Active advisory feed"}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_10d5ea350e38")}</p></div><button onClick={() => onNavigate(resident ? "advisories" : "incidents")} className="text-xs font-bold text-[var(--brand)]">{copy("copy_9a780508debb")}</button></div><div className="space-y-2">{advisories.slice(0, 3).map(item => <DataCard key={item.id} item={item} page="incidents" compact />)}{advisories.length === 0 && <Empty message={copy("copy_3678435c18e9")} />}</div></article>
        <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="m-0 text-base font-bold text-slate-900">{water ? copy("copy_e9363430f378") : copy("copy_e036ecc020f2")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_90ceeef9cb18")}</p></div><button onClick={() => onNavigate("scheduled")} className="text-xs font-bold text-[var(--brand)]">{copy("copy_6b70d62b15bc")}</button></div><WorkTable items={workOrders.slice(0, 3)} /></article>
        {water && <PressureZones readings={network} />}
      </div>
      <div className="space-y-4">
        <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><h2 className="m-0 text-sm font-bold text-slate-900">{water ? copy("copy_928d553c98de") : copy("copy_ed4be26c08f6")}</h2><span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-800">{copy("copy_9001b9c1ea3e")}</span></div><div className="space-y-3 text-xs"><HealthLine icon={water ? "drop" : "pulse"} label={water ? copy("copy_7a4d86e0b15e") : copy("copy_db2147de64b9")} value={copy("copy_996bf57d15be")} /><HealthLine icon="pulse" label={water ? copy("copy_0e7cd2979907") : copy("copy_4c82d70632f5")} value={water ? `${Math.round(network.reduce((sum, reading) => sum + reading.pressurePsi, 0) / Math.max(1, network.length))} PSI` : copy("copy_a5f0bab62ab7")} /><HealthLine icon="shield" label={water ? copy("copy_04a3d80a1962") : copy("copy_1b9c0ef8f022")} value={water ? copy("copy_d8ce14bfa8c0") : copy("copy_c4ff20ed5c92")} /></div>{water && <div className="mt-4 border-t border-slate-100 pt-4"><div className="mb-2 flex justify-between text-[10px] text-slate-500"><span>{copy("copy_0e2cc5230bce")}</span><strong className="text-slate-800">{network[0]?.reservoirPercent ?? "—"}{copy("copy_bbf3f11cb5b4")}</strong></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><span className="progress-fill block h-full rounded-full" style={{ width: `${network[0]?.reservoirPercent ?? 0}%` }} /></div><p className="mb-0 mt-2 text-[9px] text-slate-400">{copy("copy_f088839faf2b")}</p></div>}</article>
        <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-3 flex items-center justify-between"><h2 className="m-0 text-sm font-bold text-slate-900">{water ? copy("copy_0183aa6e0b13") : copy("copy_48841e6cc7b0")}</h2><button onClick={() => onNavigate("restoration")} className="text-[10px] font-bold text-[var(--brand)]">{copy("copy_ea488d2693df")}</button></div><MiniMap water={water} /><div className="mt-3 flex gap-3 text-[9px] text-slate-500"><span>{copy("copy_a336ed94f116")}</span><span className="text-amber-700">{copy("copy_8ee132327af2")}</span></div></article>
        <article className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="mb-3 mt-0 text-sm font-bold text-slate-900">{copy("copy_1810407f5ab7")}</h2><div className="space-y-2">{!resident && <ActionButton icon="plus" label={water ? copy("copy_dd4c1e0f180b") : copy("copy_c48c20a1939c")} onClick={() => water ? onNavigate("publish") : onAction("advisory")} />}{!resident && <ActionButton icon="calendar" label={water ? copy("copy_264bf4916de8") : copy("copy_7edcd3387306")} onClick={() => onAction("work")} />}</div></article>
        {water && <p className="rounded-lg bg-amber-50 p-3 text-[10px] leading-5 text-amber-900"><strong>{copy("copy_99499f2400eb")}</strong> {copy("copy_fa187e246369")}</p>}
      </div>
    </section>
  </div>;
}

function CepalcoOverview({ advisories, workOrders, onNavigate, onPublish, onCreateWork }: { advisories: Advisory[]; workOrders: WorkOrder[]; onNavigate: (page: string) => void; onPublish: () => void; onCreateWork: () => void }) {
  const highlighted = advisories.find(item => item.status !== "Resolved") || advisories[0];
  const metrics = requiredSetting(settingsFor("cepalco").metrics, "cepalco.metrics").map(metric => ({
    ...metric,
    value: metric.key === "activeDisruptions"
      ? String(advisories.filter(item => item.status !== "Resolved").length).padStart(2, "0")
      : metric.key === "scheduledWorks"
        ? String(workOrders.length).padStart(2, "0")
        : metric.value,
  }));
  return <div className="cepalco-overview">
    <section className="cepalco-metrics grid grid-cols-2 gap-3 xl:grid-cols-4">{metrics.map(metric => <article key={metric.label} className="cepalco-card flex items-start justify-between gap-2 rounded-lg border bg-white p-3"><div><span className="cepalco-metric-icon"><Icon name={metric.icon} className="h-4 w-4" /></span><strong className="mt-1 block text-xl font-extrabold text-slate-900">{metric.value}</strong><span className="block text-[9px] text-slate-500">{metric.label}</span></div><span className="cepalco-pill">{metric.badge}</span></article>)}</section>
    <section className="cepalco-dashboard-grid mt-3 grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_290px]">
      <div className="space-y-3">
        <article className="cepalco-card overflow-hidden rounded-lg border bg-white p-3">
          <div className="mb-3 flex items-center justify-between"><div><h2 className="m-0 text-xs font-bold text-slate-900">{copy("copy_4b1c8eb88de9")}</h2><p className="mb-0 mt-1 text-[8px] text-slate-500">{copy("copy_10d5ea350e38")}</p></div><button onClick={() => onNavigate("incidents")} className="text-[8px] font-bold text-teal-800">{copy("copy_9a780508debb")}</button></div>
          {highlighted ? <CepalcoIncidentCard item={highlighted} compact /> : <Empty message={copy("copy_fa94df52f2b8")} />}
        </article>
        <article className="cepalco-card rounded-lg border bg-white p-3">
          <div className="mb-3 flex items-center justify-between"><div><h2 className="m-0 text-xs font-bold text-slate-900">{copy("copy_e036ecc020f2")}</h2><p className="mb-0 mt-1 text-[8px] text-slate-500">{copy("copy_90ceeef9cb18")}</p></div><button onClick={() => onNavigate("scheduled")} className="text-[8px] font-bold text-teal-800">{copy("copy_6b70d62b15bc")}</button></div>
          <CepalcoWorkTable items={workOrders.slice(0, 3)} />
        </article>
      </div>
      <div className="space-y-3">
        <article className="cepalco-card rounded-lg border bg-white p-3">
          <div className="mb-3 flex items-center justify-between"><h2 className="m-0 text-xs font-bold text-slate-900">{copy("copy_ed4be26c08f6")}</h2><span className="cepalco-pill good">{copy("copy_9001b9c1ea3e")}</span></div>
          <div className="space-y-2.5"><HealthLine icon="pulse" label={copy("copy_db2147de64b9")} value={copy("copy_996bf57d15be")} /><HealthLine icon="alert" label={copy("copy_4c82d70632f5")} value={copy("copy_a5f0bab62ab7")} /><HealthLine icon="people" label={copy("copy_1b9c0ef8f022")} value={copy("copy_c4ff20ed5c92")} /></div>
          <div className="mt-3 border-t border-slate-100 pt-3"><div className="flex justify-between text-[8px] text-slate-500"><span>{copy("copy_177611bdc242")}</span><strong className="text-slate-700">{copy("copy_40b25a13be05")}</strong></div><div className="mt-1 h-1.5 rounded-full bg-slate-100"><span className="block h-full w-[80%] rounded-full bg-teal-700" /></div></div>
        </article>
        <article className="cepalco-card rounded-lg border bg-white p-3">
          <div className="mb-2 flex items-center justify-between"><h2 className="m-0 text-xs font-bold text-slate-900">{copy("copy_48841e6cc7b0")}</h2><button onClick={() => onNavigate("restoration")} className="text-[8px] font-bold text-teal-800">{copy("copy_179fd0717ef9")}</button></div>
          <CepalcoMiniMap />
          <div className="mt-2 flex flex-wrap gap-3 text-[8px] text-slate-600"><span>{copy("copy_a336ed94f116")}</span><span className="text-amber-700">{copy("copy_8ee132327af2")}</span><span className="text-teal-800">{copy("copy_be3a7d07de78")}</span></div>
        </article>
        <article className="cepalco-card rounded-lg border bg-white p-3"><h2 className="mb-2 mt-0 text-xs font-bold text-slate-900">{copy("copy_1810407f5ab7")}</h2><div className="space-y-1.5"><ActionButton icon="plus" label={copy("copy_c48c20a1939c")} onClick={onPublish} /><ActionButton icon="calendar" label={copy("copy_7edcd3387306")} onClick={onCreateWork} /></div></article>
      </div>
    </section>
  </div>;
}

function CepalcoWorkTable({ items }: { items: WorkOrder[] }) {
  if (!items.length) return <Empty message={copy("copy_7fd74ce5eccf")} />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[430px] text-left"><thead><tr className="border-b border-slate-100 text-[7px] uppercase tracking-wide text-slate-400"><th className="px-2 py-2">{copy("copy_ce02285cc14e")}</th><th className="px-2 py-2">{copy("copy_024dc204d7ba")}</th><th className="px-2 py-2">{copy("copy_19734a1b58ca")}</th><th className="px-2 py-2">{copy("copy_920e413c7d41")}</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-b border-slate-50 text-[8px] text-slate-600 last:border-0"><td className="px-2 py-2.5"><strong className="block text-slate-800">{item.title}</strong><span className="text-[7px] text-slate-400">{item.reference}</span></td><td className="px-2 py-2.5">{item.area}</td><td className="px-2 py-2.5">{formatResidentDateTime(item.startsAt)}</td><td className="px-2 py-2.5"><span className="cepalco-pill good">{item.status}</span></td></tr>)}</tbody></table></div>;
}

function CepalcoIncidentCard({ item, compact = false, onStatusUpdate }: { item: Advisory; compact?: boolean; onStatusUpdate?: (item: Advisory) => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const statusStyle = item.status === "Resolved" ? "resolved" : item.status === "Under investigation" ? "investigating" : "dispatch";
  const imageUrl = announcementImageUrl(item, "cepalco");
  return <article className={`cepalco-incident-card ${compact ? "compact" : ""}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className={`cepalco-status ${statusStyle}`}>{item.publicationStatus === "scheduled" ? "Scheduled" : item.publicationStatus === "failed" ? "Publishing failed" : copy("copy_45f0c53899bc") + item.status}</span><span className="text-[8px] text-slate-400">{formatResidentDateTime(item.scheduledAt || item.createdAt)}</span></div>
    <h3 className="mb-1 mt-2 text-[12px] font-bold text-slate-900">{item.title}</h3>
    <p className="mb-2 text-[8px] text-slate-500">{item.reference} {copy("copy_71e8c6df1273")}{item.area}</p>
    {imageUrl ? <img src={imageUrl} alt={`Announcement: ${item.title}`} className="my-2 block max-h-56 w-full rounded-lg object-cover" /> : <div className="cepalco-scene" role="img" aria-label={copy("copy_71df1e7e4841")}><span className="scene-cloud" /><span className="scene-pole" /><span className="scene-wire wire-one" /><span className="scene-wire wire-two" /><span className="scene-bucket" /><span className="scene-worker worker-one" /><span className="scene-worker worker-two" /><span className="scene-road" /><span className="scene-caption">{copy("copy_806a713aa5b3")}</span></div>}
    <p className="mb-2 mt-2 text-[8px] leading-4 text-slate-600"><strong className="text-teal-800">{copy("copy_3f1e0db044b6")}</strong> {item.details}</p>
    <SocialPostLinks item={item} />
    {!compact && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[8px] text-slate-500"><span>{copy("copy_401411b3e7cd")}</span><span>{copy("copy_2d32246bb801")}</span><div className="flex gap-2"><button onClick={() => setDetailsOpen(!detailsOpen)} className="font-bold text-teal-800">{detailsOpen ? copy("copy_c9722a7a962a") : copy("copy_a6fee21d1c59")}</button>{onStatusUpdate && item.publicationStatus !== "scheduled" && item.publicationStatus !== "failed" && <button onClick={() => onStatusUpdate(item)} className="rounded border border-slate-200 px-2 py-1 font-semibold text-slate-700">{copy("copy_1e6bf669df09")}</button>}</div></div>}
    {detailsOpen && <p className="mb-0 mt-2 rounded bg-slate-50 p-2 text-[8px] text-slate-600">{copy("copy_f32ba55bfcd0")}{item.reference}{copy("copy_9f15c67f4e0c")}{item.status}{copy("copy_cdb4ee2aea69")}</p>}
  </article>;
}

function CepalcoDisruptions({ items, onStatusUpdate }: { items: Advisory[]; onStatusUpdate: (item: Advisory) => void }) {
  const [query, setQuery] = useState("");
  const incidentStatuses = requiredSetting(settingsFor("cepalco").filters?.incidentStatuses, "cepalco.filters.incidentStatuses");
  const [statusFilter, setStatusFilter] = useState(incidentStatuses[0]);
  const filtered = items.filter(item => `${item.title} ${item.area} ${item.reference} ${item.details}`.toLowerCase().includes(query.toLowerCase()) && (statusFilter === "All" || item.status === statusFilter));
  return <section className="cepalco-page-stack">
    <div className="cepalco-toolbar"><label className="cepalco-search"><Icon name="search" className="h-4 w-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("copy_7145ac5f783f")} /></label><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label={copy("copy_d96d73ecc01f")}><option>{copy("copy_a52ace420f21")}</option><option>{copy("copy_1dc83f605edf")}</option><option>{copy("copy_f9bdb11906ee")}</option><option>{copy("copy_8f62edb51e5f")}</option><option>{copy("copy_5be3c2c8354e")}</option></select></div>
    <div className="space-y-3">{filtered.map(item => <CepalcoIncidentCard key={item.id} item={item} onStatusUpdate={onStatusUpdate} />)}{!filtered.length && <Empty message={copy("copy_e5e64ce05143")} />}</div>
  </section>;
}

function AnnouncementComposer(props: {
  portal: "cepalco" | "water";
  busy: boolean;
  token: string | null;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (props.portal === "cepalco") {
    return <CepalcoPublishForm busy={props.busy} token={props.token} onCancel={props.onCancel} onSubmit={props.onSubmit} />;
  }
  return <GenericAnnouncementComposer {...props} />;
}

function GenericAnnouncementComposer({
  portal,
  busy,
  token,
  onCancel,
  onSubmit,
}: {
  portal: "cepalco" | "water";
  busy: boolean;
  token: string | null;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const categories = requiredSetting(settingsFor(portal).categories, `${portal}.categories`);
  const [selectedLocation, setSelectedLocation] = useState<CivicAlertMapLocation | null>(null);
  const [schedule, setSchedule] = useState(false);
  const utilityLabel = portal === "cepalco" ? "CEPALCO" : "Water District";
  const fieldClass = "mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-800";
  const labelClass = "block text-xs font-bold text-slate-700";
  return <form onSubmit={onSubmit} className="space-y-4">
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="mb-1 text-[9px] font-extrabold tracking-[.15em] text-[var(--brand)]">{utilityLabel} · ANNOUNCEMENT</p>
      <h2 className="mb-1 mt-0 text-lg font-bold text-slate-900">Create an announcement</h2>
      <p className="mb-0 text-xs text-slate-500">Add the report information and location, choose where to announce it, then publish now or schedule it.</p>
    </section>
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="m-0 text-sm font-bold text-slate-900">Announcement details</h3>
      <label className={labelClass}>Report category
        <select name="category" required className={fieldClass} defaultValue={categories[0]?.value}>
          {categories.map(category => <option key={category.value} value={category.value}>{category.value}</option>)}
        </select>
      </label>
      <label className={labelClass}>Title
        <input name="title" required maxLength={160} className={fieldClass} placeholder="Short, clear announcement title" />
      </label>
      <label className={labelClass}>Affected location
        <input name="area" required maxLength={160} className={fieldClass} placeholder="Barangay, street, zone, or service area" />
      </label>
      <label className={labelClass}>Report details
        <textarea name="details" required rows={5} maxLength={1800} className={fieldClass} placeholder="Describe what happened, who is affected, and any important instructions." />
      </label>
      <div>
        <p className="mb-2 text-xs font-bold text-slate-700">Pin the affected location (optional)</p>
        <input type="hidden" name="latitude" value={selectedLocation?.latitude ?? ""} />
        <input type="hidden" name="longitude" value={selectedLocation?.longitude ?? ""} />
        <GoogleMap mode="picker" height={270} label="Click the map to select a location" onLocationSelected={setSelectedLocation} />
        <p className="mb-0 mt-2 text-xs text-slate-500">{selectedLocation
          ? `Map pin: ${selectedLocation.latitude.toFixed(6)}, ${selectedLocation.longitude.toFixed(6)}`
          : "Select a point on the map to include coordinates with this announcement."}</p>
      </div>
      <label className={labelClass}>Announcement image (optional)
        <input type="file" name="announcementImage" accept="image/jpeg,image/png,image/webp" className={`${fieldClass} text-xs`} />
        <span className="mt-1 block text-[10px] font-normal text-slate-500">JPEG, PNG, or WebP, up to 1 MB. Required for Instagram.</span>
      </label>
    </section>
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="m-0 text-sm font-bold text-slate-900">Announcement channels</h3>
      <p className="m-0 text-xs text-slate-500">Facebook and Gmail are included with every announcement. Other channels are optional.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {([
          ["facebook", "Facebook", "Post every announcement to the utility Facebook page."],
          ["instagram", "Instagram", "Publish an image and caption to Instagram."],
          ["gmail", "Gmail", "Email every registered resident with the announcement image."],
          ["sms", "SMS (simulated)", "Add a simulated alert to opted-in residents' inboxes; no text message is sent."],
        ] as const).map(([value, title, description]) => <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-xs">
          <input type="checkbox" name="channels" value={value} checked={isRequiredAnnouncementChannel(value)} disabled={isRequiredAnnouncementChannel(value)} className="mt-0.5 accent-[var(--brand)]" />
          <span><strong className="block text-slate-800">{title}</strong><small className="mt-1 block text-slate-500">{description}</small></span>
        </label>)}
      </div>
      <GmailConnection portal={portal} token={token} />
    </section>
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="m-0 text-sm font-bold text-slate-900">Publishing time</h3>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
        <input type="checkbox" checked={schedule} onChange={event => setSchedule(event.target.checked)} />
        Schedule this announcement for later
      </label>
      {schedule && <label className={labelClass}>Publish at
        <input name="scheduledAt" type="datetime-local" required min={minimumLocalDateTime()} className={fieldClass} />
      </label>}
      {!schedule && <input type="hidden" name="scheduledAt" value="" />}
    </section>
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600">Cancel</button>
      <button type="submit" disabled={busy} className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-60">{busy ? "Saving…" : schedule ? "Schedule announcement" : "Publish announcement"}</button>
    </div>
  </form>;
}

function minimumLocalDateTime(): string {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function CepalcoPublishForm({ busy, token, onCancel, onSubmit }: { busy: boolean; token: string | null; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const categories = requiredSetting(settingsFor("cepalco").categories, "cepalco.categories");
  const priorities = requiredSetting(settingsFor("cepalco").priorities, "cepalco.priorities");
  const [category, setCategory] = useState(() => readPortalDraftValue("cepalco", "category") || categories[0]?.value || "");
  const [selectedLocation, setSelectedLocation] = useState<CivicAlertMapLocation | null>(null);
  const [channels, setChannels] = useState<string[]>(() => {
    const draft = readPortalDraftChannels("cepalco");
    return draft.length > 0 ? draft : [...DEFAULT_ANNOUNCEMENT_CHANNELS];
  });
  const [schedule, setSchedule] = useState(() => readPortalDraftValue("cepalco", "schedule") === "true");
  const [draftSaved, setDraftSaved] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [detailsLength, setDetailsLength] = useState(() => readPortalDraftValue("cepalco", "details").length);
  useEffect(() => {
    if (!imagePreview) return;
    return () => URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);
  function saveDraft(form: HTMLFormElement | null) {
    if (!form) return;
    new FormData(form).forEach((value, name) => {
      if (value instanceof File || name === "channels") return;
      localStorage.setItem(`civicalert:cepalco:draft:${name}`, String(value));
    });
    localStorage.setItem("civicalert:cepalco:draft:category", category);
    localStorage.setItem("civicalert:cepalco:draft:schedule", String(schedule));
    localStorage.setItem("civicalert:cepalco:draft:channels", channels.join("|"));
    setDraftSaved(true);
  }
  function toggleChannel(channel: string) {
    if (isRequiredAnnouncementChannel(channel)) return;
    setChannels(current => current.includes(channel)
      ? current.filter(value => value !== channel)
      : [...current, channel]);
    setDraftSaved(false);
  }
  return <form className="cepalco-publish-layout" onSubmit={onSubmit}>
    <div className="space-y-3">
      <section className="cepalco-form-card">
        <span className="cepalco-kicker">CEPALCO OPERATIONS / PUBLIC NOTICES</span>
        <h2>Publish service advisory</h2>
        <p>Write a clear service update, choose who receives it, then publish or schedule it.</p>
        <div className="cepalco-category-grid">{categories.map(({ value, description, icon }) => <button key={value} type="button" aria-pressed={category === value} onClick={() => { setCategory(value); setDraftSaved(false); }} className={`cepalco-category ${category === value ? "selected" : ""}`}><span>{icon}</span><strong>{value}</strong><small>{description}</small></button>)}</div>
        <input type="hidden" name="category" value={category} />
        <label className="cepalco-field"><span>Priority / severity</span><select name="priority" defaultValue={readPortalDraftValue("cepalco", "priority") || "High"} onChange={() => setDraftSaved(false)}>{priorities.map(priority => <option key={priority}>{priority}</option>)}</select></label>
      </section>
      <section className="cepalco-form-card">
        <h2>Headline and affected service area</h2>
        <p>Identify the issue and the neighborhoods or zones that may be affected.</p>
        <label className="cepalco-field"><span>Advisory headline</span><input name="title" required maxLength={160} defaultValue={readPortalDraftValue("cepalco", "title")} placeholder="Summarize the service update" onChange={() => setDraftSaved(false)} /></label>
        <label className="cepalco-field"><span>Affected zone or district</span><input name="area" required maxLength={160} defaultValue={readPortalDraftValue("cepalco", "area")} placeholder="District, barangay, or service area" onChange={() => setDraftSaved(false)} /></label>
      </section>
      <section className="cepalco-form-card">
        <h2>Service window</h2>
        <p>Add the expected start and restoration time when known.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="cepalco-field"><span>Advisory start</span><input name="serviceStartsAt" type="datetime-local" defaultValue={readPortalDraftValue("cepalco", "serviceStartsAt")} onChange={() => setDraftSaved(false)} /></label>
          <label className="cepalco-field"><span>Estimated restoration</span><input name="estimatedRestorationAt" type="datetime-local" defaultValue={readPortalDraftValue("cepalco", "estimatedRestorationAt")} onChange={() => setDraftSaved(false)} /></label>
        </div>
      </section>
      <section className="cepalco-form-card">
        <div className="mb-2 flex items-center justify-between gap-2"><div><h2>Public notice and safety guidance</h2><p className="mb-0">Describe the impact and any steps residents should take.</p></div><small className="text-xs font-semibold text-slate-500">{detailsLength} / 1800</small></div>
        <label className="cepalco-field"><span>Advisory details</span><textarea name="details" required rows={6} maxLength={1800} defaultValue={readPortalDraftValue("cepalco", "details")} placeholder="Explain what happened, who is affected, and any safety guidance." onChange={event => { setDetailsLength(event.target.value.length); setDraftSaved(false); }} /></label>
      </section>
      <section className="cepalco-form-card">
        <h2>Affected location</h2>
        <p>Optionally add a point on the map for residents to locate the advisory.</p>
        <input type="hidden" name="latitude" value={selectedLocation?.latitude ?? ""} />
        <input type="hidden" name="longitude" value={selectedLocation?.longitude ?? ""} />
        <GoogleMap mode="picker" height={250} label="Select affected service location" onLocationSelected={setSelectedLocation} />
        <p className="mb-0 mt-2 text-xs font-medium text-slate-600">{selectedLocation ? `Selected point: ${selectedLocation.latitude.toFixed(5)}, ${selectedLocation.longitude.toFixed(5)}` : "No map point selected. The advisory can still be published without one."}</p>
      </section>
      <section className="cepalco-form-card">
        <h2>Notice image</h2>
        <p>Add an image to include it with selected Facebook, Instagram, and Gmail delivery. Instagram always requires an image.</p>
        <label className="cepalco-field"><span>Image file</span><input type="file" name="announcementImage" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; setImagePreview(file ? URL.createObjectURL(file) : null); setDraftSaved(false); }} /><small>JPEG, PNG, or WebP, up to 15 MB. Automatically converted and optimized for Instagram.</small></label>
        {imagePreview && <img src={imagePreview} alt="Selected advisory image preview" className="cepalco-announcement-preview" />}
      </section>
      <section className="cepalco-form-card">
        <h2>Distribution channels</h2>
        <p>Facebook and Gmail are included with every announcement. Other channels are optional.</p>
        {([
          ["gmail", "Gmail", "Email every registered resident with the announcement image."],
          ["facebook", "Facebook", "Post every announcement to the connected CEPALCO page."],
          ["instagram", "Instagram", "Publish an image and caption to the connected account."],
          ["sms", "Resident inbox alert", "Create simulated inbox alerts; no text messages are sent."],
        ] as const).map(([value, title, description]) => <label className="cepalco-channel" key={value}>
          <input type="checkbox" name="channels" value={value} checked={isRequiredAnnouncementChannel(value) || channels.includes(value)} disabled={isRequiredAnnouncementChannel(value)} onChange={() => toggleChannel(value)} />
          <span><strong>{title}</strong><small>{description}</small></span>
        </label>)}
        <SocialConnectionStatus portal="cepalco" token={token} />
        <GmailConnection portal="cepalco" token={token} />
      </section>
      <section className="cepalco-form-card">
        <h2>Publishing time</h2>
        <label className="cepalco-channel"><input type="checkbox" checked={schedule} onChange={event => { setSchedule(event.target.checked); setDraftSaved(false); }} /><span><strong>Schedule this advisory</strong><small>Leave unchecked to publish as soon as you submit.</small></span></label>
        {schedule && <label className="cepalco-field">Publish date and time<input name="scheduledAt" type="datetime-local" required min={minimumLocalDateTime()} defaultValue={readPortalDraftValue("cepalco", "scheduledAt")} onChange={() => setDraftSaved(false)} /></label>}
        {!schedule && <input type="hidden" name="scheduledAt" value="" />}
      </section>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {draftSaved && <span role="status" className="mr-auto text-xs font-semibold text-teal-800">Draft saved in this browser.</span>}
        <button type="button" className="cepalco-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="cepalco-secondary" onClick={event => saveDraft(event.currentTarget.form)}>Save draft</button>
        <button type="submit" disabled={busy} className="cepalco-primary">{busy ? "Publishing…" : schedule ? "Schedule advisory" : "Publish advisory"}</button>
      </div>
    </div>
    <aside className="space-y-3"><div className="cepalco-form-card"><span className="cepalco-kicker">{copy("copy_88f75d3e34fd")}</span><h3>{category}</h3><p className="text-[9px] text-slate-500">The selected service category will identify the advisory in utility and resident feeds.</p><div className="cepalco-scene"><span className="scene-cloud" /><span className="scene-pole" /><span className="scene-wire wire-one" /><span className="scene-wire wire-two" /><span className="scene-bucket" /><span className="scene-worker worker-one" /><span className="scene-worker worker-two" /><span className="scene-road" /></div><p className="mb-0 mt-2 text-[8px] text-slate-500">Review the affected area and message before publishing.</p></div><div className="cepalco-form-card"><h2>Before publishing</h2><ul className="cepalco-checklist"><li>Confirm the affected location.</li><li>Include any known start or restoration time.</li><li>Choose only channels ready to receive this notice.</li></ul></div></aside>
  </form>;
}

function readPortalDraftValue(portal: "cepalco" | "water", name: string) {
  return localStorage.getItem(`civicalert:${portal}:draft:${name}`) || "";
}

function readPortalDraftChannels(portal: "cepalco" | "water"): string[] {
  return readPortalDraftValue(portal, "channels").split("|")
    .filter(channel => ["gmail", "facebook", "instagram", "sms"].includes(channel));
}

function CepalcoMiniMap() {
  const markers = requiredSetting(settingsFor("cepalco").maps?.mini, "cepalco.maps.mini");
  return <div className="cepalco-mini-map"><span className="mini-map-title">{copy("copy_30b0e513dacf")}</span>{markers.map(marker => <span key={marker.kind} className={`mini-map-pin pin-${marker.kind}`} style={{ left: `${marker.left}%`, top: `${marker.top}%` }} />)}</div>;
}

function CepalcoRestorationMap({ advisories }: { advisories: Advisory[] }) {
  const active = advisories.filter(item => item.status !== "Resolved");
  const settings = settingsFor("cepalco");
  const metrics = requiredSetting(settings.mapMetrics, "cepalco.mapMetrics");
  const minimumFieldCrews = Number(requiredSetting(settings.dashboard?.minimumFieldCrews, "cepalco.dashboard.minimumFieldCrews"));
  return <div className="cepalco-page-stack">
    <section className="cepalco-map-metrics grid grid-cols-2 gap-2 xl:grid-cols-4">{metrics.map(metric => <MapMetric key={metric.key} label={metric.label} value={metric.key === "activeOutage" ? String(active.length) : metric.key === "crewsInField" ? String(Math.max(active.length, minimumFieldCrews)) : metric.value || ""} detail={metric.key === "activeOutage" ? active[0]?.area || metric.detail : metric.detail} icon={metric.icon} />)}</section>
    <article className="cepalco-form-card"><div className="mb-3 flex items-center justify-between"><div><h2>{copy("copy_10811357280f")}</h2><p>{copy("copy_447c01316fb5")}</p></div><span className="cepalco-pill good">{copy("copy_b373fc245b9f")}</span></div><CepalcoLargeMap advisories={active} /><div className="mt-3 flex flex-wrap gap-4 text-[9px] text-slate-600"><span>{copy("copy_bbf0b0b5e5df")}</span><span className="text-amber-700">{copy("copy_8ee132327af2")}</span><span className="text-teal-800">{copy("copy_f30c5b09f4f0")}</span></div></article>
    <section><div className="mb-2 flex items-center justify-between"><div><h2 className="m-0 text-sm font-bold text-slate-900">{copy("copy_bdbeadd93387")}</h2><p className="mb-0 mt-1 text-[9px] text-slate-500">{copy("copy_bee37faf7a58")}</p></div></div><div className="space-y-2">{active.slice(0, 3).map(item => <CepalcoIncidentCard key={item.id} item={item} compact />)}{!active.length && <Empty message={copy("copy_375022a22378")} />}</div></section>
  </div>;
}

function CepalcoLargeMap({ advisories }: { advisories: Advisory[] }) {
  // UPDATED: Replaced mock SVG lines and simulated pins with saved Google Maps locations.
  return <GoogleMap mode="display" announcements={mapAnnouncements(advisories)} height={360} label="Active utility advisory locations" />;
}

function MapMetric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: string }) {
  return <article className="cepalco-map-metric"><span className="cepalco-metric-icon"><Icon name={icon} className="h-4 w-4" /></span><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function CepalcoSchedule({ workOrders, onCreate }: { workOrders: WorkOrder[]; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const workStatusFilters = requiredSetting(settingsFor("cepalco").filters?.workStatuses, "cepalco.filters.workStatuses");
  const scheduleMetrics = requiredSetting(settingsFor("cepalco").scheduleMetrics, "cepalco.scheduleMetrics");
  const [filter, setFilter] = useState(workStatusFilters[0]);
  const [calendarMode, setCalendarMode] = useState(false);
  const filtered = workOrders.filter(item => `${item.title} ${item.area} ${item.reference}`.toLowerCase().includes(query.toLowerCase()) && (filter === "All scheduled" || item.status === filter));
  return <div className="cepalco-schedule-layout">
    <div className="space-y-3">
      <section className="cepalco-schedule-banner"><div className="flex flex-wrap items-start justify-between gap-3"><div><span className="cepalco-kicker">{copy("copy_51317d45483f")}</span><h2>{copy("copy_c57ce600b1f3")}</h2><p>{copy("copy_1c84971559bc")}</p></div><div className="flex gap-2"><button aria-pressed={!calendarMode} onClick={() => setCalendarMode(false)} className={`cepalco-secondary ${!calendarMode ? "selected" : ""}`}>{copy("copy_5d8c3e1b635e")}</button><button aria-pressed={calendarMode} onClick={() => setCalendarMode(true)} className={`cepalco-secondary ${calendarMode ? "selected" : ""}`}>{copy("copy_d5d0a30b517e")}</button><button onClick={onCreate} className="cepalco-primary"><Icon name="plus" className="h-4 w-4" />{copy("copy_7edcd3387306")}</button></div></div></section>
      <section className="grid grid-cols-2 gap-2 xl:grid-cols-4">{scheduleMetrics.map(metric => <MapMetric key={metric.key} label={metric.label} value={metric.key === "scheduledThisWeek" ? `${workOrders.length} ${metric.value}` : metric.value} detail={metric.key === "scheduledThisWeek" ? `${workOrders.length} ${metric.detail}` : metric.detail} icon={metric.icon} />)}</section>
      <section className="cepalco-schedule-tools"><label className="cepalco-search"><Icon name="search" className="h-4 w-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("copy_91467d8b4efb")} /></label><div className="flex flex-wrap gap-1.5">{workStatusFilters.map(value => <button key={value} onClick={() => setFilter(value)} className={`cepalco-chip ${filter === value ? "active" : ""}`}>{value}</button>)}</div></section>
      {calendarMode ? <CepalcoWeekCalendar workOrders={filtered} /> : <div className="space-y-2">{filtered.map(item => <CepalcoWorkOrderCard key={item.id} item={item} />)}{!filtered.length && <Empty message={copy("copy_ce2e86d4a3a6")} />}</div>}
    </div>
    <aside className="space-y-3"><article className="cepalco-form-card"><h2>{copy("copy_70558b6c66f3")}</h2><p>{copy("copy_de0ab18c81de")}</p>{workOrders.slice(0, 4).map(item => <div key={item.id} className="cepalco-timeline-item"><span className="timeline-date">{new Date(item.startsAt).toLocaleDateString("en-PH", { day: "2-digit" })}</span><span><strong>{item.title}</strong><small>{item.area}</small></span><b>{copy("copy_d1a1b98335bb")}</b></div>)}</article><article className="cepalco-form-card"><h2>{copy("copy_64aaec8194af")}</h2><p>{copy("copy_42bc456a30be")}</p><button onClick={onCreate} className="cepalco-secondary w-full">{copy("copy_1232396a55b8")}</button></article><article className="cepalco-form-card"><h2>{copy("copy_9332dd54b569")}</h2><CepalcoMiniMap /></article></aside>
  </div>;
}

function CepalcoWorkOrderCard({ item }: { item: WorkOrder }) {
  const [showPacket, setShowPacket] = useState(false);
  return <article className="cepalco-work-card"><div className="flex flex-wrap items-start justify-between gap-2"><span className="cepalco-status resolved">{item.reference} {copy("copy_6e01f78b9eb4")}{item.status}</span><span className="text-[8px] text-slate-400">{copy("copy_da49d5d4750d")}</span></div><h3>{item.title}</h3><p>{item.area}</p><div className="grid gap-2 sm:grid-cols-3"><ScheduleDetail label={copy("copy_049c17e187d2")} value={`${formatResidentDateTime(item.startsAt)} — ${formatResidentDateTime(item.endsAt)}`} /><ScheduleDetail label={copy("copy_0969fb5e5928")} value={copy("copy_1c4753b85d42")} /><ScheduleDetail label={copy("copy_a702947cfde1")} value={copy("copy_50c03d261320")} /></div><div className="mt-3 flex flex-wrap gap-2"><button onClick={() => setShowPacket(!showPacket)} className="cepalco-secondary">{showPacket ? copy("copy_95275efd310a") : copy("copy_d88a112e8b2e")}</button></div>{showPacket && <div className="cepalco-work-packet"><strong>{copy("copy_2b46b261ae81")}{item.reference}</strong><span>{item.title} {copy("copy_6e01f78b9eb4")}{item.area}</span><span>{formatResidentDateTime(item.startsAt)} {copy("copy_cfcd41ea5383")}{formatResidentDateTime(item.endsAt)}</span><span>{copy("copy_4889951f6134")}{item.status}</span></div>}</article>;
}

function CepalcoWeekCalendar({ workOrders }: { workOrders: WorkOrder[] }) {
  const today = new Date();
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, index) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index));
  const dateRange = `${new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric" }).format(days[0])}–${new Intl.DateTimeFormat("en-PH", { day: "numeric" }).format(days[6])}`;
  return <section className="cepalco-week-calendar"><h3>{dateRange}</h3><div className="cepalco-week-grid">{days.map(day => {
    const matches = workOrders.filter(item => new Date(item.startsAt).toDateString() === day.toDateString());
    return <article key={day.toISOString()}><strong>{day.toLocaleDateString("en-PH", { weekday: "short" })}</strong><span>{day.getDate()}</span>{matches.map(item => <small key={item.id}>{item.title}</small>)}</article>;
  })}</div>{!workOrders.length && <p>{copy("copy_d8a75789ae7a")}</p>}</section>;
}

function ScheduleDetail({ label, value }: { label: string; value: string }) {
  return <div className="cepalco-schedule-detail"><small>{label}</small><strong>{value}</strong></div>;
}

function ResidentOverview({ actor, advisories, onNavigate }: { actor: Actor; advisories: Advisory[]; onNavigate: (page: string) => void }) {
  const activeCount = advisories.filter(item => item.status !== "Resolved").length;
  const dashboard = requiredSetting(settingsFor("resident").dashboard, "resident.dashboard");
  const metrics = requiredSetting(settingsFor("resident").metrics, "resident.metrics").map(metric => ({
    ...metric,
    value: metric.key === "activeAdvisories"
      ? String(activeCount).padStart(2, "0")
      : metric.key === "connectedServices"
        ? String(requiredSetting(dashboard.connectedServices, "resident.dashboard.connectedServices"))
        : metric.value,
  }));
  return <div className="resident-workspace space-y-6">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {metrics.map(metric => <article key={metric.key} className="resident-metric-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name={metric.icon} /></span>{metric.badge && (metric.key !== "activeAdvisories" || activeCount > 0) && <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${metric.key === "activeAdvisories" ? "border-rose-200 bg-rose-50 font-bold text-rose-700" : metric.key === "updateFrequency" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500"}`}>{metric.badge}</span>}</div><strong className="mt-4 block text-3xl font-extrabold tracking-tight text-slate-900">{metric.value}</strong><span className="mt-1 block text-xs font-medium text-slate-500">{metric.label}</span></article>)}
    </section>
    <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <article className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_90815a5d5f32")}</h2><p className="mb-0 mt-1 text-xs text-slate-500">{copy("copy_e71ce3f31ff3")}</p></div><button onClick={() => onNavigate("advisories")} className="text-xs font-bold text-[var(--brand)] hover:underline">{copy("copy_63dff5d5a6f2")}</button></div>
        <div className="space-y-4">{advisories.slice(0, 3).map(item => <ResidentAdvisoryCard key={item.id} item={item} compact />)}{advisories.length === 0 && <Empty message={copy("copy_a97e0906b67f")} />}</div>
      </article>
      <div className="space-y-5">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-3 flex items-center justify-between"><h2 className="m-0 text-sm font-bold text-slate-900">{copy("copy_4861614144e2")}</h2><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800">{copy("copy_b5917cae2e50")}</span></div><ResidentCommunityMap /><div className="mt-3 flex gap-2 text-xs text-slate-500"><span>{copy("copy_a6264e51595e")}</span><span className="font-semibold text-amber-700">{copy("copy_1625df60e00b")}</span></div><p className="mb-0 mt-2 text-xs text-slate-500">{copy("copy_ad386e3eb489")}{actor.barangay || "your registered service area"}{copy("copy_cdb4ee2aea69")}</p></article>
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="mb-4 mt-0 text-sm font-bold text-slate-900">{copy("copy_7ad5d50411ba")}</h2><div className="space-y-3"><HealthLine icon="pulse" label={copy("copy_43889238bb6e")} value={advisories.some(item => item.utility === "CEPALCO" && item.status !== "Resolved") ? copy("copy_c1dd64b75680") : copy("copy_996bf57d15be")} /><HealthLine icon="drop" label={copy("copy_b978536dddbb")} value={advisories.some(item => item.utility === "Water District" && item.status !== "Resolved") ? copy("copy_c1dd64b75680") : copy("copy_996bf57d15be")} /></div><button onClick={() => onNavigate("services")} className="mt-4 text-xs font-bold text-[var(--brand)] hover:underline">{copy("copy_bcc07a11eab9")}</button></article>
      </div>
    </section>
  </div>;
}

function ResidentAdvisories({ items, workOrders }: { items: Advisory[]; workOrders: WorkOrder[] }) {
  const filterSettings = requiredSetting(settingsFor("resident").filters, "resident.filters");
  const utilityOptions = requiredSetting(filterSettings.utilities, "resident.filters.utilities");
  const statusOptions = requiredSetting(filterSettings.advisoryStatuses, "resident.filters.advisoryStatuses");
  const quickFilters = requiredSetting(filterSettings.quickFilters, "resident.filters.quickFilters");
  const [query, setQuery] = useState("");
  const [utility, setUtility] = useState(utilityOptions[0]);
  const [status, setStatus] = useState(statusOptions[0]);
  const filtered = items.filter(item => {
    const matchesQuery = `${item.title} ${item.area} ${item.reference} ${item.details}`.toLowerCase().includes(query.toLowerCase());
    const matchesUtility = utility === "All" || item.utility === utility;
    const matchesStatus = status === "All" || item.status === status;
    return matchesQuery && matchesUtility && matchesStatus;
  });
  const filteredWorkOrders = workOrders.filter(item => {
    const matchesQuery = `${item.title} ${item.area} ${item.reference} ${item.status}`.toLowerCase().includes(query.toLowerCase());
    const matchesUtility = utility === "All" || item.utility === utility;
    const matchesStatus = status === "All" || status === "Scheduled" || status === item.status;
    return matchesQuery && matchesUtility && matchesStatus;
  });
  const filterClass = "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors";
  return <section className="resident-workspace space-y-5">
    <div className="resident-advisory-tools rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3"><label className="flex min-w-[240px] flex-1 items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-slate-400 focus-within:border-[var(--brand)] focus-within:bg-white"><Icon name="search" className="h-4 w-4" /><input value={query} onChange={event => setQuery(event.target.value)} className="w-full border-0 bg-transparent text-xs text-slate-800 outline-none" placeholder={copy("copy_41d242d68aa1")} /></label><select aria-label={copy("copy_1a31145d7148")} value={utility} onChange={event => setUtility(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-medium text-slate-700 outline-none focus:border-[var(--brand)]">{utilityOptions.map(option => <option key={option}>{option}</option>)}</select><select aria-label={copy("copy_94d5a7703a82")} value={status} onChange={event => setStatus(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-medium text-slate-700 outline-none focus:border-[var(--brand)]">{statusOptions.map(option => <option key={option}>{option}</option>)}</select></div>
      <div className="mt-3.5 flex flex-wrap items-center gap-2"><span className="mr-1 text-xs font-medium text-slate-500">{copy("copy_e1146f006ab3")}</span>{quickFilters.map(option => <button key={option} onClick={() => utilityOptions.includes(option) ? (setUtility(option), setStatus("All")) : (setStatus(option), setUtility("All"))} className={`${filterClass} ${utility === option || status === option || (option === "All" && utility === "All" && status === "All") ? "border-[#64234f] bg-[#64234f] text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>{option}</button>)}</div>
    </div>
    {/* ADDED: Residents can see mapped locations for advisories that include coordinates. */}
    <article className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
      <h2 className="mb-1 mt-0 text-base font-bold text-slate-900">Announcement locations</h2>
      <p className="mb-4 mt-0 text-xs text-slate-500">Select a marker to see its utility, affected area, and status.</p>
      <GoogleMap mode="display" announcements={mapAnnouncements(filtered)} height={320} label="Filtered utility announcements" />
    </article>
    <div className="grid gap-4 xl:grid-cols-2">{filtered.map(item => <ResidentAdvisoryCard key={`advisory-${item.id}`} item={item} />)}{filteredWorkOrders.map(item => <ResidentWorkCard key={`work-${item.id}`} item={item} />)}{filtered.length + filteredWorkOrders.length === 0 && <div className="col-span-full rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">{copy("copy_2559f73c5e19")}</div>}</div>
  </section>;
}

function ResidentWorkCard({ item }: { item: WorkOrder }) {
  const startsAt = formatResidentDateTime(item.startsAt);
  const endsAt = formatResidentDateTime(item.endsAt);
  return <article className="resident-advisory-card overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm p-4 border-l-4 border-l-violet-500">
    <div className="flex items-center justify-between gap-2 px-3 pt-2"><span className="rounded-full bg-violet-50 border border-violet-200 px-2.5 py-0.5 text-xs font-bold text-violet-800">{item.status}</span><span className="text-xs font-medium text-slate-400">{startsAt}</span></div>
    <div className="px-3 pt-2.5"><p className="mb-1 text-xs font-semibold text-slate-500">{item.utility} {copy("copy_585642cfbba4")}</p><h3 className="m-0 text-sm font-bold leading-snug text-slate-900">{item.title}</h3><p className="mb-2 mt-1 text-xs text-slate-500">{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p></div>
    <div className="px-3 pb-3 pt-1"><p className="mb-2 text-xs leading-5 text-slate-600">{copy("copy_cbb05f812c4f")}{startsAt} {copy("copy_4b00b1b86bfd")}{endsAt}{copy("copy_cdb4ee2aea69")}</p><div className="border-t border-slate-100 pt-2 text-xs font-semibold text-slate-600">{copy("copy_e0f3fde9df0e")}{item.utility}</div></div>
  </article>;
}

function formatResidentDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function ResidentAdvisoryCard({ item, compact = false }: { item: Advisory; compact?: boolean }) {
  const water = item.utility === "Water District";
  const imageUrl = announcementImageUrl(item, "resident");
  const dateLabel = formatResidentDateTime(item.createdAt);
  const statusTone = item.status === "Resolved" ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : item.status === "Under investigation" ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-rose-50 text-rose-800 border border-rose-200";
  const statusBorder = item.status === "Resolved" ? "border-l-4 border-l-emerald-500" : item.status === "Under investigation" ? "border-l-4 border-l-amber-500" : "border-l-4 border-l-rose-500";
  return <article className={`resident-advisory-card overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${compact ? "" : `${statusBorder} p-4`}`}>
    <div className="flex items-center justify-between gap-2 px-4 pt-3.5"><span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${statusTone}`}>{item.status}</span><span className="text-xs font-medium text-slate-400">{dateLabel}</span></div>
    <div className="px-4 pt-2.5"><p className="mb-1 text-xs font-semibold text-slate-500">{item.utility} {copy("copy_6e01f78b9eb4")}{item.type}</p><h3 className="m-0 text-sm font-bold leading-snug text-slate-900">{item.title}</h3><p className="mb-2 mt-1 text-xs text-slate-500">{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p></div>
    {imageUrl ? <img src={imageUrl} alt={`Announcement: ${item.title}`} className="my-2 block max-h-64 w-full rounded-lg object-cover" /> : compact && <div className={`resident-advisory-visual ${water ? "water" : "power"} compact my-2`} role="img" aria-label={`${water ? "Water utility" : "Electric utility"} service update illustration`}><span className="visual-sun" /><span className="visual-hill visual-hill-back" /><span className="visual-hill visual-hill-front" /><span className="visual-grid-line" /><span className="visual-scene-label">{water ? copy("copy_004a5691e71d") : copy("copy_e910d7acceb6")}</span></div>}
    <div className="px-4 pb-4 pt-1"><p className="mb-2.5 text-xs leading-5 text-slate-600">{item.details}</p>{water && (item.serviceStartsAt || item.estimatedRestorationAt) && <p className="mb-2.5 text-xs leading-5 text-slate-600">{item.serviceStartsAt && <>Service begins {formatResidentDateTime(item.serviceStartsAt)}</>}{item.serviceStartsAt && item.estimatedRestorationAt && " · "}{item.estimatedRestorationAt && <>Estimated restoration {formatResidentDateTime(item.estimatedRestorationAt)}</>}</p>}<SocialPostLinks item={item} /><div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs"><span className="font-semibold text-slate-600">{copy("copy_e0f3fde9df0e")}{item.utility}</span><span className="font-bold text-[var(--brand)]">{item.status === "Resolved" ? copy("copy_5ec2be90fc02") : item.status === "Crew dispatched" ? "Crew responding" : "Ongoing check"}</span></div></div>
  </article>;
}

function SocialPostLinks({ item }: { item: Advisory }) {
  const links = [
    ["Facebook", item.facebookUrl],
    ["Instagram", item.instagramUrl],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]) && entry[1]!.startsWith("https://"));
  if (!links.length) return null;
  return <nav aria-label="Social media posts" className="mb-2.5 flex flex-wrap gap-2 text-xs font-semibold">
    {links.map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700 hover:border-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand)] transition-colors">{`View ${label} post`}</a>)}
  </nav>;
}

function HealthLine({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="flex items-center justify-between border-b border-slate-100 pb-3 last:border-0 last:pb-0"><span className="flex items-center gap-2 text-slate-600"><Icon name={icon} className="h-4 w-4 text-[var(--brand)]" />{label}</span><strong className="text-[10px] text-slate-800">{value}</strong></div>;
}

function MiniMap({ water }: { water: boolean }) {
  const portal: Portal = water ? "water" : "resident";
  const settings = settingsFor(portal);
  const markers = requiredSetting(settings.maps?.mini, `${portal}.maps.mini`);
  const label = requiredSetting(settings.mapLabels?.mini, `${portal}.mapLabels.mini`);
  return <div className={`relative h-32 overflow-hidden rounded-lg bg-gradient-to-br from-[#d8e9e6] via-[#eef2ea] to-[#d9e7ee] ${water ? "water-mini-map" : ""}`}><span className="absolute left-3 top-3 text-[8px] font-extrabold tracking-wide text-slate-600">{label}</span>{markers.map((marker, index) => <span key={`${marker.kind}-${index}`} className={`map-pin ${marker.kind} absolute h-5 w-5 rounded-full border-4 border-white bg-rose-700 shadow-md`} style={{ left: `${marker.left}%`, top: `${marker.top}%` }} />)}</div>;
}

function ResidentCommunityMap() {
  const settings = settingsFor("resident");
  const markers = requiredSetting(settings.maps?.community, "resident.maps.community");
  const label = requiredSetting(settings.mapLabels?.community, "resident.mapLabels.community");
  return <div className="resident-community-map relative h-32 overflow-hidden rounded-lg"><span className="absolute left-3 top-3 text-[8px] font-extrabold tracking-wide text-slate-600">{label}</span>{markers.map((marker, index) => <span key={`${marker.kind}-${index}`} className={`resident-map-pin ${marker.kind} absolute`} style={{ left: `${marker.left}%`, top: `${marker.top}%` }} />)}</div>;
}

function PressureZones({ readings }: { readings: NetworkReading[] }) {
  const networkStatus = requiredSetting(settingsFor("water").networkStatus, "water.networkStatus");
  return <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_befbc9c07735")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_ba677c4a34ce")}</p></div>{readings.length ? <div className="divide-y divide-slate-100">{readings.map(reading => { const status = reading.pressurePsi < networkStatus.pressureWatchThresholdPsi ? networkStatus.watch : networkStatus.normal; return <div key={reading.district} className="grid grid-cols-[1fr_52px_auto] items-center gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1.1fr_1fr_52px_auto]"><span><strong className="block text-[11px] text-slate-800">{reading.district}</strong><small className="text-[9px] text-slate-500">{reading.area}</small></span><span className="hidden h-1.5 overflow-hidden rounded-full bg-slate-100 sm:block"><i className={`block h-full rounded-full ${status === networkStatus.watch ? "bg-amber-500" : "bg-cyan-600"}`} style={{ width: `${Math.min(100, reading.pressurePsi * 2)}%` }} /></span><strong className="text-[10px] text-slate-800">{reading.pressurePsi} {copy("copy_4533cd03a204")}</strong><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${status === networkStatus.watch ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>{status}</span></div>; })}</div> : <Empty message={copy("copy_e7c9027da829")} />}</article>;
}

function ActionButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-left text-[10px] font-semibold text-slate-700 hover:border-[var(--brand)] hover:bg-[var(--brand-soft)]"><span className="text-[var(--brand)]"><Icon name={icon} className="h-4 w-4" /></span>{label}</button>;
}

function Empty({ message }: { message: string }) {
  return <div className="rounded-lg bg-slate-50 p-6 text-center text-xs text-slate-500">{message}</div>;
}

function DataCard({ item, page, compact = false }: { item: Advisory | WorkOrder | ServiceReport; page: string; compact?: boolean }) {
  const isWork = "startsAt" in item;
  const status = item.status;
  return <article data-search-item className={`rounded-xl border border-slate-200 bg-white ${compact ? "p-3" : "p-4"} ${status === "Under investigation" ? "border-l-2 border-l-amber-500" : ""}`}>
    <div className="flex items-start justify-between gap-2"><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${status === "Resolved" ? "bg-emerald-50 text-emerald-800" : status === "Under investigation" ? "bg-amber-50 text-amber-800" : "bg-[var(--brand-soft)] text-[var(--brand)]"}`}>{isWork ? item.status : (item as Advisory | ServiceReport).status}</span><span className="text-[9px] text-slate-400">{isWork ? item.startsAt : formatResidentDateTime((item as Advisory).scheduledAt || (item as Advisory | ServiceReport).createdAt)}</span></div>
    <h3 className="mb-1 mt-2 text-sm font-bold text-slate-900">{item.title}</h3><p className="mb-2 text-[10px] text-slate-500">{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p>
    {!compact && <div className="flex flex-wrap gap-2 text-[9px] text-slate-500"><span>{item.utility}</span>{!isWork && "details" in item && <span>{copy("copy_6e01f78b9eb4")}{item.details}</span>}{isWork && <span>{copy("copy_d33b48f8d23c")}{item.endsAt}</span>}</div>}
    {page === "residents" && <button className="mt-2 text-[10px] font-bold text-[var(--brand)]">{copy("copy_029ff7cd00e9")}</button>}
  </article>;
}

function WaterAdvisories({ items }: { items: Advisory[] }) {
  const [query, setQuery] = useState("");
  const [featuredOpen, setFeaturedOpen] = useState(false);
  const filtered = items.filter(item => `${item.title} ${item.area} ${item.reference} ${item.details}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="water-page water-advisories">
    <label className="water-search"><Icon name="search" className="h-4 w-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("copy_7145ac5f783f")} /></label>
    <article className="water-featured">
      <div><span>{copy("copy_827ea98e475e")}</span><p>{copy("copy_39b70c211aad")}</p></div>
      <button type="button" onClick={() => setFeaturedOpen(!featuredOpen)}>{featuredOpen ? copy("copy_e0ea6e4875f8") : copy("copy_774a3a596063")}</button>
      {featuredOpen && <p className="water-featured-details">{copy("copy_917ffee3fc75")}</p>}
    </article>
    <div className="water-advisory-grid">
      {filtered.map(item => <WaterAdvisoryCard key={item.id} item={item} />)}
      {filtered.length === 0 && <div className="water-empty">{copy("copy_b371347d3915")}</div>}
    </div>
  </section>;
}

function WaterAdvisoryCard({ item }: { item: Advisory }) {
  const [expanded, setExpanded] = useState(false);
  const resolved = item.status === "Resolved";
  const imageUrl = announcementImageUrl(item, "water");
  return <article className={`water-advisory-card ${resolved ? "resolved" : "investigating"}`}>
    <div className="water-card-meta"><span className={`water-status ${resolved ? "resolved" : "investigating"}`}>{item.publicationStatus === "scheduled" ? "Scheduled" : item.publicationStatus === "failed" ? "Publishing failed" : item.status}</span><span className="water-priority">{item.priority || "Normal"} priority</span><time>{formatResidentDateTime(item.scheduledAt || item.createdAt)}</time></div>
    <h2>{item.title}</h2>
    <p className="water-card-ref">{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p>
    {imageUrl && <img src={imageUrl} alt={`Announcement: ${item.title}`} className="mb-3 block max-h-56 w-full rounded-lg object-cover" />}
    {(item.serviceStartsAt || item.estimatedRestorationAt) && <p className="water-card-window">{item.serviceStartsAt && <>Service begins {formatResidentDateTime(item.serviceStartsAt)}</>}{item.serviceStartsAt && item.estimatedRestorationAt && " · "}{item.estimatedRestorationAt && <>Estimated restoration {formatResidentDateTime(item.estimatedRestorationAt)}</>}</p>}
    <p className="water-card-copy">{copy("copy_617e0ed75f3b")}{item.details}</p>
    <SocialPostLinks item={item} />
    <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? copy("copy_e0ea6e4875f8") : copy("copy_774a3a596063")}</button>
    {expanded && <p className="water-card-detail"><strong>{item.type}</strong>{item.priority && <> · {item.priority} priority</>}<br />{item.details}</p>}
  </article>;
}

function WaterReports({ reports, onStatusUpdate }: { reports: ServiceReport[]; onStatusUpdate: (report: ServiceReport) => void }) {
  return <section className="water-page water-reports">
    {reports.map((report, index) => <article className="water-report-card" key={report.id}>
      <div className="water-report-content">
        <div className="water-card-meta"><span className={`water-status ${report.status === "Resolved" ? "resolved" : report.status === "Crew dispatched" ? "dispatched" : "received"}`}>{report.status}</span><span className="water-estimate">{copy("copy_28d364006cf4")}</span><time>{formatResidentDateTime(report.createdAt)}</time></div>
        <h2>{report.title}</h2>
        <p className="water-card-ref">{report.reference} {copy("copy_6e01f78b9eb4")}{report.area}</p>
        <p className="water-card-copy">{report.details || (index === 0 ? "Scope: inspection and pressure-zone assessment." : "Water District · Service report submitted by a resident.")}</p>
        <button type="button" onClick={() => onStatusUpdate(report)}>{report.status === "Resolved" ? copy("copy_3d28239a59cc") : copy("copy_029ff7cd00e9")}</button>
      </div>
      {index === 1 && <div className="water-report-photo" role="img" aria-label={copy("copy_73dc08521006")}><span>{copy("copy_0dc01c942b5c")}</span></div>}
    </article>)}
    {reports.length === 0 && <div className="water-empty">{copy("copy_e082c3906119")}</div>}
  </section>;
}

function WaterSchedule({ items, onCreate }: { items: WorkOrder[]; onCreate: () => void }) {
  const [calendarView, setCalendarView] = useState(false);
  const waterItems = items.filter(item => item.utility === "Water District");
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setDate(day.getDate() + index);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    return { day, key, items: waterItems.filter(item => item.startsAt.slice(0, 10) === key) };
  });
  return <section className="water-page water-schedule">
    <div className="water-schedule-toolbar"><div><strong>{copy("copy_c57ce600b1f3")}</strong><p>{copy("copy_e226a658abd5")}</p></div><div><button className={!calendarView ? "selected" : ""} onClick={() => setCalendarView(false)}>{copy("copy_5d8c3e1b635e")}</button><button className={calendarView ? "selected" : ""} onClick={() => setCalendarView(true)}>{copy("copy_d5d0a30b517e")}</button><button className="water-primary" onClick={onCreate}>{copy("copy_3d6077b94385")}</button></div></div>
    {calendarView ? <div className="water-week-grid">{days.map(({ day, items: scheduled }) => <article key={day.toISOString()}><strong>{new Intl.DateTimeFormat("en-PH", { weekday: "short" }).format(day)}</strong><span>{day.getDate()}</span>{scheduled.map(item => <small key={item.id}>{item.title}</small>)}</article>)}</div> :
      <div className="water-work-list">{waterItems.map(item => <article key={item.id}><span className="water-status scheduled">{item.status}</span><h2>{item.title}</h2><p>{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p><div><span>{copy("copy_00308aac2f84")}{formatResidentDateTime(item.startsAt)}</span><span>{copy("copy_fb3ce79b4a5e")}{formatResidentDateTime(item.endsAt)}</span></div></article>)}{waterItems.length === 0 && <div className="water-empty">{copy("copy_b30e808b8c38")}</div>}</div>}
  </section>;
}

function WaterPublishForm({ busy, token, onCancel, onSubmit }: { busy: boolean; token: string | null; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const categories = requiredSetting(settingsFor("water").categories, "water.categories");
  const priorities = requiredSetting(settingsFor("water").priorities, "water.priorities");
  const [category, setCategory] = useState(() => readWaterDraftValue("category") || categories[0]?.value || "");
  const [draftSaved, setDraftSaved] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<CivicAlertMapLocation | null>(null);
  const [channels, setChannels] = useState<string[]>(() => {
    const draft = readWaterDraftChannels();
    return draft.length > 0 ? draft : [...DEFAULT_ANNOUNCEMENT_CHANNELS];
  });
  const [schedule, setSchedule] = useState(() => readWaterDraftValue("schedule") === "true");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [detailsLength, setDetailsLength] = useState(() => readWaterDraftValue("details").length);
  useEffect(() => {
    if (!imagePreview) return;
    return () => URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);
  const saveDraft = (form: HTMLFormElement | null) => {
    if (!form) return;
    new FormData(form).forEach((value, name) => {
      if (value instanceof File || name === "channels") return;
      localStorage.setItem(`civicalert:water:draft:${name}`, String(value));
    });
    localStorage.setItem("civicalert:water:draft:category", category);
    localStorage.setItem("civicalert:water:draft:schedule", String(schedule));
    localStorage.setItem("civicalert:water:draft:channels", channels.join("|"));
    setDraftSaved(true);
  };
  const toggleChannel = (channel: string) => {
    if (isRequiredAnnouncementChannel(channel)) return;
    setChannels(current => current.includes(channel)
      ? current.filter(value => value !== channel)
      : [...current, channel]);
    setDraftSaved(false);
  };
  return <form className="water-page water-publish-form" onSubmit={onSubmit}>
    <div className="water-publish-top"><div><span>WATER OPERATIONS / PUBLIC NOTICES</span><h2>Publish water advisory</h2></div><div><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={event => saveDraft(event.currentTarget.form)}>Save draft</button><button type="submit" className="water-primary" disabled={busy}>{busy ? "Publishing…" : "Publish advisory"}</button></div></div>
    <section className="water-form-card">
      <div><h3>Classify the service update</h3><p>Choose the advisory type and response priority for this notice.</p></div>
      <div className="water-category-grid">{categories.map(({ value, description }) => <button type="button" aria-pressed={category === value} className={category === value ? "selected" : ""} key={value} onClick={() => { setCategory(value); setDraftSaved(false); }}><strong>{value}</strong><small>{description}</small></button>)}</div>
      <input type="hidden" name="category" value={category} />
      <label><span>Priority</span><select name="priority" defaultValue={readWaterDraftValue("priority") || "Urgent"} onChange={() => setDraftSaved(false)}>{priorities.map(priority => <option key={priority}>{priority}</option>)}</select></label>
    </section>
    <section className="water-form-card">
      <div><h3>Advisory headline and affected area</h3><p>Keep the headline brief and identify the impacted district or neighborhood.</p></div>
      <label><span>Advisory headline</span><input name="title" required maxLength={160} defaultValue={readWaterDraftValue("title")} onChange={() => setDraftSaved(false)} placeholder="Summarize the service update" /></label>
      <label><span>Affected zone or district</span><input name="area" required maxLength={160} defaultValue={readWaterDraftValue("area")} onChange={() => setDraftSaved(false)} placeholder="District, barangay, or service area" /></label>
    </section>
    <section className="water-form-card">
      <div><h3>Service window</h3><p>Include the expected work start and estimated restoration time when known.</p></div>
      <div className="water-timeline-grid">
        <label><span>Advisory start</span><input name="serviceStartsAt" type="datetime-local" defaultValue={readWaterDraftValue("serviceStartsAt")} onChange={() => setDraftSaved(false)} /></label>
        <label><span>Estimated restoration</span><input name="estimatedRestorationAt" type="datetime-local" defaultValue={readWaterDraftValue("estimatedRestorationAt")} onChange={() => setDraftSaved(false)} /></label>
      </div>
    </section>
    <section className="water-form-card">
      <div className="water-section-heading"><div><h3>Public notice and guidance</h3><p>Explain the impact and any practical steps residents should take.</p></div><small>{detailsLength} / 1800</small></div>
      <label><span>Public advisory text</span><textarea name="details" required rows={6} maxLength={1800} defaultValue={readWaterDraftValue("details")} onChange={event => { setDetailsLength(event.target.value.length); setDraftSaved(false); }} placeholder="Describe the service issue, affected customers, expected timing, and any safety guidance." /></label>
    </section>
    <section className="water-form-card">
      <div><h3>Pin the affected area</h3><p>Optionally mark the service location on the map.</p></div>
      <input type="hidden" name="latitude" value={selectedLocation?.latitude ?? ""} />
      <input type="hidden" name="longitude" value={selectedLocation?.longitude ?? ""} />
      <GoogleMap mode="picker" height={250} label="Select affected service location" onLocationSelected={setSelectedLocation} />
      <p className="water-selection-note">{selectedLocation ? `Selected point: ${selectedLocation.latitude.toFixed(5)}, ${selectedLocation.longitude.toFixed(5)}` : "No map point selected. The advisory can still be published without one."}</p>
    </section>
    <section className="water-form-card">
      <div><h3>Notice image</h3><p>Add an image to include it with selected Facebook, Instagram, and Gmail delivery. Instagram always requires an image.</p></div>
      <label><span>Image file</span><input type="file" name="announcementImage" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; setImagePreview(file ? URL.createObjectURL(file) : null); setDraftSaved(false); }} /><small>JPEG, PNG, or WebP, up to 15 MB. Oversized images are optimized automatically before upload.</small></label>
      {imagePreview && <img src={imagePreview} alt="Selected advisory image preview" className="water-image-preview" />}
    </section>
    <section className="water-form-card">
      <div><h3>Announcement channels</h3><p>Facebook and Gmail are sent for every announcement. Other channels are optional.</p></div>
      <div className="water-channel-list">
        {([
          ["gmail", "Email residents", "Email every registered resident with the announcement image."],
          ["facebook", "Facebook", "Publish every announcement to the connected utility page."],
          ["instagram", "Instagram", "Publish an image and caption to the connected account."],
          ["sms", "Resident inbox alert", "Create simulated inbox alerts; no text messages are sent."],
        ] as const).map(([value, title, description]) => <label className="water-channel-row" key={value}>
          <span><strong>{title}</strong><small>{description}</small></span>
          <input type="checkbox" name="channels" value={value} checked={isRequiredAnnouncementChannel(value) || channels.includes(value)} disabled={isRequiredAnnouncementChannel(value)} onChange={() => toggleChannel(value)} />
        </label>)}
      </div>
      <SocialConnectionStatus portal="water" token={token} />
      <GmailConnection portal="water" token={token} />
    </section>
    <section className="water-form-card">
      <div><h3>Publish timing</h3><p>Publish when ready or set a future release time.</p></div>
      <label className="water-schedule-toggle"><input type="checkbox" checked={schedule} onChange={event => { setSchedule(event.target.checked); setDraftSaved(false); }} /> Schedule this advisory for later</label>
      {schedule && <label>Publish date and time<input name="scheduledAt" type="datetime-local" required min={minimumLocalDateTime()} defaultValue={readWaterDraftValue("scheduledAt")} onChange={() => setDraftSaved(false)} /></label>}
      {!schedule && <input type="hidden" name="scheduledAt" value="" />}
    </section>
    <div className="water-publish-footer">{draftSaved && <span className="water-draft-saved" role="status">Draft saved in this browser.</span>}<button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={event => saveDraft(event.currentTarget.form)}>Save draft</button><button className="water-primary" type="submit" disabled={busy}>{busy ? "Publishing…" : schedule ? "Schedule advisory" : "Publish advisory"}</button></div>
  </form>;
}

function readWaterDraftValue(name: string) {
  return localStorage.getItem(`civicalert:water:draft:${name}`) || "";
}

function readWaterDraftChannels(): string[] {
  const channels = readWaterDraftValue("channels").split("|");
  return channels.filter(channel => ["gmail", "facebook", "instagram", "sms"].includes(channel));
}

function WorkTable({ items }: { items: WorkOrder[] }) {
  if (!items.length) return <Empty message={copy("copy_7fd74ce5eccf")} />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left"><thead><tr className="border-b border-slate-100 text-[9px] uppercase tracking-wide text-slate-400"><th className="px-2 py-2">{copy("copy_ce02285cc14e")}</th><th className="px-2 py-2">{copy("copy_024dc204d7ba")}</th><th className="px-2 py-2">{copy("copy_19734a1b58ca")}</th><th className="px-2 py-2">{copy("copy_920e413c7d41")}</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-b border-slate-50 text-[10px] text-slate-600 last:border-0"><td className="px-2 py-3"><strong className="block text-slate-800">{item.title}</strong><span className="text-[9px] text-slate-400">{item.reference}</span></td><td className="px-2 py-3">{item.area}</td><td className="px-2 py-3">{formatResidentDateTime(item.startsAt)}</td><td className="px-2 py-3"><span className="rounded-full bg-blue-50 px-2 py-1 text-[9px] font-bold text-blue-800">{item.status}</span></td></tr>)}</tbody></table></div>;
}

function Network({ portal, advisories, network }: { portal: Portal; advisories: Advisory[]; network: NetworkReading[] }) {
  const water = portal === "water";
  const mapLabel = requiredSetting(settingsFor(portal).mapLabels?.network, `${portal}.mapLabels.network`);
  return <div className="space-y-4">
    <article className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="m-0 text-base font-bold text-slate-900">{water ? copy("copy_a057083f0c39") : copy("copy_10811357280f")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_447c01316fb5")}</p></div><span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-800">{copy("copy_1dc83f605edf")}</span></div>
      {/* UPDATED: Replace the simulated network map with actual advisory location markers. */}
      <GoogleMap mode="display" announcements={mapAnnouncements(advisories)} height={360} label={mapLabel} />
      <div className="mt-3 flex gap-4 text-[10px] text-slate-500"><span>{copy("copy_bbf0b0b5e5df")}</span><span className="text-amber-700">{copy("copy_8ee132327af2")}</span><span className="text-blue-700">{copy("copy_f30c5b09f4f0")}</span></div>
    </article>
    {water && <PressureZones readings={network} />}
    <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_978de5ad70fd")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_bee37faf7a58")}</p></div><div className="grid gap-3 sm:grid-cols-2">{advisories.slice(0, 4).map(item => <DataCard key={item.id} item={item} page="incidents" />)}{advisories.length === 0 && <Empty message={copy("copy_f4aec847eb06")} />}</div></article>
  </div>;
}

function Services({ advisories }: { advisories: Advisory[] }) {
  const services = requiredSetting(settingsFor("resident").services, "resident.services");
  return <div className="space-y-3">{services.map((service, index) => {
    const hasAdvisory = advisories.some(item => item.utility === service.name && item.status !== "Resolved");
    return <article key={service.name} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-3"><span className={`grid h-10 w-10 place-items-center rounded-lg ${index === 0 ? "bg-blue-50 text-blue-700" : "bg-cyan-50 text-cyan-800"}`}><Icon name={service.icon} /></span><div><strong className="block text-sm text-slate-800">{service.name}</strong><span className="text-[10px] text-slate-500">{service.description}</span></div></div><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${hasAdvisory ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>{hasAdvisory ? service.advisoryStatus : service.operationalStatus}</span></article>;
  })}<p className="rounded-lg bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">{copy("copy_f437429d2649")}</p></div>;
}

function VirtualInbox({ messages, onRead }: { messages: SMSRecord[]; onRead: (message: SMSRecord) => void }) {
  return <section className="space-y-3">
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{copy("copy_c731f7df8727")}</p>
    {messages.length === 0 ? <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{copy("copy_5b2101616c26")}</div> :
      messages.map(message => <article key={message.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><span className="rounded-full bg-violet-50 px-2 py-1 text-[9px] font-bold text-violet-800">{copy("copy_bca3048d4062")}</span><h2 className="mb-1 mt-3 text-sm font-bold text-slate-900">{message.utility} · {message.reference}</h2><p className="mb-0 text-xs text-slate-600">{message.body}</p></div>
          <div className="text-right"><span className={`text-[9px] font-bold ${message.read ? "text-slate-400" : "text-rose-700"}`}>{message.read ? copy("copy_9b9a8d05a7ec") : copy("copy_1b9f384c1436")}</span><p className="mt-2 text-[9px] text-slate-400">{message.recipient} · {message.phoneNumber}</p><time className="text-[9px] text-slate-400">{formatResidentDateTime(message.createdAt)}</time></div>
        </div>
        {!message.read && <button type="button" onClick={() => onRead(message)} className="mt-3 rounded-md border border-slate-200 px-3 py-1.5 text-[9px] font-semibold text-slate-600 hover:bg-slate-50">{copy("copy_50c8b81faf51")}</button>}
      </article>)}
  </section>;
}

function RecordModal({ portal, kind, onClose, onSubmit }: { portal: Portal; kind: "advisory" | "work"; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const water = portal === "water";
  const title = settingsFor(portal).modalTitles[kind];
  return <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-5 flex items-start justify-between"><div><p className="mb-2 text-[9px] font-extrabold tracking-[.15em] text-[var(--brand)]">{settingsFor(portal).label.toUpperCase()} {copy("copy_5493ff8e9397")}</p><h2 className="m-0 text-xl font-extrabold text-slate-900">{title}</h2></div><button onClick={onClose} className="rounded-lg bg-slate-100 p-2 text-slate-500" aria-label={copy("copy_7d9eb7acb13e")}><Icon name="close" /></button></div><form onSubmit={onSubmit} className="space-y-4">
    <label className="block text-xs font-bold text-slate-700">{kind === "work" ? copy("copy_713b2d01699a") : copy("copy_2b7f97151f81")}<input name="title" required placeholder={kind === "work" ? water ? copy("copy_d210615060af") : copy("copy_be1568cc2343") : water ? copy("copy_f61939b4ec8b") : copy("copy_14a302e7d4cb")} className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-sm font-normal" /></label>
    <label className="block text-xs font-bold text-slate-700">{copy("copy_4dfc9891f0d9")}<input name="area" required placeholder={copy("copy_d747a0681306")} className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-sm font-normal" /></label>
    <label className="block text-xs font-bold text-slate-700">{kind === "work" ? copy("copy_7e4c74552701") : copy("copy_3d8e9e6f5e5f")}<textarea name={kind === "work" ? "description" : "details"} required rows={4} placeholder={copy("copy_ef9e65b78190")} className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-sm font-normal" /></label>
    {kind === "work" && <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-bold text-slate-700">{copy("copy_e4bb9f1ece9a")}<input name="startsAt" type="datetime-local" required className="mt-2 block w-full rounded-lg border border-slate-200 p-2.5 text-xs font-normal" /></label><label className="block text-xs font-bold text-slate-700">{copy("copy_f4db1e48476f")}<input name="endsAt" type="datetime-local" required className="mt-2 block w-full rounded-lg border border-slate-200 p-2.5 text-xs font-normal" /></label></div>}
    <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600">{copy("copy_19766ed6ccb2")}</button><button className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-xs font-bold text-white">{kind === "advisory" ? copy("copy_3e2f45d85a26") : copy("copy_a6de1b1266b1")}</button></div>
  </form></section></div>;
}

function PortalApp({ portal }: { portal: Portal }) {
  return <App portal={portal} />;
}

export function mountPortal(portal: Portal) {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing #root mount element");
  const root = createRoot(element);
  try {
    getSupabase();
    root.render(<PortalApp portal={portal} />);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not initialize Supabase.";
    root.render(<main role="alert">{message}</main>);
  }
}
