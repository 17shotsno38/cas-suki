export type PortalSettings = {
  label: string;
  brand: string;
  color: string;
  navigation: Array<{ key: string; label: string; icon: string }>;
  pageTitles: Record<string, string>;
  pageDescriptions: Record<string, string>;
  sidebarLabel: string;
  pageHeadingLabel: string;
  publishButtonLabel: string;
  overviewGreetingPrefix?: string;
  modalTitles: Record<"advisory" | "work", string>;
  barangays?: string[];
  districts?: string[];
  locationDefaults?: { city: string; postalCode: string };
  publicNavigation?: string[];
  registerHighlights?: Array<{ icon: string; title: string; detail: string }>;
  filters?: Record<string, string[]>;
  categories?: Array<{ value: string; description: string; icon?: string }>;
  priorities?: string[];
  services?: Array<{ name: string; description: string; icon: string; advisoryStatus: string; operationalStatus: string }>;
  dashboard?: Record<string, string | number>;
  metrics?: Array<{ key: string; label: string; icon: string; value?: string; badge?: string }>;
  mapMetrics?: Array<{ key: string; label: string; value?: string; detail: string; icon: string }>;
  scheduleMetrics?: Array<{ key: string; label: string; value: string; detail: string; icon: string }>;
  networkStatus?: { pressureWatchThresholdPsi: number; watch: string; normal: string };
  maps?: Record<string, Array<{ kind: string; left: number; top: number }>>;
  mapLabels?: Record<string, string>;
};

export const portalSettings = {
  resident: {
    label: "Resident",
    brand: "CivicAlert",
    color: "red",
    navigation: [
      { key: "overview", label: "My community", icon: "home" },
      { key: "advisories", label: "Local advisories", icon: "alert" },
      { key: "services", label: "Utility services", icon: "water" },
      { key: "profile", label: "Profile & settings", icon: "people" },
    ],
    pageTitles: {
      overview: "My community",
      advisories: "Local advisories",
      services: "Utility services",
      profile: "Profile & Account Settings",
    },
    pageDescriptions: {
      overview: "Your service area status and latest verified community updates.",
      advisories: "Latest utility advisories and maintenance updates for your area.",
      services: "Check the current service status for your utility providers.",
      profile: "Manage your personal information, barangay location, and alert preferences.",
    },
    sidebarLabel: "RESIDENT SERVICES",
    pageHeadingLabel: "RESIDENT PORTAL · CAGAYAN DE ORO CITY",
    publishButtonLabel: "Publish advisory",
    overviewGreetingPrefix: "Good day,",
    modalTitles: { advisory: "Publish service advisory", work: "Create work order" },
    publicNavigation: ["Advisories", "Services", "Directory", "Support"],
    registerHighlights: [
      { icon: "shield", title: "Service Interruption Updates", detail: "Local power and water service advisories for your area." },
      { icon: "pulse", title: "SMS Alert Preferences", detail: "Choose whether to opt in to text alerts when messaging is available." },
      { icon: "map", title: "Barangay-Level Updates", detail: "Relevant advisories tailored to your community." },
    ],
    barangays: ["Agusan", "Balulang", "Bugo", "Carmen", "Gusa", "Iponan", "Kauswagan", "Lumbia", "Macabalan", "Macasandig", "Nazareth", "Patag", "Puerto"],
    districts: ["1st District", "2nd District"],
    locationDefaults: { city: "Cagayan de Oro City", postalCode: "9000" },
    filters: {
      utilities: ["All", "CEPALCO", "Water District"],
      advisoryStatuses: ["All", "Monitoring", "Under investigation", "Crew dispatched", "Resolved"],
      quickFilters: ["All", "CEPALCO", "Water District", "Crew dispatched", "Under investigation", "Resolved"],
    },
    services: [
      { name: "CEPALCO", description: "Electric power services", icon: "pulse", advisoryStatus: "Advisory in area", operationalStatus: "Operational" },
      { name: "Water District", description: "Water supply and distribution", icon: "water", advisoryStatus: "Advisory in area", operationalStatus: "Operational" },
    ],
    dashboard: { connectedServices: 2, updateFrequency: "24/7", communityProviders: 2 },
    metrics: [
      { key: "activeAdvisories", label: "Active local advisories", icon: "alert", badge: "Attention required" },
      { key: "connectedServices", label: "Connected utility services", icon: "water", value: "2", badge: "Power & Water" },
      { key: "updateFrequency", label: "Verified service updates", icon: "pulse", value: "24/7", badge: "Live feed" },
    ],
    maps: {
      community: [
        { kind: "power", left: 38, top: 51 },
        { kind: "water", left: 65, top: 39 },
        { kind: "planned", left: 76, top: 69 },
      ],
      mini: [
        { kind: "service", left: 63, top: 48 },
        { kind: "planned", left: 36, top: 28 },
        { kind: "report", left: 77, top: 72 },
      ],
    },
    mapLabels: { community: "CAGAYAN DE ORO · SERVICE ZONES", mini: "CAGAYAN DE ORO" },
  },
  cepalco: {
    label: "CEPALCO",
    brand: "CEPALCO Operations",
    color: "red",
    navigation: [
      { key: "overview", label: "Overview", icon: "home" },
      { key: "incidents", label: "Active disruptions", icon: "alert" },
      { key: "scheduled", label: "Scheduled works", icon: "calendar" },
      { key: "restoration", label: "Restoration map", icon: "map" },
      { key: "residents", label: "Resident reports", icon: "people" },
      { key: "publish", label: "Create announcement", icon: "plus" },
    ],
    pageTitles: {
      overview: "Operations overview",
      incidents: "Active disruptions",
      scheduled: "Scheduled works",
      restoration: "Restoration map",
      residents: "Resident reports",
      publish: "Create announcement",
    },
    pageDescriptions: {
      overview: "Your service area status and latest verified community updates.",
      incidents: "Review verified service updates affecting your area.",
      scheduled: "Plan and track upcoming service work.",
      restoration: "Review local service activity by district.",
      residents: "Review service reports submitted by residents.",
      publish: "Enter report details, choose a location and channels, then publish now or schedule your announcement.",
    },
    sidebarLabel: "CEPALCO OPERATIONS",
    pageHeadingLabel: "CEPALCO OPERATIONS",
    publishButtonLabel: "Create announcement",
    modalTitles: { advisory: "Publish service advisory", work: "Create work order" },
    filters: {
      incidentStatuses: ["All", "Monitoring", "Under investigation", "Crew dispatched", "Resolved"],
      workStatuses: ["All scheduled", "Scheduled"],
    },
    categories: [
      { value: "Unplanned outage", description: "Power interruption", icon: "⚡" },
      { value: "Scheduled work", description: "Maintenance window", icon: "▦" },
      { value: "Grid alert", description: "Network notification", icon: "⌁" },
      { value: "Voltage issue", description: "Power quality", icon: "ϟ" },
    ],
    priorities: ["Critical", "High", "Medium", "Low"],
    dashboard: {
      feedersOnline: "98.4%",
      feederCount: "92 / 94 active",
      averageRestoration: "1h 45m",
      restorationTarget: "Within SLA target",
      plannedInterruption: "14.5 hrs total",
      impactedHouseholds: "1,840 Est.",
      fieldCrews: "06 Line Crews",
      disruptionBadge: "Critical 1",
      workOrderBadge: "Queued",
      reportBadge: "All clear",
      restorationBadge: "+2.4% vs mo",
      minimumFieldCrews: 3,
      mapFallbackTitle: "Power interruption — Carmen",
      mapFallbackArea: "Zone 4 · Feeder tripped at 14:16",
    },
    metrics: [
      { key: "activeDisruptions", label: "Active disruptions", icon: "alert", badge: "Critical 1" },
      { key: "scheduledWorks", label: "Scheduled this week", icon: "calendar", badge: "Queued" },
      { key: "restorationOnTime", label: "Restoration on time", icon: "pulse", value: "94%", badge: "+2.4% vs mo" },
      { key: "residentReports", label: "Resident reports", icon: "people", badge: "All clear" },
    ],
    mapMetrics: [
      { key: "feedersOnline", label: "Feeders online", value: "98.4%", detail: "92 / 94 active", icon: "pulse" },
      { key: "activeOutage", label: "Active outage", detail: "No active outage", icon: "alert" },
      { key: "crewsInField", label: "Crews in field", detail: "Response unit en route", icon: "people" },
      { key: "averageRestoration", label: "Avg restoration", value: "1h 45m", detail: "Within SLA target", icon: "calendar" },
    ],
    scheduleMetrics: [
      { key: "scheduledThisWeek", label: "Scheduled this week", value: "Work Orders", detail: "maintenance windows", icon: "calendar" },
      { key: "plannedInterruption", label: "Planned interruption", value: "14.5 hrs total", detail: "Across scheduled service areas", icon: "pulse" },
      { key: "impactedHouseholds", label: "Impacted households", value: "1,840 Est.", detail: "Notices required before work", icon: "people" },
      { key: "fieldCrews", label: "Field crews reserved", value: "06 Line Crews", detail: "Ready for dispatch", icon: "shield" },
    ],
    maps: {
      mini: [
        { kind: "report", left: 30, top: 40 },
        { kind: "work", left: 55, top: 55 },
        { kind: "station", left: 70, top: 35 },
        { kind: "second", left: 82, top: 65 },
      ],
      restoration: [
        { kind: "work-pin", left: 38, top: 29 },
        { kind: "outage-pin", left: 62, top: 55 },
        { kind: "service-pin", left: 74, top: 68 },
      ],
    },
    mapLabels: { mini: "CAGAYAN DE ORO · SERVICE ZONES", restoration: "UTILITY SERVICE ZONES · METRO CAGAYAN DE ORO" },
  },
  water: {
    label: "Water District",
    brand: "Water District",
    color: "blue",
    networkStatus: { pressureWatchThresholdPsi: 35, watch: "Watch", normal: "Normal" },
    navigation: [
      { key: "overview", label: "Overview", icon: "home" },
      { key: "incidents", label: "Water advisories", icon: "alert" },
      { key: "scheduled", label: "Maintenance schedule", icon: "calendar" },
      { key: "restoration", label: "Network map", icon: "map" },
      { key: "residents", label: "Service reports", icon: "people" },
    ],
    pageTitles: {
      overview: "Water network overview",
      incidents: "Water service advisories",
      scheduled: "Water maintenance schedule",
      restoration: "Water network map",
      residents: "Water service reports",
      publish: "Create announcement",
    },
    pageDescriptions: {
      overview: "Monitor water quality, pressure, advisories, and maintenance across the district.",
      incidents: "Review verified service updates affecting your area.",
      scheduled: "Plan and track upcoming service work.",
      restoration: "Review local service activity by district.",
      residents: "Review service reports submitted by residents.",
      publish: "Enter report details, choose a location and channels, then publish now or schedule your announcement.",
    },
    sidebarLabel: "WATER DISTRICT OPERATIONS",
    pageHeadingLabel: "WATER DISTRICT OPERATIONS",
    publishButtonLabel: "Create announcement",
    modalTitles: { advisory: "Publish water advisory", work: "Schedule water maintenance" },
    filters: {
      reportUtilities: ["All", "CEPALCO", "Water District"],
      reportStatuses: ["All", "Crew dispatched", "Under investigation", "Resolved"],
      workStatuses: ["All scheduled", "Scheduled"],
    },
    categories: [
      { value: "Emergency interruption", description: "Report a critical supply issue" },
      { value: "Low pressure notice", description: "Pressure below expected range" },
      { value: "Under investigation", description: "Operations team is investigating" },
      { value: "Urgent alert", description: "Immediate resident action needed" },
      { value: "Scheduled work", description: "Planned water service work" },
      { value: "Boil water alert", description: "Water safety precaution" },
      { value: "Scheduled maintenance", description: "Scheduled district maintenance" },
      { value: "Resolved", description: "Service has returned to normal" },
    ],
    priorities: ["Emergency", "Urgent", "High", "Normal"],
    dashboard: { reservoirStatus: "3 online" },
    metrics: [
      { key: "activeAdvisories", label: "Active water advisories", icon: "water" },
      { key: "averagePressure", label: "Average network pressure", icon: "pulse" },
      { key: "scheduledMaintenance", label: "Scheduled maintenance", icon: "calendar" },
      { key: "residentReports", label: "Resident service reports", icon: "people" },
    ],
    maps: {
      mini: [
        { kind: "service", left: 63, top: 48 },
        { kind: "planned", left: 36, top: 28 },
        { kind: "report", left: 77, top: 72 },
      ],
      network: [
        { kind: "service", left: 56, top: 42 },
        { kind: "planned", left: 32, top: 25 },
        { kind: "report", left: 72, top: 68 },
        { kind: "report", left: 24, top: 72 },
      ],
    },
    mapLabels: { mini: "WATER SERVICE DISTRICTS", network: "WATER SERVICE DISTRICTS" },
  },
} satisfies Record<"resident" | "cepalco" | "water", PortalSettings>;
