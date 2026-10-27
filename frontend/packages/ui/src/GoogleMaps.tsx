import { useEffect, useMemo, useRef, useState } from "react";

// ADDED: Shared coordinate type used by the publisher and the advisory map.
export type CivicAlertMapLocation = {
  latitude: number;
  longitude: number;
};

// ADDED: The fields needed to display a saved advisory pin and its details.
export type CivicAlertMapAnnouncement = CivicAlertMapLocation & {
  id: number;
  title: string;
  utility: string;
  area: string;
  status: string;
};

type MapsListener = { remove: () => void };
type MapsMapEvent = {
  latLng?: { lat: () => number; lng: () => number } | null;
};

interface MapsMapInstance {
  addListener(eventName: string, handler: (event: MapsMapEvent) => void): MapsListener;
  setCenter(position: { lat: number; lng: number }): void;
  setZoom(zoom: number): void;
  fitBounds(bounds: MapsLatLngBounds): void;
}

interface MapsMarker {
  setMap(map: MapsMapInstance | null): void;
  addListener(eventName: string, handler: () => void): MapsListener;
}

interface MapsInfoWindow {
  setContent(content: HTMLElement | string): void;
  open(options: { map: MapsMapInstance; anchor?: MapsMarker }): void;
}

interface MapsLatLngBounds {
  extend(position: { lat: number; lng: number }): void;
}

interface GoogleMapsApi {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => MapsMapInstance;
  Marker: new (options: { map: MapsMapInstance; position: { lat: number; lng: number }; title?: string }) => MapsMarker;
  InfoWindow: new (options?: { content?: HTMLElement | string }) => MapsInfoWindow;
  LatLngBounds: new () => MapsLatLngBounds;
}

declare global {
  interface Window {
    google?: { maps?: GoogleMapsApi };
    gm_authFailure?: () => void;
  }
}

const DEFAULT_CAGAYAN_DE_ORO: CivicAlertMapLocation = {
  // ADDED: Default viewport centered on CivicAlert's likely CEPALCO service region.
  latitude: 8.4542,
  longitude: 124.6319,
};

let mapsScriptPromise: Promise<GoogleMapsApi> | null = null;
const MAP_AUTH_FAILURE_EVENT = "civicalert-google-maps-auth-failure";

// ADDED: Load the Maps JavaScript API once per page, using each Vite app's local env key.
function loadGoogleMaps(apiKey: string): Promise<GoogleMapsApi> {
  window.gm_authFailure = () => window.dispatchEvent(new Event(MAP_AUTH_FAILURE_EVENT));
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (mapsScriptPromise) return mapsScriptPromise;

  const pending = new Promise<GoogleMapsApi>((resolve, reject) => {
    const existing = document.getElementById("civicalert-google-maps-script") as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const onLoad = () => {
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error("Google Maps loaded without exposing the Maps JavaScript API."));
    };
    const onError = () => reject(new Error("Google Maps could not be loaded. Check the API key, billing, and website restrictions."));

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (!existing) {
      script.id = "civicalert-google-maps-script";
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
      document.head.appendChild(script);
    } else if (window.google?.maps) {
      resolve(window.google.maps);
    }
  }).catch((error: unknown) => {
    // Permit a retry after a key/billing/referrer fix, rather than caching a failed promise forever.
    document.getElementById("civicalert-google-maps-script")?.remove();
    mapsScriptPromise = null;
    throw error;
  });
  mapsScriptPromise = pending;
  return pending;
}

export function GoogleMap({
  mode,
  announcements = [],
  onLocationSelected,
  height = 340,
  label,
}: {
  mode: "picker" | "display";
  announcements?: CivicAlertMapAnnouncement[];
  onLocationSelected?: (location: CivicAlertMapLocation) => void;
  height?: number;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onLocationSelectedRef = useRef(onLocationSelected);
  const [loading, setLoading] = useState(true);
  const [mapError, setMapError] = useState("");
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  useEffect(() => {
    onLocationSelectedRef.current = onLocationSelected;
  }, [onLocationSelected]);

  // Keep display-mode markers in sync without rebuilding the map on every React render.
  const markerSignature = useMemo(
    () => announcements.map(item => `${item.id}|${item.latitude}|${item.longitude}|${item.title}|${item.area}|${item.status}`).join(";"),
    [announcements],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let clickListener: MapsListener | null = null;
    let selectionMarker: MapsMarker | null = null;
    const plottedMarkers: MapsMarker[] = [];
    setLoading(true);
    setMapError("");
    const handleAuthFailure = () => {
      if (disposed) return;
      setLoading(false);
      setMapError("Google Maps rejected this site's URL. Add this exact localhost or production URL to the browser key's website restrictions in Google Cloud.");
    };
    window.addEventListener(MAP_AUTH_FAILURE_EVENT, handleAuthFailure);

    if (!apiKey?.trim()) {
      setLoading(false);
      setMapError("Google Maps key is missing. Set VITE_GOOGLE_MAPS_API_KEY in this portal's .env.local file and restart Vite.");
      return () => {
        disposed = true;
        window.removeEventListener(MAP_AUTH_FAILURE_EVENT, handleAuthFailure);
      };
    }

    void loadGoogleMaps(apiKey.trim()).then(maps => {
      if (disposed || !containerRef.current) return;

      const map = new maps.Map(container, {
        center: { lat: DEFAULT_CAGAYAN_DE_ORO.latitude, lng: DEFAULT_CAGAYAN_DE_ORO.longitude },
        zoom: mode === "picker" ? 12 : 11,
        mapTypeControl: false,
        streetViewControl: false,
        clickableIcons: false,
        fullscreenControl: true,
        gestureHandling: "greedy",
      });

      if (mode === "picker") {
        // ADDED: Clicking a point places/moves the location pin and returns coordinates to the form.
        clickListener = map.addListener("click", event => {
          if (!event.latLng) return;
          const location = {
            latitude: event.latLng.lat(),
            longitude: event.latLng.lng(),
          };
          selectionMarker?.setMap(null);
          selectionMarker = new maps.Marker({
            map,
            position: { lat: location.latitude, lng: location.longitude },
            title: "Selected affected location",
          });
          onLocationSelectedRef.current?.(location);
        });
      } else {
        // ADDED: Display markers only for announcements that have valid saved coordinates.
        const validAnnouncements = announcements.filter(item =>
          Number.isFinite(item.latitude) && Number.isFinite(item.longitude) &&
          item.latitude >= -90 && item.latitude <= 90 &&
          item.longitude >= -180 && item.longitude <= 180,
        );
        const bounds = new maps.LatLngBounds();
        const infoWindow = new maps.InfoWindow();

        for (const announcement of validAnnouncements) {
          const position = { lat: announcement.latitude, lng: announcement.longitude };
          const marker = new maps.Marker({ map, position, title: announcement.title });
          plottedMarkers.push(marker);
          bounds.extend(position);
          marker.addListener("click", () => {
            // Use textContent rather than HTML strings to avoid treating advisory text as markup.
            const content = document.createElement("div");
            content.className = "civicalert-map-info";
            const title = document.createElement("strong");
            title.textContent = announcement.title;
            const area = document.createElement("p");
            area.textContent = `${announcement.utility} · ${announcement.area}`;
            const status = document.createElement("small");
            status.textContent = `Status: ${announcement.status}`;
            content.append(title, area, status);
            infoWindow.setContent(content);
            infoWindow.open({ map, anchor: marker });
          });
        }

        if (validAnnouncements.length === 1) {
          map.setCenter({ lat: validAnnouncements[0].latitude, lng: validAnnouncements[0].longitude });
          map.setZoom(14);
        } else if (validAnnouncements.length > 1) {
          map.fitBounds(bounds);
        }
      }

      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoading(false);
      setMapError("Google Maps could not load. Check that Maps JavaScript API is enabled, billing is active, and this localhost URL is in the key's website restrictions.");
    });

    return () => {
      disposed = true;
      window.removeEventListener(MAP_AUTH_FAILURE_EVENT, handleAuthFailure);
      clickListener?.remove();
      selectionMarker?.setMap(null);
      for (const marker of plottedMarkers) marker.setMap(null);
    };
  // The marker signature intentionally describes marker data rather than the array identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, mode, markerSignature]);

  const validAnnouncementCount = announcements.filter(item =>
    Number.isFinite(item.latitude) && Number.isFinite(item.longitude) &&
    item.latitude >= -90 && item.latitude <= 90 &&
    item.longitude >= -180 && item.longitude <= 180,
  ).length;

  return <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100" style={{ minHeight: height }}>
    <div ref={containerRef} style={{ height, width: "100%" }} aria-label={mode === "picker" ? "Click the map to select an affected location" : "Map of utility advisories"} />
    {label && <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-white/95 px-3 py-2 text-xs font-bold text-slate-800 shadow">{label}</div>}
    {loading && <div role="status" className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">Loading Google Maps…</div>}
    {mapError && <div role="alert" className="absolute inset-x-3 bottom-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{mapError}</div>}
    {mode === "display" && !loading && !mapError && validAnnouncementCount === 0 && <div className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">No announcements have saved map coordinates yet. Select a point when publishing a new advisory to add its marker.</div>}
  </div>;
}
