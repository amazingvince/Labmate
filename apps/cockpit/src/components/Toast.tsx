/** Minimal toast system for write feedback ("Approval requested", "⚠ Signal lost"). */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export type ToastTone = 'info' | 'ok' | 'warn' | 'err'
type Toast = { id: number; tone: ToastTone; text: string }

type ToastContextValue = { push: (tone: ToastTone, text: string) => void }

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((tone: ToastTone, text: string) => {
    seq.current += 1
    const id = seq.current
    setToasts((list) => [...list, { id, tone, text }])
  }, [])

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-deck" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: (id: number) => void }) {
  // `onDone` (the memoized `remove`) and `toast.id` are stable, so the dismiss
  // timer is set once — it is not reset by parent re-renders (e.g. the 4s poll).
  useEffect(() => {
    const timer = window.setTimeout(() => onDone(toast.id), 4200)
    return () => window.clearTimeout(timer)
  }, [onDone, toast.id])
  return (
    <div className={`toast toast--${toast.tone}`}>
      <span className="toast__glyph" aria-hidden="true">
        {toast.tone === 'err' ? '✕' : toast.tone === 'warn' ? '⚠' : toast.tone === 'ok' ? '●' : '◖'}
      </span>
      <span className="toast__text">{toast.text}</span>
    </div>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
