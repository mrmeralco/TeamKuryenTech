import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "icon";
};

export function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff7a00] disabled:pointer-events-none disabled:opacity-50",
        variant === "default" && "bg-[#ff7a00] text-white hover:bg-[#e66e00]",
        variant === "outline" && "border border-[#ffc700] bg-white text-[#854000] hover:bg-[#fff7db]",
        variant === "ghost" && "text-slate-600 hover:bg-[#fff7db] hover:text-[#854000]",
        size === "default" && "min-h-10 px-4 py-2 text-sm",
        size === "sm" && "min-h-8 px-3 py-1.5 text-xs",
        size === "icon" && "h-10 w-10",
        className,
      )}
      {...props}
    />
  );
}
