import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 min-h-11 px-4 text-center',
  {
    variants: {
      variant: {
        default: 'bg-brand-700 text-white hover:bg-brand-800',
        outline: 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-100',
        ghost: 'text-slate-700 hover:bg-slate-100',
        destructive: 'bg-red-700 text-white hover:bg-red-800',
        link: 'text-brand-700 underline-offset-4 hover:underline min-h-0 px-0',
      },
      size: { default: '', sm: 'min-h-9 px-3 text-xs', lg: 'min-h-12 px-6 text-base' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} type={asChild ? undefined : (type ?? 'button')} {...props} />
}
