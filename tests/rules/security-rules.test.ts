// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { ref, uploadString, getBytes } from "firebase/storage";

let env: RulesTestEnvironment;

const appliance = {
  name: "Aircon",
  category: "cooling",
  watts: 1200,
  quantity: 1,
  hoursPerDay: 8,
  daysPerWeek: 7,
  scheduleNote: "Night only",
  createdAt: serverTimestamp(),
};

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-smartwatts",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
    storage: { rules: readFileSync("storage.rules", "utf8") },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe("Tier 1 personal data isolation", () => {
  it("lets a user manage only their own appliances, bills, plans, and readings", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "users/alice/appliances/a1"), appliance));
    await assertSucceeds(getDoc(doc(alice, "users/alice/appliances/a1")));
    await assertSucceeds(setDoc(doc(alice, "users/alice/bills/b1"), {
      periodStart: "2026-09-01", periodEnd: "2026-09-30", kwh: 210.5, amountCentavos: 245050, source: "ocr", createdAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(alice, "users/alice/savingsPlans/p1"), {
      title: "Cooler nights", actions: [{ applianceId: "a1", hoursPerDay: 6 }], monthlyKwhSaved: 73,
      monthlySavingsCentavos: 85000, ratePerKwhCentavos: 1164, createdAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(alice, "users/alice/readings/r1"), { kwh: 12, createdAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(doc(alice, "users/alice/appliances/a1")));
  });

  it("blocks landlords, other tenants, and anonymous visitors from private tenant data", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users/tenant/appliances/a1"), appliance);
      await setDoc(doc(context.firestore(), "users/tenant/savingsPlans/p1"), { title: "Plan" });
    });
    const landlord = env.authenticatedContext("landlord").firestore();
    await assertFails(getDoc(doc(landlord, "users/tenant/appliances/a1")));
    await assertFails(getDoc(doc(landlord, "users/tenant/savingsPlans/p1")));
    await assertFails(setDoc(doc(landlord, "users/tenant/appliances/a2"), appliance));
    await assertFails(deleteDoc(doc(landlord, "users/tenant/appliances/a1")));
    const unauthenticated = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthenticated, "users/tenant/appliances/a1")));
  });

  it("rejects invalid or unexpected personal fields", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "users/alice/appliances/a1"), { ...appliance, watts: -5 }));
    await assertFails(setDoc(doc(alice, "users/alice/appliances/a1"), { ...appliance, quantity: 1.5 }));
    await assertFails(setDoc(doc(alice, "users/alice/appliances/a1"), { ...appliance, tier: "rentals" }));
    await assertFails(setDoc(doc(alice, "users/alice/bills/b1"), {
      periodStart: "2026-09-30", periodEnd: "2026-09-01", kwh: 1, amountCentavos: 1, source: "manual", createdAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(alice, "users/alice/bills/b2"), {
      periodStart: "2026-09-01", periodEnd: "2026-09-30", kwh: 1, amountCentavos: 10.5, source: "manual", createdAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(alice, "users/alice/readings/r1"), { kwh: 0, createdAt: serverTimestamp() }));
    // Users cannot write a global tier/profile document that grants Rentals access.
    await assertFails(setDoc(doc(alice, "users/alice"), { tier: 2 }));
  });
});

describe("Tier 1 bill records (OCR data minimization)", () => {
  const base = { periodStart: "2026-09-12", periodEnd: "2026-10-11", kwh: 200, amountCentavos: 229600, source: "ocr" };

  it("accepts itemized charges in integer centavos and meter readings", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "users/alice/bills/b1"), {
      ...base, createdAt: serverTimestamp(), previousReading: 12045, presentReading: 12245,
      components: { generation: 140250, subsidies: -2455, taxes: 24843 },
    }));
  });

  it("rejects unknown categories, fractional centavos, and stored raw OCR text or identifiers", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "users/alice/bills/b2"), { ...base, createdAt: serverTimestamp(), components: { madeUp: 100 } }));
    await assertFails(setDoc(doc(alice, "users/alice/bills/b3"), { ...base, createdAt: serverTimestamp(), components: { generation: 10.5 } }));
    await assertFails(setDoc(doc(alice, "users/alice/bills/b4"), { ...base, createdAt: serverTimestamp(), rawText: "Customer Name: ..." }));
    await assertFails(setDoc(doc(alice, "users/alice/bills/b5"), { ...base, createdAt: serverTimestamp(), accountNumber: "123456789012" }));
    await assertFails(setDoc(doc(alice, "users/alice/bills/b6"), { ...base, createdAt: serverTimestamp(), presentReading: -1 }));
  });
});

describe("Tier 2 rental data is backend-only", () => {
  const rentalPaths = [
    "properties/p1",
    "properties/p1/units/u1",
    "properties/p1/meters/m1",
    "properties/p1/meterReadings/r1",
    "properties/p1/utilityBills/b1",
    "properties/p1/statements/s1",
    "properties/p1/auditLogs/l1",
    "memberships/p1_owner",
    "subscriptions/p1",
    "invitations/abc",
  ];

  it("denies all direct client reads and writes, even for the property owner", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      for (const path of rentalPaths) await setDoc(doc(context.firestore(), path), { ownerUid: "owner", tenantUid: "tenant" });
    });
    for (const uid of ["owner", "tenant", "stranger"]) {
      const db = env.authenticatedContext(uid, { firebase: { sign_in_provider: "password" } }).firestore();
      for (const path of rentalPaths) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { ownerUid: uid }));
      }
    }
  });

  it("does not let a client self-activate a subscription or forge membership", async () => {
    const owner = env.authenticatedContext("owner").firestore();
    await assertFails(setDoc(doc(owner, "subscriptions/p1"), { status: "active" }));
    await assertFails(setDoc(doc(owner, "memberships/p1_owner"), { role: "owner", status: "active" }));
  });
});

describe("Cloud Storage", () => {
  it("denies direct client uploads and downloads of bill documents", async () => {
    const storage = env.authenticatedContext("owner").storage();
    await assertFails(uploadString(ref(storage, "properties/p1/utilityBills/b1/doc"), "x"));
    await assertFails(uploadString(ref(storage, "users/owner/bill.png"), "x"));
    await assertFails(getBytes(ref(storage, "properties/p1/utilityBills/b1/doc")));
  });
});
