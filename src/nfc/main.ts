/**
 * Entry script for /nfc (nfc.html): the page an NFC card or its QR fallback opens.
 */
import { signOut } from "firebase/auth";
import { auth, firebaseConfigured } from "../lib/firebase";
import { hasPendingInvite } from "../lib/pendingInvite";
import { LOGIN_PATH, parsePropertyHint, roleLabel, type RentalMembership } from "../lib/nfcRouting";
import { goToLogin, openMembership, openPersonal, runNfcEntry, type NfcDeps, type NfcState } from "./controller";

const ICONS: Record<string, string> = {
  loader: `<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`,
  nfc: `<path d="M6 8.32a7.43 7.43 0 0 1 0 7.36"/><path d="M9.46 6.21a11.76 11.76 0 0 1 0 11.58"/><path d="M12.91 4.1a15.91 15.91 0 0 1 .01 15.8"/><path d="M16.37 2a20.16 20.16 0 0 1 0 20"/>`,
  login: `<path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>`,
  building: `<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>`,
  alert: `<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`,
  shield: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m14.5 9.5-5 5"/><path d="m9.5 9.5 5 5"/>`,
  offline: `<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>`,
  retry: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  home: `<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  check: `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  chevron: `<path d="m9 18 6-6-6-6"/>`,
};

function icon(name: keyof typeof ICONS, className = "nfc-icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  svg.innerHTML = ICONS[name]; // static, trusted markup
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function button(label: string, iconName: keyof typeof ICONS, onClick: () => void, variant = "primary"): HTMLButtonElement {
  const node = el("button", { type: "button", class: `nfc-btn nfc-btn-${variant}` }, icon(iconName, "nfc-btn-icon"), label);
  node.addEventListener("click", onClick);
  return node;
}

const root = document.getElementById("nfc-root") as HTMLElement;
const card = document.getElementById("nfc-card") as HTMLElement;

function signedInEmail(): string | null {
  return auth?.currentUser?.email ?? null;
}

async function switchAccount(): Promise<void> {
  try {
    if (auth) await signOut(auth);
  } finally {
    goToLogin(deps);
  }
}

function retry(): void {
  runNfcEntry(deps).catch(() => render({ name: "network-error", message: "SmartWatts could not open." }));
}

function progress(title: string, detail: string): Node[] {
  return [
    el("div", { class: "nfc-badge nfc-badge-busy" }, icon("loader", "nfc-icon nfc-spin")),
    el("h1", { id: "nfc-title" }, title),
    el("p", { class: "nfc-detail" }, detail),
  ];
}

function message(iconName: keyof typeof ICONS, tone: string, title: string, detail: string, ...actions: Node[]): Node[] {
  return [
    el("div", { class: `nfc-badge nfc-badge-${tone}` }, icon(iconName)),
    el("h1", { id: "nfc-title" }, title),
    el("p", { class: "nfc-detail" }, detail),
    el("div", { class: "nfc-actions" }, ...actions),
  ];
}

function chooser(memberships: RentalMembership[]): Node[] {
  const list = el("ul", { class: "nfc-list", "aria-labelledby": "nfc-title" });
  for (const membership of memberships) {
    const pending = membership.role !== "tenant" && membership.lifecycle && membership.lifecycle !== "active";
    const meta = el("span", { class: "nfc-item-meta" }, roleLabel(membership));
    if (pending) meta.append(el("span", { class: "nfc-chip" }, membership.lifecycle === "pending_activation" ? "Pending activation" : "Not active"));
    const item = el("button", { type: "button", class: "nfc-item" },
      icon(membership.role === "tenant" ? "home" : "building", "nfc-item-icon"),
      el("span", { class: "nfc-item-text" }, el("span", { class: "nfc-item-name" }, membership.propertyName), meta),
      icon("chevron", "nfc-item-chevron"));
    item.addEventListener("click", () => openMembership(deps, membership));
    list.append(el("li", {}, item));
  }
  return [
    el("div", { class: "nfc-badge" }, icon("building")),
    el("h1", { id: "nfc-title" }, "Choose a property"),
    el("p", { class: "nfc-detail" }, "Your account has access to more than one SmartWatts Rentals workspace."),
    list,
    el("div", { class: "nfc-actions" }, button("Open SmartWatts Personal", "home", () => openPersonal(deps), "ghost")),
  ];
}

function render(state: NfcState): void {
  let body: Node[];
  let alert = false;
  switch (state.name) {
    case "opening":
      body = progress("Opening SmartWatts", "Getting things ready…");
      break;
    case "checking-auth":
      body = progress("Checking your sign-in", "Restoring your SmartWatts session on this device…");
      break;
    case "checking-access":
      body = progress("Checking property access", "Confirming which property and unit you can open…");
      break;
    case "redirecting": {
      const m = state.membership;
      const where = !m ? "Opening your dashboard…"
        : m.role === "tenant" ? `Opening My Statements for ${m.propertyName}${m.unitLabel ? ` · ${m.unitLabel}` : ""}…`
        : `Opening the Owner Overview for ${m.propertyName}…`;
      body = [el("div", { class: "nfc-badge nfc-badge-ok" }, icon("check")), el("h1", { id: "nfc-title" }, "Redirecting to your dashboard"), el("p", { class: "nfc-detail" }, where)];
      break;
    }
    case "signin-required": {
      alert = state.reason === "expired";
      const title = state.reason === "expired" ? "Your session has expired" : state.reason === "unverified" ? "Verify your email to continue" : "Sign in required";
      const detail = state.reason === "expired"
        ? "Sign in again to open your SmartWatts Rentals dashboard. The card itself never signs you in."
        : "The SmartWatts card opens the app — your own sign-in decides what you can see. Taking you to sign in…";
      body = message("login", "warn", title, detail,
        state.reason === "expired" ? button("Sign in again", "login", () => void switchAccount()) : el("a", { class: "nfc-btn nfc-btn-primary", href: LOGIN_PATH }, icon("login", "nfc-btn-icon"), "Continue to sign in"));
      break;
    }
    case "no-membership": {
      const email = signedInEmail();
      body = message("building", "warn", "No Rentals access on this account",
        `${email ? `You're signed in as ${email}. ` : ""}This account isn't linked to a SmartWatts Rentals property yet. If your landlord sent you an invitation, open that invitation link to join, or ask them to invite this email.`,
        button("Open SmartWatts Personal", "home", () => openPersonal(deps)),
        button("Use a different account", "login", () => void switchAccount(), "ghost"));
      break;
    }
    case "choose":
      body = chooser(state.memberships);
      break;
    case "denied":
      alert = true;
      body = message("shield", "danger", "Access denied", "This account is not allowed to open that SmartWatts Rentals workspace.",
        button("Use a different account", "login", () => void switchAccount()),
        button("Open SmartWatts Personal", "home", () => openPersonal(deps), "ghost"));
      break;
    case "network-error":
      alert = true;
      body = message("offline", "danger", "Can't reach SmartWatts", `${state.message} Check your internet connection and try again.`,
        button("Retry", "retry", retry));
      break;
    case "unavailable":
      body = message("alert", "warn", "Sign-in isn't available here", "This SmartWatts build has no Firebase sign-in configured, so Rentals workspaces can't be opened from a card.",
        el("a", { class: "nfc-btn nfc-btn-primary", href: "/dashboard" }, icon("home", "nfc-btn-icon"), "Open dashboard"));
      break;
  }
  card.dataset.state = state.name;
  card.replaceChildren(...body);
  root.setAttribute("role", alert ? "alert" : "status");
  root.setAttribute("aria-busy", ["opening", "checking-auth", "checking-access", "redirecting"].includes(state.name) ? "true" : "false");
  const heading = card.querySelector<HTMLElement>("h1");
  if (heading && !["opening", "checking-auth", "checking-access"].includes(state.name)) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

const deps: NfcDeps = {
  configured: firebaseConfigured,
  async restoreUser() {
    if (!auth) return null;
    await auth.authStateReady();
    return auth.currentUser;
  },
  fetch: (input, init) => window.fetch(input, init),
  storage: (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })(),
  hasPendingInvite,
  hint: parsePropertyHint(window.location.search),
  redirect: (url) => window.location.replace(url),
  render,
};

retry();
