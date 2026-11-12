import { useEffect, useState, type FormEvent } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { Bot, Languages, MessageCircle, Send, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { getIdToken } from "../lib/apiAuth";
import { auth } from "../lib/firebase";
import { translateTexts, type TranslationLanguage } from "../lib/translationClient";
import { STATIC_CHAT_LABELS, STATIC_LANGUAGES } from "../lib/i18n/dictionaries";
import { coinBalanceCents, getMonthlyEnergyTarget } from "../../game.js";
import "./ChatWidget.css";

type Language = string;
type Fact = { id: string; text: string; kind: string; kindLabel: string; source: string };
type Grounding = {
  validated: boolean;
  mode: "ai" | "deterministic" | "refusal";
  facts: Fact[];
  assumptions: string[];
  missing: string[];
  sources: string[];
  followUps: string[];
  recordsUsed: boolean;
  retrieval: "ok" | "partial_error";
  scopeHint?: { switchTo: "personal"; personalBillCount: number } | null;
  diagnostics?: Record<string, unknown> | null;
};
type Message = { role: "user" | "assistant"; text: string; grounding?: Grounding };
type WorkspaceDetail = { type: "personal" | "owner" | "tenant"; role?: string; propertyId?: string; propertyName?: string; unitLabel?: string };

// Conversations are kept per user + workspace + property in this tab only (sessionStorage), so
// switching workspace or account never shows another context's history. Nothing is stored server-side.
const CHAT_STORE = "smartwatts-chat-v2";
const scopeKey = (uid: string | null, ws: WorkspaceDetail) => `${uid ?? "signed-out"}|${ws.type}|${ws.propertyId ?? "-"}`;

function readConversations(): Record<string, Message[]> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CHAT_STORE) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeConversation(key: string, messages: Message[]) {
  try {
    const all = readConversations();
    if (messages.length) all[key] = messages.slice(-24);
    else delete all[key];
    sessionStorage.setItem(CHAT_STORE, JSON.stringify(all));
  } catch {
    // History is a convenience; the chat still works without storage.
  }
}

function currentWorkspace(): WorkspaceDetail {
  const cached = (window as unknown as { __smartwattsWorkspace?: WorkspaceDetail }).__smartwattsWorkspace;
  return cached && typeof cached === "object" ? cached : { type: "personal" };
}

function browserState() {
  // Coins and goals live only in this browser; the server labels them as unverified.
  try {
    return { coinBalanceCents: coinBalanceCents(), monthlyTargetKwh: getMonthlyEnergyTarget() };
  } catch {
    return undefined;
  }
}
type ChatCopy = {
  title: string;
  subtitle: string;
  greeting: string;
  placeholder: string;
  send: string;
  thinking: string;
  error: string;
  disclaimer: string;
  language: string;
  messageLabel: string;
  closeChat: string;
  open: string;
  close: string;
  useMyData: string;
  figuresVerified: string;
  figuresWithheld: string;
  showFigures: string;
};

const labels = {
  en: {
    title: "SmartWatts Assistant",
    subtitle: "Ask about saving energy",
    greeting: "Hi! I’m your SmartWatts assistant. Ask me for energy-saving tips.",
    placeholder: "Type your message...",
    send: "Send",
    thinking: "Thinking...",
    error: "Sorry, I couldn't get a reply. Please try again.",
    disclaimer: "AI answers may be inaccurate. Don't share personal or account information.",
    language: "Language",
    messageLabel: "Message",
    closeChat: "Close chat",
    open: "Chat with us",
    close: "Close",
    useMyData: "Use my own appliance and bill figures (never shared with landlords)",
    figuresVerified: "Figures checked against SmartWatts calculations",
    figuresWithheld: "The AI reply contained unverified figures, so SmartWatts shows its own calculation instead.",
    showFigures: "Calculated figures and assumptions",
  },
  tl: {
    title: "Katulong ng SmartWatts",
    subtitle: "Magtanong tungkol sa pagtitipid ng enerhiya",
    greeting: "Kumusta! Ako ang SmartWatts assistant. Magtanong tungkol sa mga tipid-enerhiyang gawain.",
    placeholder: "I-type ang iyong mensahe...",
    send: "Ipadala",
    thinking: "Sandali lang...",
    error: "Paumanhin, hindi ako nakasagot. Subukan muli.",
    disclaimer: "Maaaring hindi laging tama ang sagot ng AI. Huwag magbahagi ng personal o account na impormasyon.",
    language: "Wika",
    messageLabel: "Mensahe",
    closeChat: "Isara ang chat",
    open: "Makipag-chat",
    close: "Isara",
    useMyData: "Gamitin ang sarili kong datos ng appliance at bill (hindi ibinabahagi sa landlord)",
    figuresVerified: "Sinuri ang mga numero laban sa kalkulasyon ng SmartWatts",
    figuresWithheld: "May hindi beripikadong numero ang sagot ng AI, kaya ipinapakita ng SmartWatts ang sarili nitong kalkulasyon.",
    showFigures: "Mga kinalkulang numero at palagay",
  },
} satisfies Record<"en" | "tl", ChatCopy>;

const localLabels: Record<string, ChatCopy> = { ...(STATIC_CHAT_LABELS as Record<string, ChatCopy>), ...labels };

const defaultLanguages: TranslationLanguage[] = [
  { code: "en", name: "English" },
  { code: "tl", name: "Tagalog" },
  ...STATIC_LANGUAGES,
];

function getSavedLanguage(): Language {
  try {
    const language = localStorage.getItem("smartwatts-language");
    return language && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language) ? language : "en";
  } catch {
    return "en";
  }
}

const EXTRA = {
  personalLabel: "SmartWatts Personal",
  rentalsLabel: "SmartWatts Rentals",
  yourUnit: "Your Unit",
  sources: "Sources",
  missing: "Missing information",
  tryAsking: "Try asking",
  clear: "Clear conversation",
  readOnly: "Read-only: the assistant can't change your records.",
  deterministic: "Answered directly from your SmartWatts records.",
  noRecords: "No matching saved records were found — see what's missing below.",
  partialError: "Some records couldn't be loaded, so this answer may be incomplete.",
  switchPersonal: "Switch to SmartWatts Personal",
  diagnostics: "Developer diagnostics",
  greetingPersonal: "Hi! I can answer questions using your own appliances, bills, and savings scenarios.",
  greetingOwner: "Hi! I can answer questions about this property's meters, readings, bills, statements, and subscription.",
  greetingTenant: "Hi! I can explain your unit's metering and the statements your landlord has published.",
};
const STARTERS: Record<WorkspaceDetail["type"], string[]> = {
  personal: ["Which of my appliances uses the most electricity?", "How did my bill change compared with the previous one?"],
  owner: ["Which units have missing meter readings?", "What is the status of my rental subscription?"],
  tenant: ["Why is my statement higher than last month?", "How is my unit's electricity measured?"],
};

function contextLabel(ws: WorkspaceDetail) {
  if (ws.type === "personal") return EXTRA.personalLabel;
  const name = ws.propertyName ? ` — ${ws.propertyName}` : "";
  return ws.type === "tenant" ? `${EXTRA.rentalsLabel}${name} · ${EXTRA.yourUnit}${ws.unitLabel ? ` ${ws.unitLabel}` : ""}` : `${EXTRA.rentalsLabel}${name}`;
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<Language>(getSavedLanguage);
  const [workspace, setWorkspace] = useState<WorkspaceDetail>(currentWorkspace);
  const [uid, setUid] = useState<string | null>(() => auth?.currentUser?.uid ?? null);
  const scope = scopeKey(uid, workspace);
  const [messages, setMessagesState] = useState<Message[]>(() => readConversations()[scopeKey(auth?.currentUser?.uid ?? null, currentWorkspace())] ?? []);
  const setMessages = (update: Message[] | ((current: Message[]) => Message[])) => {
    setMessagesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      writeConversation(scope, next);
      return next;
    });
  };
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Question to re-ask after the user accepts a scope switch (e.g. Rentals → Personal).
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [availableLanguages, setAvailableLanguages] = useState(defaultLanguages);
  const [remoteLabels, setRemoteLabels] = useState<{ language: string; copy: ChatCopy } | null>(null);
  const baseCopy = localLabels[language] ?? labels.en;
  const copy = localLabels[language]
    ? baseCopy
    : remoteLabels?.language === language ? remoteLabels.copy : baseCopy;
  const greeting = workspace.type === "owner" ? EXTRA.greetingOwner : workspace.type === "tenant" ? EXTRA.greetingTenant : EXTRA.greetingPersonal;
  const conversation = messages.length ? messages : [{ role: "assistant" as const, text: language === "en" ? greeting : copy.greeting }];

  // Switching account, workspace, or property swaps to that scope's own (possibly empty) history.
  useEffect(() => {
    setMessagesState(readConversations()[scope] ?? []);
  }, [scope]);

  useEffect(() => {
    const onWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceDetail>).detail;
      if (detail && typeof detail === "object") setWorkspace(detail);
    };
    window.addEventListener("smartwatts-workspace-changed", onWorkspace);
    const unsubscribe = auth ? onAuthStateChanged(auth, (user) => setUid(user && !user.isAnonymous ? user.uid : null)) : undefined;
    return () => {
      window.removeEventListener("smartwatts-workspace-changed", onWorkspace);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const handleLanguageChange = (event: Event) => {
      const selected = (event as CustomEvent<Language>).detail;
      setLanguage(typeof selected === "string" ? selected : "en");
    };
    const handleLanguagesLoaded = (event: Event) => {
      const languages = (event as CustomEvent<TranslationLanguage[]>).detail;
      if (Array.isArray(languages) && languages.length) setAvailableLanguages(languages);
    };
    window.addEventListener("smartwatts-language-change", handleLanguageChange);
    window.addEventListener("smartwatts-languages-loaded", handleLanguagesLoaded);
    return () => {
      window.removeEventListener("smartwatts-language-change", handleLanguageChange);
      window.removeEventListener("smartwatts-languages-loaded", handleLanguagesLoaded);
    };
  }, []);

  useEffect(() => {
    if (localLabels[language]) {
      setRemoteLabels(null);
      return;
    }

    let active = true;
    const englishLabels = Object.values(labels.en);
    translateTexts(language, englishLabels)
      .then((translated) => {
        if (active) {
          setRemoteLabels({
            language,
            copy: Object.fromEntries(
              Object.keys(labels.en).map((key, index) => [key, translated[index]]),
            ) as ChatCopy,
          });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          const message = error instanceof Error ? error.message : "Chat translation failed.";
          window.dispatchEvent(new CustomEvent("smartwatts-translation-error", { detail: message }));
        }
      });

    return () => {
      active = false;
    };
  }, [language]);

  async function ask(prompt: string, base: Message[] = messages) {
    if (!prompt || busy) return;
    const nextMessages = [...base, { role: "user" as const, text: prompt }];
    setMessages(nextMessages);
    setText("");
    setBusy(true);
    try {
      const token = await getIdToken();
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          language,
          // The property is a UI selection only; the server checks the caller's membership.
          workspace: workspace.type === "personal" ? { type: "personal" } : { type: "rental", propertyId: workspace.propertyId },
          messages: nextMessages.slice(-12).map(({ role, text: messageText }) => ({ role, text: messageText })),
          ...(workspace.type === "personal" ? { browserState: browserState() } : {}),
        }),
      });
      let data: Partial<Grounding> & { reply?: string; detail?: string } = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok || !data.reply) {
        throw new Error(response.status === 429 ? (data.detail ?? copy.error)
          : response.status >= 500 && !data.detail ? "The SmartWatts assistant is unavailable right now. Please try again shortly." : data.detail ?? copy.error);
      }
      setMessages((current) => [...current, {
        role: "assistant",
        text: data.reply!,
        grounding: {
          validated: data.validated !== false, mode: data.mode ?? "ai", facts: data.facts ?? [], assumptions: data.assumptions ?? [],
          missing: data.missing ?? [], sources: data.sources ?? [], followUps: data.followUps ?? [],
          recordsUsed: data.recordsUsed === true, retrieval: data.retrieval ?? "ok", scopeHint: data.scopeHint ?? null,
          diagnostics: data.diagnostics ?? null,
        },
      }]);
    } catch (error) {
      const offline = error instanceof TypeError;
      setMessages((current) => [...current, {
        role: "assistant",
        text: offline ? "I couldn't reach SmartWatts. Check your connection and try again." : error instanceof Error ? error.message : copy.error,
      }]);
    } finally {
      setBusy(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(text.trim());
  }

  useEffect(() => {
    if (pendingQuestion && workspace.type === "personal" && !busy) {
      const question = pendingQuestion;
      setPendingQuestion(null);
      // Start from the NEW scope's own stored history so nothing from the previous workspace leaks in.
      void ask(question, readConversations()[scope] ?? []);
    }
    // ask() is recreated each render; re-run only when the scope actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, pendingQuestion]);

  const lastGrounding = [...messages].reverse().find((message) => message.grounding)?.grounding;
  const suggestions = !messages.length ? STARTERS[workspace.type] : lastGrounding?.followUps ?? [];

  return (
    <div className="smartwatts-chat-widget">
      {open && (
        <section
          aria-label={copy.title}
          className="smartwatts-chat-panel flex flex-col overflow-hidden rounded-3xl border border-[#ffc700] bg-white shadow-2xl"
        >
          <header className="flex items-center justify-between bg-[#fff4cc] px-4 py-4 text-slate-800">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[#ff7a00] text-white"><Bot size={21} /></span>
              <div className="min-w-0"><h2 className="font-display font-semibold">{copy.title}</h2>
                <p className="text-xs text-slate-600">{copy.subtitle}</p>
                <p className="smartwatts-chat-context text-[11px]" data-testid="chat-context" translate="no">{contextLabel(workspace)}</p></div>
            </div>
            <Button variant="ghost" size="icon" className="text-slate-600 hover:bg-white/70 hover:text-[#ff7a00]" aria-label={copy.closeChat} onClick={() => setOpen(false)}><X size={20} /></Button>
          </header>
          <div className="flex items-center justify-end gap-2 border-b border-[#fff4cc] px-3 py-2 text-xs text-slate-600">
            {messages.length > 0 && (
              <button type="button" className="mr-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-[#fff4cc]" onClick={() => setMessages([])}>
                <Trash2 size={13} /> {EXTRA.clear}
              </button>
            )}
            <Languages size={15} />
            <label htmlFor="chat-language">{copy.language}</label>
            <select
              id="chat-language"
              value={language}
              onChange={(event) => {
                const nextLanguage = event.target.value;
                setLanguage(nextLanguage);
                try {
                  localStorage.setItem("smartwatts-language", nextLanguage);
                } catch {
                  // Keep the language change active for this page session.
                }
                window.dispatchEvent(new CustomEvent("smartwatts-language-change", { detail: nextLanguage }));
              }}
              className="rounded-lg border border-[#ffc700] bg-white px-2 py-1.5"
            >
              {availableLanguages.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
            </select>
          </div>
          <div className="smartwatts-chat-messages flex-1 space-y-3 overflow-y-auto bg-[#fffaf0] p-3" role="log" aria-live="polite">
            {conversation.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-sm leading-relaxed ${message.role === "user" ? "ml-auto bg-[#fff0bf] text-slate-800" : "bg-white text-slate-700 shadow-sm"}`}>
                {message.text}
                {message.grounding && (message.grounding.facts.length > 0 || message.grounding.missing.length > 0 || !message.grounding.validated) && (
                  <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                    <p data-testid="chat-grounding-status">{!message.grounding.validated ? `⚠ ${copy.figuresWithheld}`
                      : message.grounding.retrieval === "partial_error" ? `⚠ ${EXTRA.partialError}`
                      : !message.grounding.recordsUsed ? `ℹ ${EXTRA.noRecords}`
                      : message.grounding.mode === "deterministic" ? `✓ ${EXTRA.deterministic}` : `✓ ${copy.figuresVerified}`}</p>
                    {message.grounding.scopeHint?.switchTo === "personal" && (
                      <button type="button" className="smartwatts-chat-switch" onClick={() => {
                        const lastQuestion = [...messages].reverse().find((item) => item.role === "user")?.text ?? null;
                        setPendingQuestion(lastQuestion);
                        window.dispatchEvent(new CustomEvent("smartwatts-request-workspace", { detail: { type: "personal" } }));
                      }}>{EXTRA.switchPersonal}</button>
                    )}
                    {message.grounding.facts.length > 0 && (
                      <details>
                        <summary className="cursor-pointer">{copy.showFigures}</summary>
                        <ul className="mt-1 space-y-1 pl-0">
                          {message.grounding.facts.map((fact) => (
                            <li key={fact.id} className="list-none">
                              <span className={`smartwatts-fact-kind kind-${fact.kind}`}>{fact.kindLabel}</span> {fact.text}
                              <span className="block text-[10px] text-slate-400">{fact.source}</span>
                            </li>
                          ))}
                          {message.grounding.assumptions.map((item) => <li key={item} className="list-none italic">{item}</li>)}
                        </ul>
                      </details>
                    )}
                    {message.grounding.missing.length > 0 && (
                      <details open={message.grounding.facts.length === 0}>
                        <summary className="cursor-pointer">{EXTRA.missing}</summary>
                        <ul className="mt-1 list-disc pl-4">{message.grounding.missing.map((item) => <li key={item}>{item}</li>)}</ul>
                      </details>
                    )}
                    {message.grounding.diagnostics && (
                      <details>
                        <summary className="cursor-pointer">{EXTRA.diagnostics}</summary>
                        <pre className="whitespace-pre-wrap text-[10px]">{JSON.stringify(message.grounding.diagnostics, null, 1)}</pre>
                      </details>
                    )}
                    {message.grounding.sources.length > 0 && (
                      <details>
                        <summary className="cursor-pointer">{EXTRA.sources}</summary>
                        <ul className="mt-1 list-disc pl-4">{message.grounding.sources.map((item) => <li key={item}>{item}</li>)}</ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="w-fit rounded-2xl bg-white px-3 py-2 text-sm text-slate-500">{copy.thinking}</div>}
            {!busy && suggestions.length > 0 && (
              <div className="smartwatts-chat-suggestions" aria-label={EXTRA.tryAsking}>
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => void ask(suggestion)}>{suggestion}</button>
                ))}
              </div>
            )}
          </div>
          <p className="border-t border-[#fff4cc] px-3 pt-2 text-[11px] text-slate-600">{EXTRA.readOnly}</p>
          <form onSubmit={sendMessage} className="flex items-end gap-2 p-3">
            <label className="sr-only" htmlFor="chat-message">{copy.messageLabel}</label>
            <textarea id="chat-message" value={text} onChange={(event) => setText(event.target.value)} placeholder={copy.placeholder} maxLength={2000} rows={1} className="max-h-24 min-h-10 flex-1 resize-y rounded-xl border border-[#ffc700] px-3 py-2 text-sm outline-none focus:border-[#ff7a00] focus:ring-2 focus:ring-[#fff0bf]" />
            <Button size="icon" type="submit" disabled={busy || !text.trim()} aria-label={copy.send}><Send size={17} /></Button>
          </form>
          <p className="px-3 pb-3 text-[10px] leading-snug text-slate-400">{copy.disclaimer}</p>
        </section>
      )}
        <Button onClick={() => setOpen((value) => !value)} className="h-12 rounded-full px-5 shadow-lg" aria-expanded={open} aria-label={open ? copy.close : copy.open}>
        {open ? <X size={19} /> : <MessageCircle size={19} />}
          {open ? copy.close : copy.open}
      </Button>
    </div>
  );
}
