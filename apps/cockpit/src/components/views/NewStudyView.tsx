/** Start a study: a business question + a dataset reference. On submit we create
 *  the study, profile the dataset, propose experiments, and open it. */
import { useState, type ReactNode } from 'react'
import { ArrowLeftIcon, Loader2Icon, SparklesIcon } from 'lucide-react'
import {
  BLANK_INPUT,
  DEMO_PRESET,
  isComplete,
  useCreateStudy,
  type CreateStudyInput,
  type TaskType,
} from '@/api/create'
import { AppShell } from '@/components/layout/AppShell'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { UploadStudyView } from '@/components/views/UploadStudyView'
import { cn } from '@/lib/utils'

type StudyMode = 'manual' | 'upload'

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string
  htmlFor: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  )
}

/** A small segmented control to switch between the manual and CSV-upload paths. */
function ModeTabs({ mode, onChange }: { mode: StudyMode; onChange: (m: StudyMode) => void }) {
  const tab = (value: StudyMode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      onClick={() => onChange(value)}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        mode === value
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
  return (
    <div role="tablist" className="mb-6 inline-flex gap-1 rounded-lg border bg-muted/50 p-1">
      {tab('manual', 'Manual entry')}
      {tab('upload', 'Upload a CSV')}
    </div>
  )
}

export function NewStudyView() {
  const [mode, setMode] = useState<StudyMode>('manual')
  const [input, setInput] = useState<CreateStudyInput>(BLANK_INPUT)
  const create = useCreateStudy()
  const set = (patch: Partial<CreateStudyInput>) => setInput((cur) => ({ ...cur, ...patch }))
  const ready = isComplete(input) && !create.isPending
  const submit = () => {
    if (ready) create.mutate(input)
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <a
          href="#/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Studies
        </a>

        <div className="mb-6 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Start a study</h1>
          <p className="text-sm text-muted-foreground">
            Give Claude a business question and a dataset. It profiles the data, proposes
            hypothesis-driven experiments, and you steer with feedback.
          </p>
        </div>

        <ModeTabs mode={mode} onChange={setMode} />

        {mode === 'upload' ? (
          <UploadStudyView />
        ) : (
          <>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>New study</CardTitle>
              <Button variant="outline" size="sm" onClick={() => setInput(DEMO_PRESET)}>
                <SparklesIcon className="size-3.5" />
                Use demo dataset
              </Button>
            </div>
            <CardDescription>
              The demo uses the bundled <code className="font-mono">sla_tickets</code> dataset with
              planted leakage — a good first run.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="Business question / brief" htmlFor="brief" required>
              <Textarea
                id="brief"
                rows={3}
                value={input.brief}
                onChange={(e) => set({ brief: e.target.value })}
                placeholder="Predict which support tickets will breach SLA. Optimize recall at an acceptable false-positive cost…"
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Dataset id" htmlFor="dataset" required>
                <Input
                  id="dataset"
                  className="font-mono"
                  value={input.dataset_id}
                  onChange={(e) => set({ dataset_id: e.target.value })}
                  placeholder="sla_tickets"
                />
              </Field>
              <Field label="Task type" htmlFor="task">
                <Select
                  value={input.task_type}
                  onValueChange={(v) => set({ task_type: v as TaskType })}
                >
                  <SelectTrigger id="task" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="binary_classification">Binary classification</SelectItem>
                    <SelectItem value="regression">Regression</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Target column" htmlFor="target" required>
                <Input
                  id="target"
                  className="font-mono"
                  value={input.target}
                  onChange={(e) => set({ target: e.target.value })}
                  placeholder="breached_sla"
                />
              </Field>
              <Field label="Primary metric" htmlFor="metric" required>
                <Input
                  id="metric"
                  className="font-mono"
                  value={input.metric}
                  onChange={(e) => set({ metric: e.target.value })}
                  placeholder="recall_at_fpr"
                />
              </Field>
            </div>

            <Separator />
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Optional — metric rationale, guardrails &amp; budget
            </p>

            <Field label="Why this metric" htmlFor="why">
              <Textarea
                id="why"
                rows={2}
                value={input.metric_rationale}
                onChange={(e) => set({ metric_rationale: e.target.value })}
                placeholder="Missed breaches are costlier than false alarms up to 20% FPR."
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Guardrail metric" htmlFor="pm">
                <Input
                  id="pm"
                  className="font-mono"
                  value={input.primary_metric}
                  onChange={(e) => set({ primary_metric: e.target.value })}
                  placeholder="recall"
                />
              </Field>
              <Field label="Guardrail expression" htmlFor="gr">
                <Input
                  id="gr"
                  className="font-mono"
                  value={input.guardrail}
                  onChange={(e) => set({ guardrail: e.target.value })}
                  placeholder="false_positive_rate <= 0.20"
                />
              </Field>
            </div>

            <Field label="Banned columns (comma-separated)" htmlFor="banned">
              <Input
                id="banned"
                className="font-mono"
                value={input.banned_columns}
                onChange={(e) => set({ banned_columns: e.target.value })}
                placeholder="resolved_at, time_to_resolution, closed_status"
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Max trials" htmlFor="mt">
                <Input
                  id="mt"
                  type="number"
                  min={1}
                  className="font-mono"
                  value={input.max_trials}
                  onChange={(e) => set({ max_trials: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Budget (seconds)" htmlFor="bs">
                <Input
                  id="bs"
                  type="number"
                  min={0}
                  className="font-mono"
                  value={input.budget_seconds}
                  onChange={(e) => set({ budget_seconds: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <span className="text-xs text-muted-foreground">
            Creating a study profiles the data and proposes experiments.
          </span>
          <Button onClick={submit} disabled={!ready}>
            {create.isPending ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Creating…
              </>
            ) : (
              'Create study'
            )}
          </Button>
        </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
