/** Operator unlock control. The public bundle has no write token; the operator
 *  pastes the internal token here once and it's kept in this browser only
 *  (localStorage), enabling writes (create study, approve, generate report).
 *  Visitors without it stay read-only. */
import { useEffect, useState } from 'react'
import { KeyRoundIcon, LockOpenIcon } from 'lucide-react'
import {
  clearApiToken,
  getApiToken,
  setApiToken,
  tokenIsOperatorSet,
  useHasApiToken,
} from '@/api/token'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useToast } from '@/components/Toast'

export function UnlockButton() {
  const unlocked = useHasApiToken()
  const operatorSet = tokenIsOperatorSet()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const toast = useToast()

  // Prefill with the existing operator token when opening, so it can be reviewed.
  useEffect(() => {
    if (open) setValue(operatorSet ? getApiToken() : '')
  }, [open, operatorSet])

  const save = () => {
    const v = value.trim()
    if (!v) return
    setApiToken(v)
    setOpen(false)
    toast.push('ok', 'Unlocked — writes enabled in this browser')
  }

  const clear = () => {
    clearApiToken()
    setValue('')
    setOpen(false)
    toast.push('info', 'Locked — token cleared from this browser')
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          title={unlocked ? 'Writes unlocked — manage token' : 'Unlock writes (paste internal token)'}
        >
          {unlocked ? (
            <LockOpenIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <KeyRoundIcon className="size-4" />
          )}
          <span className="hidden sm:inline">{unlocked ? 'Unlocked' : 'Unlock'}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock writes</DialogTitle>
          <DialogDescription>
            Paste the internal token to create studies, approve experiments, and generate
            reports. It's stored in this browser only (localStorage) — never in the public
            site. Reads work without it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="labmate-token">Internal token</Label>
          <Input
            id="labmate-token"
            type="password"
            autoComplete="off"
            placeholder="LABMATE_INTERNAL_TOKEN"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
          />
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={clear}
            disabled={!operatorSet}
            className="text-muted-foreground"
          >
            Clear token
          </Button>
          <Button onClick={save} disabled={value.trim().length === 0}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
