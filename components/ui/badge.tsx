import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-0.5 font-sans text-[11px] font-bold uppercase tracking-[0.06em] whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default:
          "border-[rgba(3,41,58,0.2)] bg-[rgba(3,41,58,0.08)] text-brand-navy [a&]:hover:bg-[rgba(3,41,58,0.12)] dark:border-[rgba(246,241,234,0.15)] dark:bg-[rgba(246,241,234,0.08)] dark:text-brand-cream",
        secondary:
          "border-line bg-brand-paper text-ink-2 [a&]:hover:bg-brand-sand dark:bg-muted dark:text-muted-foreground",
        success:
          "border-[color-mix(in_srgb,var(--color-success)_30%,transparent)] bg-success-light text-success-dark dark:bg-[color-mix(in_srgb,var(--color-success)_18%,transparent)] dark:border-[color-mix(in_srgb,var(--color-success)_35%,transparent)] dark:text-[color:var(--color-success)]",
        warning:
          "border-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] bg-warning-light text-warning-dark dark:bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] dark:border-[color-mix(in_srgb,var(--color-warning)_35%,transparent)] dark:text-[color:var(--color-warning)]",
        danger:
          "border-[color-mix(in_srgb,var(--color-danger)_30%,transparent)] bg-danger-light text-danger-dark dark:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] dark:border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] dark:text-[color:var(--color-danger)]",
        info: "border-[color-mix(in_srgb,var(--color-info)_30%,transparent)] bg-info-light text-info-dark dark:bg-[color-mix(in_srgb,var(--color-info)_18%,transparent)] dark:border-[color-mix(in_srgb,var(--color-info)_35%,transparent)] dark:text-info-light",
        destructive:
          "border-transparent bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border bg-transparent text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost:
          "border-transparent bg-transparent text-ink-2 [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "border-transparent bg-transparent px-0 py-0 font-serif text-[13px] font-medium normal-case tracking-normal text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * 6×6 dot paired with a <Badge>. Uses currentColor so it picks up each
 * variant's dark text color; override with className if you want the
 * dot to match the base status color (e.g. `bg-success`) instead.
 */
function BadgeDot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="badge-dot"
      className={cn("size-1.5 shrink-0 rounded-full bg-current", className)}
      {...props}
    />
  )
}

export { Badge, BadgeDot, badgeVariants }
