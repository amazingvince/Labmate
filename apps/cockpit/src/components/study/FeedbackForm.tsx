/** The natural-language feedback box: a textarea with a live parsed-constraint
 *  preview. Enter sends; Shift+Enter inserts a newline. */
import { useState } from 'react'
import { Loader2Icon, SendIcon } from 'lucide-react'
import type { Study } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { parseConstraints } from '@/lib/derive'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
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

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || !study) return
    actions.sendFeedback.mutate(trimmed)
    setText('')
    onSent?.()
  }

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
        <Button size="sm" onClick={submit} disabled={!study || pending || text.trim().length === 0}>
          {pending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <>
              <SendIcon className="size-3.5" />
              Send
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
