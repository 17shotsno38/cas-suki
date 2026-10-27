import { portalSettings } from "./prototypeSettings.js";

export type Portal = "resident" | "cepalco" | "water";
export type Status = "Operational" | "Monitoring" | "Under investigation" | "Scheduled" | "Resolved" | "Received" | "Crew dispatched";
export type Actor = {
  id: number | string;
  name: string;
  email: string;
  role: "resident" | "admin";
  utility: string | null;
  phoneNumber?: string;
  address?: string;
  barangay?: string;
  district?: string;
  city?: string;
  postalCode?: string;
  smsAlerts?: boolean;
  maintenanceAlerts?: boolean;
  emailDigest?: boolean;
  immediateEmailAlerts?: boolean;
  profileImage?: string | null;
};
export type Advisory = {
  id: number;
  reference: string;
  title: string;
  utility: string;
  type: string;
  area: string;
  status: Status;
  details: string;
  createdAt: string;
  scheduledAt?: string | null;
  priority?: string;
  serviceStartsAt?: string | null;
  estimatedRestorationAt?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  publicationStatus?: "scheduled" | "publishing" | "published" | "failed";
  channels?: string[];
  channelsJson?: string;
  imageUrl?: string | null;
};
export type WorkOrder = { id: number; reference: string; title: string; utility: string; area: string; status: string; startsAt: string; endsAt: string; description?: string };
export type ServiceReport = { id: number; reference: string; title: string; utility: string; area: string; status: Status; details?: string; createdAt: string };
export type NetworkReading = { district: string; area: string; pressurePsi: number; reservoirPercent: number; recordedAt: string };
export type SMSRecord = { id: number; recipientId?: number | string; recipient: string; phoneNumber: string; utility: string; reference: string; body: string; createdAt: string; status: "Simulated"; read: boolean };

type LocalAccount = { actor: Actor; password: string };
type PrototypeData = {
  version: 1 | 2;
  accounts: LocalAccount[];
  advisories: Advisory[];
  workOrders: WorkOrder[];
  reports: ServiceReport[];
  network: NetworkReading[];
  virtualInbox: SMSRecord[];
};

const storageKey = "civicalert:prototype:v1";
const demoPassword = "DemoPass123!";

function initialData(): PrototypeData {
  const now = Date.now();
  const date = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const workDate = (daysFromNow: number, hour: number) => {
    const value = new Date();
    value.setDate(value.getDate() + daysFromNow);
    value.setHours(hour, 0, 0, 0);
    return value.toISOString();
  };
  const admin = (id: number, utility: string, email: string, name: string): LocalAccount => ({
    actor: { id, name, email, role: "admin", utility },
    password: demoPassword,
  });
  return {
    version: 2,
    accounts: [
      admin(1, "CEPALCO", "admin@cepalco.local", "CEPALCO Demo Admin"),
      admin(2, "Water District", "admin@waterdistrict.local", "Water District Demo Admin"),
    ],
    advisories: [],
    workOrders: [
      { id: 2001, reference: "WD-2026-021", title: "Mainline valve replacement", utility: "Water District", area: "Balulang · District 3", status: "Scheduled", description: "Planned valve maintenance.", startsAt: workDate(1, 8), endsAt: workDate(1, 12) },
      { id: 2002, reference: "WD-2026-022", title: "District 2 pressure inspection", utility: "Water District", area: "Macasandig · District 2", status: "Scheduled", description: "Pressure zone inspection.", startsAt: workDate(2, 9), endsAt: workDate(2, 11) },
      { id: 2003, reference: "CE-2026-021", title: "Feeder 7 line maintenance", utility: "CEPALCO", area: "Carmen · Zone 4", status: "Scheduled", description: "Line maintenance.", startsAt: workDate(1, 14), endsAt: workDate(1, 17) },
      { id: 2004, reference: "CE-2026-024", title: "Substation capacitor replacement", utility: "CEPALCO", area: "Puntod · Substation B", status: "Scheduled", description: "Replace capacitor bank equipment and inspect the local busbar.", startsAt: workDate(2, 8), endsAt: workDate(2, 13) },
      { id: 2005, reference: "CE-2026-027", title: "High voltage insulator cleaning", utility: "CEPALCO", area: "Macasandig · Sector 2", status: "Scheduled", description: "Routine line-insulator cleaning and hardware inspection.", startsAt: workDate(4, 5), endsAt: workDate(4, 8) },
    ],
    reports: [
      { id: 3001, reference: "SR-2026-041", title: "Low water pressure", utility: "Water District", area: "Macasandig · District 2", status: "Received", details: "Residents report reduced water pressure during the afternoon.", createdAt: date(0) },
      { id: 3002, reference: "SR-2026-039", title: "Intermittent water supply", utility: "Water District", area: "Balulang · District 3", status: "Under investigation", details: "Scope: inspection and pressure-zone assessment.", createdAt: date(1) },
    ],
    network: [
      { district: "District 1", area: "Nazareth · Carmen", pressurePsi: 48, reservoirPercent: 86, recordedAt: date(0) },
      { district: "District 2", area: "Macasandig · downtown", pressurePsi: 31, reservoirPercent: 86, recordedAt: date(0) },
      { district: "District 3", area: "Balulang · Kauswagan", pressurePsi: 44, reservoirPercent: 86, recordedAt: date(0) },
    ],
    virtualInbox: [
      { id: 4001, recipient: "Sample resident", phoneNumber: "09XX-XXX-0001", utility: "CEPALCO", reference: "CAS-2026-1003", body: "CEPALCO advisory for Carmen · Zone 4: Power interruption — Barangay Carmen", createdAt: date(0), status: "Simulated", read: false },
      { id: 4002, recipient: "Sample resident", phoneNumber: "09XX-XXX-0002", utility: "Water District", reference: "CAS-2026-1001", body: "Water District advisory for Macasandig · District 2: Low water pressure — Macasandig", createdAt: date(1), status: "Simulated", read: false },
    ],
  };
}

function readData(): PrototypeData {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    const data = initialData();
    writeData(data);
    return data;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || ![1, 2].includes((value as PrototypeData).version) ||
      !Array.isArray((value as PrototypeData).accounts) ||
      !Array.isArray((value as PrototypeData).advisories) ||
      !Array.isArray((value as PrototypeData).workOrders) ||
      !Array.isArray((value as PrototypeData).reports) ||
      !Array.isArray((value as PrototypeData).network) ||
      !Array.isArray((value as PrototypeData).virtualInbox)) {
    throw new Error("Saved demo data is invalid. Clear this site's local storage to reset the prototype.");
  }
  const data = value as PrototypeData;
  if (data.version === 1) {
    data.version = 2;
    data.advisories = data.advisories.filter(item =>
      item.utility !== "CEPALCO" && item.utility !== "Water District");
    writeData(data);
  }
  return data;
}

function writeData(data: PrototypeData): void {
  localStorage.setItem(storageKey, JSON.stringify(data));
}

export function getActor(portal: Portal): Actor | null {
  const accountId = Number(localStorage.getItem(`civicalert:${portal}:account`));
  if (!accountId) return null;
  return readData().accounts.find(account => account.actor.id === accountId)?.actor ?? null;
}

export function login(portal: Portal, email: string, password: string): Actor {
  const data = readData();
  const account = data.accounts.find(({ actor, password: savedPassword }) =>
    actor.email.toLowerCase() === email.toLowerCase() && savedPassword === password &&
    (portal === "resident" ? actor.role === "resident" : actor.role === "admin" && actor.utility === (portal === "cepalco" ? "CEPALCO" : "Water District")));
  if (!account) throw new Error("Email or password is incorrect.");
  localStorage.setItem(`civicalert:${portal}:account`, String(account.actor.id));
  return account.actor;
}

export function registerResident(values: Record<string, FormDataEntryValue>): Actor {
  const data = readData();
  const email = String(values.email ?? "").trim().toLowerCase();
  if (data.accounts.some(account => account.actor.email.toLowerCase() === email && account.actor.role === "resident")) {
    throw new Error("An account with this email already exists.");
  }
  const actor: Actor = {
    id: Date.now(),
    name: String(values.name ?? "").trim(),
    email,
    role: "resident",
    utility: null,
    phoneNumber: String(values.phoneNumber ?? "").trim(),
    address: String(values.address ?? "").trim(),
    barangay: String(values.barangay ?? "").trim(),
    district: String(values.district ?? "").trim(),
    city: String(values.city ?? "").trim(),
    postalCode: String(values.postalCode ?? "").trim(),
    smsAlerts: values.smsAlerts === "on",
    maintenanceAlerts: true,
    emailDigest: true,
  };
  data.accounts.push({ actor, password: String(values.password ?? "") });
  writeData(data);
  localStorage.setItem("civicalert:resident:account", String(actor.id));
  return actor;
}

export function updateProfile(actorId: number, values: Record<string, FormDataEntryValue>, profileImage: string | null | undefined): Actor {
  const data = readData();
  const account = data.accounts.find(item => item.actor.id === actorId);
  if (!account) throw new Error("Resident account not found.");
  const email = String(values.email ?? "").trim().toLowerCase();
  if (data.accounts.some(item => item.actor.id !== actorId && item.actor.email.toLowerCase() === email && item.actor.role === "resident")) {
    throw new Error("An account with this email already exists.");
  }
  account.actor = {
    ...account.actor,
    name: String(values.name ?? "").trim(),
    email,
    phoneNumber: String(values.phoneNumber ?? "").trim(),
    address: String(values.address ?? "").trim(),
    barangay: String(values.barangay ?? "").trim(),
    district: String(values.district ?? "").trim(),
    city: String(values.city ?? "").trim(),
    postalCode: String(values.postalCode ?? "").trim(),
    smsAlerts: values.smsAlerts === "on",
    maintenanceAlerts: values.maintenanceAlerts === "on",
    emailDigest: values.emailDigest === "on",
    profileImage: profileImage === undefined ? account.actor.profileImage ?? null : profileImage,
  };
  writeData(data);
  return account.actor;
}

export function changePassword(actorId: number, currentPassword: string, newPassword: string): void {
  const data = readData();
  const account = data.accounts.find(item => item.actor.id === actorId);
  if (!account || account.password !== currentPassword) throw new Error("Current password is incorrect.");
  account.password = newPassword;
  writeData(data);
}

export function getWorkspace(portal: Portal) {
  const data = readData();
  const utility = portal === "cepalco" ? "CEPALCO" : portal === "water" ? "Water District" : null;
  return {
    advisories: data.advisories.filter(item => !utility || item.utility === utility),
    workOrders: data.workOrders.filter(item => !utility || item.utility === utility),
    reports: portal === "water" ? data.reports : [],
    network: portal === "water" ? data.network : [],
    virtualInbox: data.virtualInbox,
  };
}

function addVirtualSms(data: PrototypeData, utility: string, reference: string, title: string, area: string): void {
  for (const account of data.accounts) {
    const actor = account.actor;
    if (actor.role !== "resident" || !actor.smsAlerts || !actor.phoneNumber) continue;
    data.virtualInbox.unshift({
      id: Date.now() + data.virtualInbox.length,
      recipientId: actor.id,
      recipient: actor.name,
      phoneNumber: actor.phoneNumber,
      utility,
      reference,
      body: `${utility} advisory for ${area}: ${title}`,
      createdAt: new Date().toISOString(),
      status: "Simulated",
      read: false,
    });
  }
}

export function createAdvisory(portal: Portal, values: Record<string, FormDataEntryValue>): Advisory {
  const data = readData();
  const utility = portal === "cepalco" ? "CEPALCO" : "Water District";
  const id = Date.now();
  const reference = `${portal === "water" ? "WD" : "CE"}-${id.toString(36).toUpperCase()}`;
  const advisory: Advisory = {
    id, reference, title: String(values.title ?? "").trim(), utility,
    type: String(values.type ?? values.category ?? "Service advisory"),
    area: String(values.area ?? "").trim(),
    status: "Monitoring",
    details: String(values.details ?? "").trim(),
    createdAt: new Date().toISOString(),
  };
  data.advisories.unshift(advisory);
  addVirtualSms(data, utility, reference, advisory.title, advisory.area);
  writeData(data);
  return advisory;
}

export function createWorkOrder(portal: Portal, values: Record<string, FormDataEntryValue>): WorkOrder {
  const data = readData();
  const id = Date.now();
  const workOrder: WorkOrder = {
    id,
    reference: `${portal === "water" ? "WD" : "CE"}-WO-${id.toString(36).toUpperCase()}`,
    title: String(values.title ?? "").trim(),
    utility: portal === "water" ? "Water District" : "CEPALCO",
    area: String(values.area ?? "").trim(),
    status: "Scheduled",
    startsAt: String(values.startsAt ?? ""),
    endsAt: String(values.endsAt ?? ""),
    description: String(values.description ?? values.details ?? "").trim(),
  };
  data.workOrders.unshift(workOrder);
  if (portal === "water") {
    for (const account of data.accounts) {
      const actor = account.actor;
      if (actor.role === "resident" && actor.maintenanceAlerts && actor.phoneNumber) {
        data.virtualInbox.unshift({
          id: id + data.virtualInbox.length, recipientId: actor.id, recipient: actor.name, phoneNumber: actor.phoneNumber,
          utility: workOrder.utility, reference: workOrder.reference,
          body: `${workOrder.utility} maintenance scheduled for ${workOrder.area}: ${workOrder.title}`,
          createdAt: new Date().toISOString(), status: "Simulated", read: false,
        });
      }
    }
  }
  writeData(data);
  return workOrder;
}

export function updateAdvisory(id: number, status: Status): void {
  const data = readData();
  const advisory = data.advisories.find(item => item.id === id);
  if (!advisory) throw new Error("Advisory not found.");
  advisory.status = status;
  writeData(data);
}

export function updateReport(id: number, status: Status): void {
  const data = readData();
  const report = data.reports.find(item => item.id === id);
  if (!report) throw new Error("Report not found.");
  report.status = status;
  writeData(data);
}

export function markVirtualInboxRead(id: number): void {
  const data = readData();
  const message = data.virtualInbox.find(item => item.id === id);
  if (!message) throw new Error("Virtual inbox message not found.");
  message.read = true;
  writeData(data);
}

export function getVirtualInbox(portal: Portal) {
  const messages = readData().virtualInbox;
  const actor = getActor(portal);
  return actor?.role === "resident" ? messages.filter(message => message.recipientId === actor.id) : messages;
}

export function signOut(portal: Portal): void {
  localStorage.removeItem(`civicalert:${portal}:account`);
}
