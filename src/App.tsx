import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity, BadgeDollarSign, Bell, ChartNoAxesColumnIncreasing, ChartPie,
  Check, ChevronDown, CircleHelp, CreditCard, Download, FileText,
  Flame, Gauge, History, LayoutDashboard, Lightbulb, Menu, MessageCircleQuestion,
  PlugZap, Radio, Receipt, Settings, Snowflake, Target, TrendingUp,
  Trophy, UserRoundCog, UsersRound, X, Zap, type LucideIcon,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import ChatWidget from "./components/ChatWidget";
import OcrEntry from "./components/OcrEntry";
import { Button } from "./components/ui/button";
import { Card, CardTitle } from "./components/ui/card";
import { auth, firebaseConfigured } from "./lib/firebase";
import { calculateEnergySummary } from "./lib/calculations";
import { watchUsageRecords, type UsageRecord } from "./lib/firestore";

type PageId = "dashboard" | "realtime" | "history" | "breakdown" | "devices" | "goals" | "rewards" | "billing" | "bills" | "rates" | "notifications" | "account" | "support" | "about";
type NavigationItem = { id: PageId; label: string; icon: LucideIcon };

const navigation: { label: string; items: NavigationItem[] }[] = [
  { label: "MONITOR", items: [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "realtime", label: "Real-time Monitor", icon: Activity },
    { id: "history", label: "Usage History", icon: History },
    { id: "breakdown", label: "Analytics", icon: ChartNoAxesColumnIncreasing },
    { id: "devices", label: "Device Monitor", icon: PlugZap },
  ] },
  { label: "SAVE & EARN", items: [
    { id: "goals", label: "Energy Goals", icon: Target },
    { id: "rewards", label: "Rewards & Badges", icon: Trophy },
  ] },
  { label: "BILLING", items: [
    { id: "billing", label: "Billing & Payments", icon: CreditCard },
    { id: "bills", label: "Bill History", icon: FileText },
    { id: "rates", label: "Rates Overview", icon: BadgeDollarSign },
  ] },
  { label: "SETTINGS", items: [
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "account", label: "Account Settings", icon: UserRoundCog },
    { id: "support", label: "Help & Support", icon: MessageCircleQuestion },
  ] },
  { label: "MORE", items: [{ id: "about", label: "About Team", icon: UsersRound }] },
];

const pageCopy: Record<PageId, [string, string]> = {
  dashboard: ["Good morning, energy saver!", "Here's what's happening with your electricity today."],
  realtime: ["Real-time Monitor", "Track your electricity usage as it happens."],
  history: ["Usage History", "Review and compare your past electricity consumption."],
  breakdown: ["Analytics", "Understand where your electricity is being consumed."],
  devices: ["Device Monitor", "Monitor connected appliances and their energy usage."],
  goals: ["Energy Goals", "Build better habits and track your household energy targets."],
  rewards: ["Rewards & Badges", "Celebrate the small steps that help you use energy wisely."],
  billing: ["Billing & Payments", "Review your estimated bill and payment details."],
  bills: ["Bill History", "View your previous statements and payments."],
  rates: ["Rates Overview", "Understand your electricity rate and charges."],
  notifications: ["Notifications", "Stay updated with usage alerts and account activity."],
  account: ["Account Settings", "Manage your profile and account preferences."],
  support: ["Help & Support", "Find answers or contact support."],
  about: ["About Team", "Meet the people and purpose behind SmartWatts."],
};

const sampleReadings = [342.18];
const usageTimeline = [
  { time: "12 AM", usage: 0.25 }, { time: "3 AM", usage: 0.16 }, { time: "6 AM", usage: 0.42 },
  { time: "9 AM", usage: 1.32 }, { time: "12 PM", usage: 0.88 }, { time: "3 PM", usage: 1.12 }, { time: "6 PM", usage: 0.62 },
];
const applianceUsage = [
  { name: "Air conditioning", value: 38, kwh: 129.23, color: "#ff7108" },
  { name: "Refrigerator", value: 22, kwh: 75.28, color: "#ffc43d" },
  { name: "Lighting", value: 15, kwh: 51.33, color: "#8e79f7" },
  { name: "Other", value: 25, kwh: 86.34, color: "#32b994" },
];
const monthlyUsage = [
  { month: "Jun", kwh: 289 }, { month: "Jul", kwh: 319 }, { month: "Aug", kwh: 304 },
  { month: "Sep", kwh: 325 }, { month: "Oct", kwh: 342 },
];
const devices = [
  { name: "Air Conditioner", usage: 129.23, percent: 38, icon: Snowflake, state: "Online" },
  { name: "Refrigerator", usage: 75.28, percent: 22, icon: PlugZap, state: "Online" },
  { name: "Lighting", usage: 51.33, percent: 15, icon: Lightbulb, state: "Online" },
  { name: "Washing Machine", usage: 32.18, percent: 9, icon: Activity, state: "Online" },
  { name: "Other devices", usage: 59.82, percent: 18, icon: PlugZap, state: "Standby" },
];
const sampleBills = [
  ["Oct 1–31, 2026", "342.18 kWh", "₱1,256.34", "Paid"],
  ["Sep 1–30, 2026", "325.00 kWh", "₱1,192.75", "Paid"],
  ["Aug 1–31, 2026", "304.42 kWh", "₱1,117.20", "Paid"],
];
const quests = [
  { id: "lights", title: "Switch off unused lights", points: 20, icon: "💡" },
  { id: "ac", title: "Set your AC to 25°C", points: 30, icon: "❄️" },
  { id: "standby", title: "Unplug idle devices", points: 15, icon: "🔌" },
];

function StatCard({ icon: Icon, label, value, caption, trend }: { icon: LucideIcon; label: string; value: string; caption: string; trend?: string }) {
  return (
    <Card className="flex min-h-32 items-center gap-4 p-4">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-orange-50 text-orange-600"><Icon size={22} /></span>
      <div className="min-w-0"><p className="text-xs font-bold text-slate-500">{label}</p><p className="mt-1 truncate font-display text-2xl font-semibold text-slate-900">{value}</p><p className="mt-1 text-[11px] text-slate-400">{caption} {trend && <span className="font-bold text-emerald-600">{trend}</span>}</p></div>
    </Card>
  );
}

function Panel({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <Card className={className}><CardTitle className="mb-4">{title}</CardTitle>{children}</Card>;
}

function UsageAreaChart({ records }: { records: UsageRecord[] }) {
  const data = records.length
    ? [...records].slice(0, 7).reverse().map((record, index) => ({ time: new Date(record.recordedAt).toLocaleDateString(undefined, { weekday: "short" }) || `Day ${index + 1}`, usage: record.kwh }))
    : usageTimeline;
  return (
    <div className="h-64 w-full" aria-label="Energy usage trend">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff7108" stopOpacity={0.28} /><stop offset="95%" stopColor="#ff7108" stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="#f4eee8" />
          <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#85808a" }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#85808a" }} />
          <Tooltip />
          <Area type="monotone" dataKey="usage" name="Usage (kWh)" stroke="#ff7108" strokeWidth={3} fill="url(#usage-fill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ApplianceChart() {
  return (
    <div className="grid items-center gap-3 sm:grid-cols-[minmax(150px,1fr)_1fr]">
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart><Pie data={applianceUsage} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3}>
            {applianceUsage.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
          </Pie><Tooltip /></PieChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-3">{applianceUsage.map((item) => (
        <div key={item.name} className="flex items-start gap-2 text-xs"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><div><b className="block text-slate-800">{item.name}</b><span className="text-slate-500">{item.value}% · {item.kwh} kWh</span></div></div>
      ))}</div>
    </div>
  );
}

function DeviceRows() {
  return <div className="divide-y divide-orange-50">{devices.map(({ name, usage, percent, icon: Icon, state }) => (
    <div key={name} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-orange-50 text-orange-600"><Icon size={17} /></span>
      <div className="min-w-0 flex-1"><div className="flex justify-between gap-2 text-xs"><b className="truncate">{name}</b><span className="shrink-0 text-slate-500">{usage} kWh</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-orange-400" style={{ width: `${percent}%` }} /></div></div>
      <span className={`hidden text-[10px] sm:block ${state === "Standby" ? "text-slate-400" : "text-emerald-600"}`}>{state}</span>
    </div>
  ))}</div>;
}

function Dashboard({ summary, records, user, notify }: {
  summary: ReturnType<typeof calculateEnergySummary>;
  records: UsageRecord[];
  user: User | null;
  notify: (message: string) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Gauge} label="Current Usage" value="0.62 kW" caption="Sample live reading" trend="● Live" />
        <StatCard icon={ChartNoAxesColumnIncreasing} label="Today's Consumption" value={`${summary.averageDailyKwh.toFixed(2)} kWh`} caption="Daily average" />
        <StatCard icon={ChartPie} label="This Month" value={`${summary.totalKwh.toFixed(2)} kWh`} caption={records.length ? "From saved readings" : "Sample dashboard data"} />
        <StatCard icon={Receipt} label="Estimated Bill" value={`₱${summary.estimatedCost.toLocaleString("en-PH", { minimumFractionDigits: 2 })}`} caption="Illustrative estimate" />
      </div>
      <Card className="overflow-hidden border-0 bg-gradient-to-r from-orange-500 to-amber-400 text-white">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
          <div><p className="text-xs font-extrabold tracking-widest text-white/80">YOUR ENERGY JOURNEY</p><h2 className="font-display mt-1 text-2xl font-semibold">Small changes. Big savings.</h2><p className="mt-1 text-sm text-white/90">Complete energy-saving challenges to build better habits.</p></div>
          <div className="flex gap-5 rounded-2xl bg-white/15 px-5 py-3"><div><b className="block text-xl">120</b><span className="text-xs text-white/80">Watts points</span></div><div><b className="block text-xl">3</b><span className="text-xs text-white/80">Day streak</span></div><div><b className="block text-xl">1/3</b><span className="text-xs text-white/80">Quests done</span></div></div>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(270px,1fr)]">
        <div className="space-y-4">
          <Panel title="Electricity usage trend"><UsageAreaChart records={records} /></Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Usage breakdown"><ApplianceChart /></Panel>
            <Panel title="Top devices"><DeviceRows /></Panel>
          </div>
        </div>
        <div className="space-y-4">
          <Panel title="Account overview"><div className="space-y-3 text-xs"><Detail label="Account type" value="Guest account" /><Detail label="Account ID" value={user?.uid.slice(0, 12) ?? "Not connected"} /><Detail label="Rate" value="Residential · sample" /><Detail label="Storage" value={firebaseConfigured ? "Firestore offline cache" : "Demo mode"} /></div></Panel>
          <Panel title="Today's energy tips"><div className="space-y-3 text-sm text-slate-600"><Tip text="Raise your AC temperature by 1°C to reduce cooling load." /><Tip text="Switch off idle appliances to reduce standby consumption." /><Tip text="Use daylight where possible before turning on lights." /></div></Panel>
          <OcrEntry user={user} notify={notify} />
        </div>
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span className="text-slate-500">{label}</span><b className="text-right text-slate-800">{value}</b></div>;
}

function Tip({ text }: { text: string }) {
  return <div className="flex gap-2"><Lightbulb size={17} className="mt-0.5 shrink-0 text-orange-500" /><p>{text}</p></div>;
}

function PageContent({ page, records, summary, user, notify, goTo }: {
  page: PageId;
  records: UsageRecord[];
  summary: ReturnType<typeof calculateEnergySummary>;
  user: User | null;
  notify: (message: string) => void;
  goTo: (page: PageId) => void;
}) {
  const exportCsv = () => {
    const rows = [["Recorded at", "Usage (kWh)"], ...records.map((item) => [item.recordedAt, String(item.kwh)])];
    const csv = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "smartwatts-readings.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const metricCards = (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard icon={ChartNoAxesColumnIncreasing} label="Total Usage" value={`${summary.totalKwh.toFixed(2)} kWh`} caption="Current period" />
      <StatCard icon={BadgeDollarSign} label="Estimated Cost" value={`₱${summary.estimatedCost.toFixed(2)}`} caption="Illustrative only" />
      <StatCard icon={TrendingUp} label="Daily Average" value={`${summary.averageDailyKwh.toFixed(2)} kWh`} caption="Based on this period" />
      <StatCard icon={Radio} label="Meter Status" value="Sample" caption="No live meter connected" />
    </div>
  );

  if (page === "dashboard") return <Dashboard summary={summary} records={records} user={user} notify={notify} />;
  if (page === "realtime" || page === "history") {
    return <><div className="mb-4 flex flex-wrap items-center justify-between gap-3">{metricCards}<div className="flex w-full justify-end"><Button variant="outline" onClick={exportCsv}><Download size={15} />Export CSV</Button></div></div><Panel title={page === "realtime" ? "Recent energy readings" : "Consumption history"}><UsageAreaChart records={records} /></Panel><div className="mt-4"><ReadingsTable records={records} /></div><div className="mt-4"><OcrEntry user={user} notify={notify} /></div></>;
  }
  if (page === "breakdown") return <>{metricCards}<div className="mt-4 grid gap-4 lg:grid-cols-2"><Panel title="Usage by appliance"><ApplianceChart /></Panel><Panel title="Monthly consumption trend"><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={monthlyUsage}><CartesianGrid vertical={false} stroke="#f4eee8" /><XAxis dataKey="month" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><Tooltip /><Bar dataKey="kwh" name="kWh" fill="#ff8a32" radius={[8, 8, 0, 0]} /></BarChart></ResponsiveContainer></div></Panel></div><div className="mt-4"><Panel title="Appliance consumption details"><DeviceRows /></Panel></div></>;
  if (page === "devices") return <><div className="mb-4">{metricCards}</div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{devices.map((device) => <Panel key={device.name} title={device.name}><div className="mb-4 flex items-center justify-between"><device.icon className="text-orange-500" /><span className={`rounded-full px-2 py-1 text-xs ${device.state === "Online" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{device.state}</span></div><p className="font-display text-2xl">{device.usage} <small className="text-sm text-slate-400">kWh</small></p><p className="mt-1 text-xs text-slate-500">{device.percent}% of sample usage</p><div className="mt-3 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-orange-400" style={{ width: `${device.percent}%` }} /></div></Panel>)}</div></>;
  if (page === "goals") return <><div className="mb-4">{metricCards}</div><div className="grid gap-4 lg:grid-cols-2"><Panel title="Monthly target"><p className="font-display text-3xl">342.18 <small className="text-base text-slate-400">/ 320 kWh</small></p><div className="mt-4 h-3 rounded-full bg-orange-100"><div className="h-3 w-full rounded-full bg-orange-500" /></div><p className="mt-2 text-xs text-slate-500">Sample data is 22.18 kWh over the selected target.</p></Panel><Panel title="Your next milestone"><p className="text-sm text-slate-600">Complete three energy-saving quests to unlock your next badge.</p><Button className="mt-4" onClick={() => goTo("rewards")}>See rewards</Button></Panel></div><div className="mt-4"><Panel title="Today's quests"><div className="space-y-2">{quests.map((quest) => <div key={quest.id} className="flex items-center justify-between gap-3 rounded-xl bg-orange-50/60 p-3"><span>{quest.icon} <b className="ml-1 text-sm">{quest.title}</b><small className="ml-2 text-orange-700">+{quest.points} XP</small></span><Button size="sm" variant="outline" onClick={() => notify("Quest marked as complete in this demo.")}><Check size={14} />Claim</Button></div>)}</div></Panel></div></>;
  if (page === "rewards") return <><Card className="mb-4 bg-gradient-to-r from-amber-100 to-orange-50"><p className="text-xs font-extrabold tracking-widest text-orange-700">YOUR WATTS POINTS</p><p className="font-display text-4xl font-semibold">120</p><p className="text-sm text-slate-600">Level 2 · Bulb Buddy · 80 XP to next level</p></Card><Panel title="Badge collection"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{["First Step", "Cool Operator", "Phantom Hunter", "Daylight Dynamo"].map((badge, index) => <div key={badge} className="rounded-2xl bg-orange-50/70 p-4 text-center"><div className="text-3xl">{["🌱", "❄️", "🔌", "☀️"][index]}</div><b className="mt-2 block text-sm">{badge}</b><span className="text-xs text-slate-500">{index === 0 ? "Unlocked" : "Keep saving energy"}</span></div>)}</div></Panel></>;
  if (page === "billing" || page === "bills") return <><div className="mb-4">{metricCards}</div><Panel title={page === "billing" ? "Current bill estimate" : "Previous statements"}><BillsTable /></Panel><p className="mt-3 text-xs text-slate-400">Sample information only. No payment is processed by SmartWatts.</p></>;
  if (page === "rates") return <><div className="mb-4">{metricCards}</div><Panel title="Sample charge breakdown"><div className="space-y-3"><Detail label="Generation charge" value="₱715.20" /><Detail label="Transmission charge" value="₱105.30" /><Detail label="Distribution charge" value="₱220.40" /><Detail label="Taxes and other charges" value="₱215.44" /><Detail label="Total estimate" value="₱1,256.34" /></div></Panel></>;
  if (page === "notifications") return <Panel title="Recent activity"><div className="space-y-4"><Tip text="Your latest usage summary is ready to review." /><Tip text="Energy saving challenge: switch off unused lights today." /><Tip text="Bill and usage figures shown in the demo are illustrative." /></div></Panel>;
  if (page === "account") return <AccountSettings notify={notify} />;
  if (page === "support") return <div className="grid gap-4 lg:grid-cols-2"><Panel title="Frequently asked questions"><div className="space-y-4 text-sm"><div><b>How is my bill estimated?</b><p className="mt-1 text-slate-500">This prototype uses an example electricity rate and sample usage data.</p></div><div><b>How do I add a reading?</b><p className="mt-1 text-slate-500">Upload a bill image for OCR or type a value manually on the dashboard.</p></div></div></Panel><Panel title="Contact support"><p className="text-sm text-slate-600">For account-specific help, use official utility support channels.</p><Button className="mt-4" onClick={() => notify("Connect official support details to enable this action.")}><CircleHelp size={16} />Contact support</Button></Panel></div>;
  return <><Card className="mb-4 bg-gradient-to-r from-orange-50 to-white"><p className="text-xs font-extrabold tracking-widest text-orange-700">MONITOR. SAVE. SMARTER.</p><h2 className="font-display mt-2 text-2xl font-semibold">Energy insights made easier.</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">SmartWatts brings consumption, device breakdowns, and billing estimates together in one approachable place. This prototype uses sample electricity information.</p></Card><div className="grid gap-4 md:grid-cols-3"><Panel title="Our purpose"><p className="text-sm text-slate-600">Make everyday energy use easier to understand.</p></Panel><Panel title="Our approach"><p className="text-sm text-slate-600">Turn data into useful charts and practical insights.</p></Panel><Panel title="Our team"><p className="text-sm text-slate-600">A project concept for smarter household energy habits.</p></Panel></div></>;
}

function ReadingsTable({ records }: { records: UsageRecord[] }) {
  return <Panel title="Saved readings">{records.length === 0 ? <p className="text-sm text-slate-500">No saved readings yet. Add one with the entry tool.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th className="py-2">Recorded</th><th className="py-2">Consumption</th><th className="py-2">Source</th></tr></thead><tbody>{records.map((record) => <tr key={record.id} className="border-t border-orange-50"><td className="py-3">{new Date(record.recordedAt).toLocaleString()}</td><td className="py-3 font-bold">{record.kwh.toFixed(2)} kWh</td><td className="py-3 text-slate-500">Manual/OCR</td></tr>)}</tbody></table></div>}</Panel>;
}

function BillsTable() {
  return <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="text-xs text-slate-500"><tr>{["Billing period", "Consumption", "Amount", "Status"].map((heading) => <th key={heading} className="py-2">{heading}</th>)}</tr></thead><tbody>{sampleBills.map(([period, usage, amount, status]) => <tr key={period} className="border-t border-orange-50"><td className="py-3">{period}</td><td className="py-3">{usage}</td><td className="py-3 font-bold">{amount}</td><td className="py-3"><span className="rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700">{status}</span></td></tr>)}</tbody></table></div>;
}

function AccountSettings({ notify }: { notify: (message: string) => void }) {
  return <Panel title="Guest account settings"><form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); notify("Profile settings saved in this demo."); }}><label className="grid gap-1 text-xs font-bold text-slate-500">Display name<input defaultValue="Energy Saver" className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800" /></label><label className="grid gap-1 text-xs font-bold text-slate-500">Preferred language<select defaultValue="en" className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800"><option value="en">English</option><option value="tl">Tagalog</option></select></label><div className="sm:col-span-2"><Button type="submit"><Settings size={15} />Save preferences</Button></div></form></Panel>;
}

export default function App() {
  const [page, setPage] = useState<PageId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [toast, setToast] = useState("");
  const sampleModeReadings = useMemo(() => sampleReadings.map((kwh) => ({ kwh })), []);
  const summary = useMemo(
    () => calculateEnergySummary(records.length ? records : sampleModeReadings, 3.67, 30),
    [records, sampleModeReadings],
  );
  const [title, subtitle] = pageCopy[page];

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  useEffect(() => {
    if (!auth) {
      setConnectionMessage("Demo mode · add Firebase settings to enable guest sync.");
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, setUser, (error) => {
      setConnectionMessage(`Firebase authentication failed: ${error.message}`);
    });
    signInAnonymously(auth).catch((error: unknown) => {
      setConnectionMessage(`Could not create a guest account: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) return;
    return watchUsageRecords(
      user,
      (nextRecords) => {
        setRecords(nextRecords);
        setConnectionMessage("Guest account connected · Firestore sync active.");
      },
      (error) => setConnectionMessage(`Firestore sync failed: ${error.message}`),
    );
  }, [user]);

  function navigate(nextPage: PageId) {
    setPage(nextPage);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="min-h-screen">
      {sidebarOpen && <button className="fixed inset-0 z-30 bg-slate-950/35 lg:hidden" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[258px] flex-col overflow-y-auto bg-gradient-to-b from-orange-500 to-orange-600 p-4 text-white transition-transform lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-8 flex items-center gap-3 px-2 pt-2"><span className="grid h-11 w-11 place-items-center rounded-full bg-white text-orange-600"><Zap size={27} fill="currentColor" /></span><span><b className="font-display text-xl">SmartWatts</b><small className="block text-[11px] text-white/80">Monitor. Save. Smarter.</small></span><button className="ml-auto lg:hidden" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={20} /></button></div>
        <nav className="space-y-4">{navigation.map((group) => <div key={group.label}><p className="mb-1 px-3 text-[10px] font-extrabold tracking-[.15em] text-white/70">{group.label}</p>{group.items.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-bold transition ${page === id ? "bg-white text-orange-600 shadow-sm" : "text-white/90 hover:bg-white/15"}`}><Icon size={18} />{label}</button>)}</div>)}</nav>
        <div className="mt-auto rounded-2xl bg-white/15 p-4"><CircleHelp size={22} /><b className="mt-2 block text-sm">Need help?</b><p className="mt-1 text-xs leading-5 text-white/80">Find answers to common energy questions.</p><Button variant="outline" size="sm" className="mt-3 border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white" onClick={() => navigate("support")}>Get support</Button></div>
        <small className="px-2 pt-4 text-[10px] text-white/65">© 2026 SmartWatts</small>
      </aside>

      <main className="min-h-screen lg:ml-[258px]">
        <header className="sticky top-0 z-20 border-b border-orange-100 bg-white/90 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1500px] items-center gap-3">
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Menu size={21} /></Button>
            <div className="min-w-0 flex-1"><h1 className="font-display truncate text-lg font-semibold sm:text-xl">{title}</h1><p className="hidden text-xs text-slate-500 sm:block">{subtitle}</p></div>
            <div className="hidden items-center gap-2 rounded-xl bg-orange-50 px-3 py-2 text-xs font-bold text-orange-700 sm:flex"><Flame size={15} /> 3 <span className="text-orange-300">·</span> <Zap size={15} />120 XP</div>
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={() => navigate("breakdown")}>Analytics</Button>
            <Button variant="ghost" size="icon" aria-label="Notifications" onClick={() => navigate("notifications")}><Bell size={19} /></Button>
            <button className="grid h-9 w-9 place-items-center rounded-full bg-orange-500 text-xs font-extrabold text-white" aria-label="Guest account" onClick={() => navigate("account")}>G</button>
            <ChevronDown size={14} className="hidden text-slate-400 sm:block" />
          </div>
          <p className="mx-auto mt-2 max-w-[1500px] text-[10px] text-slate-400 sm:hidden">{subtitle}</p>
        </header>

        <div className="mx-auto max-w-[1500px] space-y-4 px-3 pb-24 pt-4 sm:px-6 sm:pt-6 lg:px-8 lg:pb-8">
          {connectionMessage && <div className={`rounded-xl border px-3 py-2 text-xs ${user ? "border-emerald-100 bg-emerald-50 text-emerald-800" : "border-amber-100 bg-amber-50 text-amber-800"}`} role="status">{connectionMessage}</div>}
          <PageContent page={page} records={records} summary={summary} user={user} notify={notify} goTo={navigate} />
        </div>
        <footer className="flex justify-between gap-3 border-t border-orange-100 px-4 py-4 text-[10px] text-slate-400 sm:px-8"><span>© 2026 SmartWatts. Sample dashboard data.</span><span>Not an official utility service.</span></footer>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-orange-100 bg-white/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1 backdrop-blur lg:hidden" aria-label="Mobile navigation">
        {[navigation[0].items[0], navigation[0].items[1], navigation[1].items[0], navigation[1].items[1], navigation[3].items[2]].map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={`grid justify-items-center gap-0.5 py-1 text-[9px] ${page === id ? "text-orange-600" : "text-slate-500"}`}><Icon size={19} /><span>{label === "Dashboard" ? "Home" : label.split(" ")[0]}</span></button>)}
      </nav>
      <ChatWidget />
      {toast && <div role="status" className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-3 text-center text-sm text-white shadow-xl lg:bottom-5">{toast}</div>}
    </div>
  );
}
