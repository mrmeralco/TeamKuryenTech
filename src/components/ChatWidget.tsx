import { useEffect, useState, type FormEvent } from "react";
import { Bot, Languages, MessageCircle, Send, X } from "lucide-react";
import { Button } from "./ui/button";
import { getIdToken } from "../lib/apiAuth";
import { translateTexts, type TranslationLanguage } from "../lib/translationClient";
import { buildAdvisorContext } from "../lib/personal/advisorContext";
import { STATIC_CHAT_LABELS, STATIC_LANGUAGES } from "../lib/i18n/dictionaries";

type Language = string;
type Grounding = { validated: boolean; facts: string[]; assumptions: string[] };
type Message = { role: "user" | "assistant"; text: string; grounding?: Grounding };
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

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<Language>(getSavedLanguage);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [useMyData, setUseMyData] = useState(true);
  const [availableLanguages, setAvailableLanguages] = useState(defaultLanguages);
  const [remoteLabels, setRemoteLabels] = useState<{ language: string; copy: ChatCopy } | null>(null);
  const baseCopy = localLabels[language] ?? labels.en;
  const copy = localLabels[language]
    ? baseCopy
    : remoteLabels?.language === language ? remoteLabels.copy : baseCopy;
  const conversation = messages.length ? messages : [{ role: "assistant" as const, text: copy.greeting }];

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

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = text.trim();
    if (!prompt || busy) return;
    const nextMessages = [...messages, { role: "user" as const, text: prompt }];
    setMessages(nextMessages);
    setText("");
    setBusy(true);
    try {
      const token = await getIdToken();
      const context = useMyData ? await buildAdvisorContext().catch(() => null) : null;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          language,
          messages: nextMessages.slice(-12).map(({ role, text: messageText }) => ({ role, text: messageText })),
          ...(context ? { context } : {}),
        }),
      });
      const data: { reply?: string; detail?: string; validated?: boolean; facts?: string[]; assumptions?: string[] } = await response.json();
      if (!response.ok || !data.reply) throw new Error(data.detail ?? copy.error);
      setMessages((current) => [...current, {
        role: "assistant",
        text: data.reply!,
        grounding: { validated: data.validated !== false, facts: data.facts ?? [], assumptions: data.assumptions ?? [] },
      }]);
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        text: error instanceof Error ? error.message : copy.error,
      }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-24 right-3 z-50 sm:bottom-6 sm:right-6">
      {open && (
        <section
          aria-label={copy.title}
          className="mb-3 flex h-[min(34rem,calc(100dvh-8rem))] w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-[#ffc700] bg-white shadow-2xl"
        >
          <header className="flex items-center justify-between bg-[#fff4cc] px-4 py-4 text-slate-800">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[#ff7a00] text-white"><Bot size={21} /></span>
              <div><h2 className="font-display font-semibold">{copy.title}</h2><p className="text-xs text-slate-600">{copy.subtitle}</p></div>
            </div>
            <Button variant="ghost" size="icon" className="text-slate-600 hover:bg-white/70 hover:text-[#ff7a00]" aria-label={copy.closeChat} onClick={() => setOpen(false)}><X size={20} /></Button>
          </header>
          <div className="flex items-center justify-end gap-2 border-b border-[#fff4cc] px-3 py-2 text-xs text-slate-600">
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
          <div className="flex-1 space-y-3 overflow-y-auto bg-[#fffaf0] p-3" role="log" aria-live="polite">
            {conversation.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-sm leading-relaxed ${message.role === "user" ? "ml-auto bg-[#fff0bf] text-slate-800" : "bg-white text-slate-700 shadow-sm"}`}>
                {message.text}
                {message.grounding && (message.grounding.facts.length > 0 || !message.grounding.validated) && (
                  <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                    <p>{message.grounding.validated ? `✓ ${copy.figuresVerified}` : `⚠ ${copy.figuresWithheld}`}</p>
                    {message.grounding.facts.length > 0 && (
                      <details>
                        <summary className="cursor-pointer">{copy.showFigures}</summary>
                        <ul className="mt-1 list-disc pl-4">{[...message.grounding.facts, ...message.grounding.assumptions].map((item) => <li key={item}>{item}</li>)}</ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="w-fit rounded-2xl bg-white px-3 py-2 text-sm text-slate-500">{copy.thinking}</div>}
          </div>
          <label className="flex items-start gap-2 border-t border-[#fff4cc] px-3 pt-2 text-[11px] text-slate-600">
            <input type="checkbox" checked={useMyData} onChange={(event) => setUseMyData(event.target.checked)} className="mt-0.5" />
            <span>{copy.useMyData}</span>
          </label>
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
