/** The natural-language feedback box: a textarea with a live parsed-constraint
 *  preview. Enter sends; Shift+Enter inserts a newline. The note is only cleared
 *  on success, and the popover is kept open on error so a failed send (e.g. a
 *  401) never loses what the human typed. Disabled until the cockpit is unlocked. */
import { useState } from 'react'
import { Loader2Icon, LockIcon, SendIcon } from 'lucide-react'
import type { Study } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useHasApiToken } from '@/api/token'
import { parseConstraints } from '@/lib/derive'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ParsedConstraintChips } from '@/components/study/ParsedConstraintChips'

export function FeedbackForm({
  study,
  actions,
  onSent,
  autoFocus = false,
}: {
  study?: Study
  actions: StudyActions
  onSent?: () => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const preview = parseConstraints(text)
  const pending = actions.sendFeedback.isPending
  const locked = !useHasApiToken()

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || !study || locked) return
    actions.sendFeedback.mutate(trimmed, {
      // Clear the box and close the popover ONLY when the write lands. On error
      // the typed note stays put (and the popover stays open) so it isn't lost.
      onSuccess: () => {
        setText('')
        onSent?.()
      },
    })
  }

  const sendDisabled = !study || pending || locked || text.trim().length === 0
  const sendButton = (
    <Button size="sm" onClick={submit} disabled={sendDisabled}>
      {pending ? (
        <Loader2Icon className="size-4 animate-spin" />
      ) : locked ? (
        <>
          <LockIcon className="size-3.5" />
          Locked
        </>
      ) : (
        <>
          <SendIcon className="size-3.5" />
          Send
        </>
      )}
    </Button>
  )

  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        autoFocus={autoFocus}
        rows={3}
        placeholder="Recall matters more than precision, but false positives above 20% are not acceptable."
        aria-label="Record your judgment as natural language"
        disabled={!study || pending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {preview && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">parses to →</span>
          <ParsedConstraintChips parsed={preview} />
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Enter to send · Shift+Enter for newline</span>
        {locked ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">{sendButton}</span>
            </TooltipTrigger>
            <TooltipContent>Unlock to enable writes</TooltipContent>
          </Tooltip>
        ) : (
          sendButton
        )}
      </div>
    </div>
  )
}
