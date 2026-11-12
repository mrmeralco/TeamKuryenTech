import { useState, type ChangeEvent, type FormEvent } from "react";
import { LoaderCircle, ScanText, Upload } from "lucide-react";
import type { User } from "firebase/auth";
import { saveUsageRecord } from "../lib/firestore";
import { Button } from "./ui/button";
import { Card, CardTitle } from "./ui/card";

interface OcrEntryProps {
  user: User | null;
  notify: (message: string) => void;
}

export default function OcrEntry({ user, notify }: OcrEntryProps) {
  const [usage, setUsage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);

  async function scanReceipt(event: ChangeEvent<HTMLInputElement>) {
    const image = event.target.files?.[0];
    if (!image) return;
    if (!image.type.startsWith("image/")) {
      notify("Choose an image file or enter the reading manually.");
      return;
    }
    setScanning(true);
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      try {
        const { data } = await worker.recognize(image);
        const match = data.text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*kwh/i);
        if (match) setUsage(match[1].replace(/,/g, ""));
        else notify("Could not find a kWh value. Enter it manually below.");
      } finally {
        await worker.terminate();
      }
    } catch {
      notify("OCR was unavailable. You can still enter the reading manually.");
    } finally {
      setScanning(false);
      event.target.value = "";
    }
  }

  async function saveReading(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(usage);
    if (!Number.isFinite(value) || value <= 0) {
      notify("Enter a kWh value greater than zero.");
      return;
    }
    if (!user) {
      notify("Configure Firebase to save readings to your guest account.");
      return;
    }
    setSaving(true);
    try {
      await saveUsageRecord(user, value);
      setUsage("");
      notify("Energy reading saved.");
    } catch {
      notify("Could not save this reading. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-orange-50 text-orange-600"><ScanText size={20} /></span>
        <div><CardTitle>Log an energy reading</CardTitle><p className="text-xs text-slate-500">Scan a bill or enter the kWh value yourself.</p></div>
      </div>
      <label className="mb-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-orange-200 bg-orange-50/50 px-3 py-3 text-sm font-bold text-orange-700 hover:bg-orange-50">
        {scanning ? <LoaderCircle className="animate-spin" size={17} /> : <Upload size={17} />}
        {scanning ? "Reading image..." : "Upload bill image"}
        <input type="file" accept="image/*" className="sr-only" onChange={scanReceipt} disabled={scanning} />
      </label>
      <form className="flex gap-2" onSubmit={saveReading}>
        <label className="sr-only" htmlFor="usage-kwh">Usage in kilowatt-hours</label>
        <input id="usage-kwh" inputMode="decimal" type="number" step="0.01" min="0.01" required value={usage} onChange={(event) => setUsage(event.target.value)} placeholder="Usage (kWh)" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
        <Button type="submit" disabled={saving || scanning}>{saving ? "Saving..." : "Save"}</Button>
      </form>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">OCR is processed in your browser. Review the value before saving.</p>
    </Card>
  );
}
