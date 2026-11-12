/**
 * SmartWatts Personal (Tier 1) private data.
 *
 * Stored under users/{uid}/... in Firestore, readable only by that user
 * (see firestore.rules). Tenants keep appliances, schedules, and savings
 * plans here, so landlords can never access them. Without Firebase
 * configuration, data is kept on this device only (localStorage).
 */
import {
  addDoc, collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc,
} from "firebase/firestore";
import { ensureUser } from "../apiAuth";
import { firestore } from "../firebase";
import { validateAppliance } from "./estimates";
import { validateComponents, type ChargeComponents } from "../billing/meralco";

export interface Appliance {
  id: string;
  name: string;
  category: string;
  watts: number;
  quantity: number;
  hoursPerDay: number;
  daysPerWeek: number;
  scheduleNote: string | null;
  brand?: string | null;
  model?: string | null;
  voltage?: string | null;
  source?: "ocr" | "manual" | "ai";
  testedKwhMonth?: number | null;
  energyEfficiencyRating?: number | null;
  labelType?: string | null;
  consumptionBasis?: string | null;
}

export interface PersonalBill {
  id: string;
  periodStart: string;
  periodEnd: string;
  kwh: number;
  amountCentavos: number;
  source: "ocr" | "manual";
  /** Optional itemized charges in centavos, one entry per category (no raw OCR text is stored). */
  components?: ChargeComponents | null;
  previousReading?: number | null;
  presentReading?: number | null;
}

export interface SavingsPlan {
  id: string;
  title: string;
  actions: { applianceId: string; applianceName: string; fromHours: number; toHours: number }[];
  monthlyKwhSaved: number;
  monthlySavingsCentavos: number;
  ratePerKwhCentavos: number;
}

type Kind = "appliances" | "bills" | "savingsPlans";
type Records = { appliances: Appliance; bills: PersonalBill; savingsPlans: SavingsPlan };
const LOCAL_KEY = "smartwatts-personal-v1";

export function storageMode(): "cloud" | "device" {
  return firestore ? "cloud" : "device";
}

function readLocal(): Partial<Record<Kind, unknown[]>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocal(data: Partial<Record<Kind, unknown[]>>): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
}

async function list<K extends Kind>(kind: K): Promise<Records[K][]> {
  if (!firestore) return (readLocal()[kind] ?? []) as Records[K][];
  const user = await ensureUser();
  const snapshot = await getDocs(collection(firestore, "users", user.uid, kind));
  return snapshot.docs
    .map((item) => ({ ...item.data({ serverTimestamps: "estimate" }), id: item.id }) as Records[K] & { createdAt?: { toMillis?: () => number } })
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0))
    .map(({ createdAt: _createdAt, ...rest }) => rest as unknown as Records[K]);
}

async function save<K extends Kind>(kind: K, record: Omit<Records[K], "id"> & { id?: string }): Promise<string> {
  const { id, ...data } = record;
  if (!firestore) {
    const all = readLocal();
    const items = (all[kind] ?? []) as Records[K][];
    const newId = id ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    const next = { ...data, id: newId } as Records[K];
    all[kind] = id ? items.map((item) => (item.id === id ? next : item)) : [...items, next];
    writeLocal(all);
    return newId;
  }
  const user = await ensureUser();
  const target = collection(firestore, "users", user.uid, kind);
  if (id) {
    await setDoc(doc(target, id), { ...data, createdAt: serverTimestamp(), ...(kind === "appliances" ? { updatedAt: serverTimestamp() } : {}) });
    return id;
  }
  return (await addDoc(target, { ...data, createdAt: serverTimestamp() })).id;
}

async function remove(kind: Kind, id: string): Promise<void> {
  if (!firestore) {
    const all = readLocal();
    all[kind] = (all[kind] ?? []).filter((item) => (item as { id: string }).id !== id);
    writeLocal(all);
    return;
  }
  const user = await ensureUser();
  await deleteDoc(doc(firestore, "users", user.uid, kind, id));
}

export const listAppliances = () => list("appliances");
export const listBills = () => list("bills");
export const listSavingsPlans = () => list("savingsPlans");
export const deleteAppliance = (id: string) => remove("appliances", id);
export const deleteBill = (id: string) => remove("bills", id);
export const deleteSavingsPlan = (id: string) => remove("savingsPlans", id);

export function saveAppliance(input: Omit<Appliance, "id"> & { id?: string }): Promise<string> {
  validateAppliance(input);
  const name = input.name.trim();
  if (!name || name.length > 60) throw new RangeError("Appliance name must be 1 to 60 characters.");
  const scheduleNote = input.scheduleNote?.trim() || null;
  if (scheduleNote && scheduleNote.length > 200) throw new RangeError("Schedule note must be 200 characters or fewer.");
  const brand = input.brand?.trim() || null;
  const model = input.model?.trim() || null;
  const voltage = input.voltage?.trim() || null;
  const source = input.source || "manual";
  const testedKwhMonth = typeof input.testedKwhMonth === "number" && input.testedKwhMonth > 0 ? input.testedKwhMonth : null;
  const energyEfficiencyRating = typeof input.energyEfficiencyRating === "number" && input.energyEfficiencyRating > 0 ? input.energyEfficiencyRating : null;
  const labelType = input.labelType?.trim() || null;
  const consumptionBasis = input.consumptionBasis?.trim() || null;
  return save("appliances", {
    ...input,
    name,
    scheduleNote,
    category: input.category || "other",
    brand,
    model,
    voltage,
    source,
    testedKwhMonth,
    energyEfficiencyRating,
    labelType,
    consumptionBasis,
  });
}

export function saveBill(input: Omit<PersonalBill, "id">): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd) || input.periodEnd <= input.periodStart) {
    throw new RangeError("The billing period end must be after its start.");
  }
  if (!Number.isFinite(input.kwh) || input.kwh <= 0) throw new RangeError("Enter the billed kWh (greater than zero).");
  if (!Number.isInteger(input.amountCentavos) || input.amountCentavos < 0) throw new RangeError("Enter a valid peso amount.");
  const components = input.components && Object.keys(input.components).length ? input.components : null;
  if (components) validateComponents(components);
  const readings = [input.previousReading, input.presentReading];
  if (readings.some((r) => r !== null && r !== undefined && (!Number.isFinite(r) || r < 0))) throw new RangeError("Meter readings must be zero or greater.");
  if (typeof input.previousReading === "number" && typeof input.presentReading === "number" && input.presentReading < input.previousReading) {
    throw new RangeError("The present reading cannot be lower than the previous reading.");
  }
  return save("bills", {
    periodStart: input.periodStart, periodEnd: input.periodEnd, kwh: input.kwh, amountCentavos: input.amountCentavos, source: input.source,
    components, previousReading: input.previousReading ?? null, presentReading: input.presentReading ?? null,
  });
}

export function saveSavingsPlan(input: Omit<SavingsPlan, "id">): Promise<string> {
  if (!input.title.trim()) throw new RangeError("Give your plan a name.");
  return save("savingsPlans", { ...input, title: input.title.trim().slice(0, 80) });
}
