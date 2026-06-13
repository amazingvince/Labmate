/** Toast feedback for writes. Thin adapter over `sonner` that preserves the
 *  original `useToast().push(tone, text)` API, so the mutation hooks in
 *  api/hooks.ts stay unchanged. The Toaster is theme-aware via ThemeProvider. */
import { toast as sonnerToast } from 'sonner'
import { type ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'

export type ToastTone = 'info' | 'ok' | 'warn' | 'err'

type ToastContextValue = { push: (tone: ToastTone, text: string) => void }

function push(tone: ToastTone, text: string) {
  if (tone === 'ok') sonnerToast.success(text)
  else if (tone === 'warn') sonnerToast.warning(text)
  else if (tone === 'err') sonnerToast.error(text)
  else sonnerToast.info(text)
}

/** Kept for call-site compatibility; mounts the (global) sonner Toaster. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster richColors closeButton position="bottom-right" />
    </>
  )
}

export function useToast(): ToastContextValue {
  return { push }
}
