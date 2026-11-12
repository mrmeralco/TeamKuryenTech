/**
 * SmartWatts Personal (Tier 1) private data.
 *
 * Stored under users/{uid}/... in Firestore, readable only by that user
 * (see firestore.rules). Tenants keep appliances, schedules, and savings
 * plans here, so landlords can never access them. Without Firebase
 * configuration, data is kept on this device only (localStorage).
 */
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc,
} from "firebase/firestore";
import { ensureUser } from "../apiAuth";
import { auth, firestore } from "../firebase";
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
export interface PersonalUserProfile {
  displayName: string | null;
  preferredLanguage: string | null;
  dwellingType: "homeowner" | "condo_apartment" | null;
  utilityRecordType: "meralco_bill" | "condo_soa" | "submeter_slip" | null;
  baselineKwh: number | null;
  baselinePeriodEnd: string | null;
}
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

// ------------------------------------------------------------------ profile
// users/{uid}: { preferredLanguage, displayName?, createdAt, updatedAt } — no tier or role fields.
const LANGUAGE_CODE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

/** Save the language preference for the signed-in user. Never creates an account just for this. */
export async function savePreferredLanguage(language: string): Promise<boolean> {
  const user = auth?.currentUser;
  if (!firestore || !user || !LANGUAGE_CODE.test(language)) return false;
  await setDoc(doc(firestore, "users", user.uid), { preferredLanguage: language, updatedAt: serverTimestamp() }, { merge: true });
  return true;
}

export async function saveUserProfile(profile: {
  displayName?: string;
  preferredLanguage?: string;
  dwellingType?: "homeowner" | "condo_apartment";
  utilityRecordType?: "meralco_bill" | "condo_soa" | "submeter_slip";
  baselineKwh?: number;
  baselinePeriodEnd?: string;
}): Promise<boolean> {
  const user = auth?.currentUser;
  if (!firestore || !user) return false;
  const data: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (profile.displayName && typeof profile.displayName === "string") {
    data.displayName = profile.displayName.trim().slice(0, 100);
  }
  if (profile.preferredLanguage && LANGUAGE_CODE.test(profile.preferredLanguage)) {
    data.preferredLanguage = profile.preferredLanguage;
  }
  if (profile.dwellingType) {
    if (!["homeowner", "condo_apartment"].includes(profile.dwellingType)) throw new RangeError("Choose a valid home setup.");
    data.dwellingType = profile.dwellingType;
  }
  if (profile.utilityRecordType) {
    if (!["meralco_bill", "condo_soa", "submeter_slip"].includes(profile.utilityRecordType)) throw new RangeError("Choose a valid utility record source.");
    data.utilityRecordType = profile.utilityRecordType;
  }
  if (profile.dwellingType || profile.utilityRecordType) {
    if (!profile.dwellingType || !profile.utilityRecordType
      || (profile.dwellingType === "homeowner" && profile.utilityRecordType !== "meralco_bill")
      || (profile.dwellingType === "condo_apartment" && profile.utilityRecordType === "meralco_bill")) {
      throw new RangeError("Choose a utility record source that matches your home setup.");
    }
  }
  if (profile.baselineKwh !== undefined || profile.baselinePeriodEnd !== undefined) {
    if (!Number.isFinite(profile.baselineKwh) || profile.baselineKwh! <= 0 || profile.baselineKwh! > 1_000_000) throw new RangeError("Enter a valid baseline monthly consumption.");
    if (!profile.baselinePeriodEnd || !/^\d{4}-\d{2}-\d{2}$/.test(profile.baselinePeriodEnd)) throw new RangeError("Choose the baseline billing period end date.");
    data.baselineKwh = profile.baselineKwh;
    data.baselinePeriodEnd = profile.baselinePeriodEnd;
  }
  await setDoc(doc(firestore, "users", user.uid), data, { merge: true });
  return true;
}

/** Create a basic profile only when one is missing; existing user choices are preserved. */
export async function ensureUserProfile(profile: { displayName?: string | null; preferredLanguage?: string }): Promise<boolean> {
  const user = auth?.currentUser;
  if (!firestore || !user) return false;
  const profileRef = doc(firestore, "users", user.uid);
  const snapshot = await getDoc(profileRef);
  if (snapshot.exists()) return true;
  const preferredLanguage = profile.preferredLanguage && LANGUAGE_CODE.test(profile.preferredLanguage)
    ? profile.preferredLanguage
    : "en";
  const data: Record<string, unknown> = {
    preferredLanguage,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const displayName = profile.displayName?.trim();
  if (displayName) data.displayName = displayName.slice(0, 100);
  await setDoc(profileRef, data);
  return true;
}

export async function loadUserProfile(): Promise<PersonalUserProfile | null> {
  const user = auth?.currentUser;
  if (!firestore || !user) return null;
  const snapshot = await getDoc(doc(firestore, "users", user.uid));
  const data = snapshot.data();
  const dwellingType = data?.dwellingType === "homeowner" || data?.dwellingType === "condo_apartment" ? data.dwellingType : null;
  const utilityRecordType = data?.utilityRecordType === "meralco_bill" || data?.utilityRecordType === "condo_soa" || data?.utilityRecordType === "submeter_slip"
    ? data.utilityRecordType
    : null;
  const baselineKwh = typeof data?.baselineKwh === "number" && Number.isFinite(data.baselineKwh) && data.baselineKwh > 0 ? data.baselineKwh : null;
  const baselinePeriodEnd = typeof data?.baselinePeriodEnd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.baselinePeriodEnd)
    ? data.baselinePeriodEnd
    : null;
  return {
    displayName: (typeof data?.displayName === "string" ? data.displayName : null) || user.displayName || null,
    preferredLanguage: typeof data?.preferredLanguage === "string" && LANGUAGE_CODE.test(data.preferredLanguage) ? data.preferredLanguage : null,
    dwellingType,
    utilityRecordType,
    baselineKwh,
    baselinePeriodEnd,
  };
}

/** Read the signed-in user's saved language preference. */
export async function loadPreferredLanguage(): Promise<string | null> {
  return (await loadUserProfile())?.preferredLanguage ?? null;
}
