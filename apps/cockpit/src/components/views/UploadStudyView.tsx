/**
 * Start a study from an uploaded CSV. The flow is two stages on one screen:
 *
 *   1. pick a .csv → POST /api/datasets → real server-side profile (row count,
 *      per-column dtype/missingness/cardinality, leakage flags + reasons);
 *   2. frame the problem against that profile — choose the target, the primary
 *      metric (options inferred from the target's dtype), an optional FPR
 *      guardrail, and confirm the banned/leakage columns — then create the study.
 *
 * Creation reuses the same `useCreateStudy` mutation as the manual path, so the
 * existing profile/propose/navigate behaviour is shared. This view ADDS a path;
 * the manual + sla_tickets flow in NewStudyView is untouched.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Loader2Icon, TriangleAlertIcon, UploadIcon } from 'lucide-react'
import { useUploadDataset } from '@/api/hooks'
import { useCreateStudy, type CreateStudyInput, type TaskType } from '@/api/create'
import type { DatasetProfile, ProfileColumn, ProfileDtype } from '@/api/datasets'
import { useHasApiToken } from '@/api/token'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Metric option lists by inferred task. The first entry is the sensible default. */
const CLASSIFICATION_METRICS = ['recall', 'precision', 'roc_auc', 'pr_auc', 'f1'] as const
const REGRESSION_METRICS = ['rmse', 'mae', 'r2'] as const

/** A numeric, high-cardinality target ⇒ regression; otherwise classification. */
function isRegressionTarget(col: ProfileColumn | undefined): boolean {
  if (!col) return false
  // Boolean / 0-1 numerics are classification even though they parse as numeric;
  // only treat a numeric target with several distinct values as regression.
  return col.dtype === 'numeric' && col.cardinality > 10
}

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

function dtypeLabel(d: ProfileDtype): string {
  return d
}

/** The column profile table with leakage badges (reason in a tooltip). */
function ProfilePreview({
  profile,
  target,
  banned,
  onToggleBan,
}: {
  profile: DatasetProfile
  target: string
  banned: Set<string>
  onToggleBan: (name: string) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-2xl font-medium tabular-nums">
          {profile.row_count.toLocaleString()}
        </span>
        <span className="text-sm text-muted-foreground">
          rows{profile.sampled ? ' (sampled)' : ''}
        </span>
        <span className="text-sm text-muted-foreground">· {profile.columns.length} columns</span>
        {profile.split?.strategy && (
          <Badge variant="secondary" className="ml-auto font-mono font-normal">
            split: {profile.split.strategy}
            {profile.split.time_col ? ` (${profile.split.time_col})` : ''}
          </Badge>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[40rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Missing</TableHead>
              <TableHead className="text-right">Unique</TableHead>
              <TableHead className="text-right">Excluded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile.columns.map((col) => {
              const isTarget = col.name === target
              const isBanned = banned.has(col.name)
              const leaky = col.is_candidate_leakage
              const miss = col.missing_fraction ?? 0
              return (
                <TableRow key={col.name} className={cn(leaky && !isTarget && 'bg-destructive/5')}>
                  <TableCell className="font-mono">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn(isBanned && 'text-muted-foreground line-through')}>
                        {col.name}
                      </span>
                      {isTarget && (
                        <Badge variant="secondary" className="font-normal">
                          target
                        </Badge>
                      )}
                      {leaky && !isTarget && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="inline-flex cursor-help items-center gap-1 rounded px-1 text-[11px] font-medium"
                              style={{ color: 'var(--crit-leakage)' }}
                            >
                              <TriangleAlertIcon className="size-3.5" />
                              leakage
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            {col.leakage_reason ?? 'Flagged as a candidate leakage column.'}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{dtypeLabel(col.dtype)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {(miss * 100).toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {col.cardinality.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* The target is never bannable; every other column can be excluded. */}
                    {isTarget ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <label className="inline-flex cursor-pointer items-center justify-end gap-1.5">
                        <span className="sr-only">Exclude {col.name} from training</span>
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer accent-[var(--crit-leakage)]"
                          checked={isBanned}
                          onChange={() => onToggleBan(col.name)}
                        />
                      </label>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Leakage-flagged columns are pre-excluded. Toggle the checkbox to include or exclude any
        column from training.
      </p>
    </div>
  )
}

export function UploadStudyView() {
  const upload = useUploadDataset()
  const create = useCreateStudy()
  const unlocked = useHasApiToken()

  const [fileName, setFileName] = useState('')
  const [profile, setProfile] = useState<DatasetProfile | null>(null)

  // Problem framing, filled after a profile lands.
  const [brief, setBrief] = useState('')
  const [target, setTarget] = useState('')
  const [metric, setMetric] = useState('')
  const [guardrail, setGuardrail] = useState('')
  const [banned, setBanned] = useState<Set<string>>(new Set())

  const targetCol = useMemo(
    () => profile?.columns.find((c) => c.name === target),
    [profile, target],
  )
  const regression = isRegressionTarget(targetCol)
  const metricOptions = regression ? REGRESSION_METRICS : CLASSIFICATION_METRICS
  const taskType: TaskType = regression ? 'regression' : 'binary_classification'

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    const csv = await file.text()
    upload.mutate(
      { csv },
      {
        onSuccess: (res) => {
          const p = res.profile
          setProfile(p)
          // Seed the banned set from server-flagged leakage candidates.
          setBanned(new Set(p.leakage_candidates ?? []))
          // Clear downstream picks — a new file invalidates them.
          setTarget('')
          setMetric('')
          setGuardrail('')
        },
      },
    )
  }

  const onPickTarget = (name: string) => {
    setTarget(name)
    // Default the metric to the first sensible option for the inferred task, and
    // make sure the chosen target is never itself excluded from training.
    const col = profile?.columns.find((c) => c.name === name)
    const defaults: readonly string[] = isRegressionTarget(col)
      ? REGRESSION_METRICS
      : CLASSIFICATION_METRICS
    setMetric((m) => (defaults.includes(m) ? m : defaults[0]))
    setBanned((cur) => {
      if (!cur.has(name)) return cur
      const next = new Set(cur)
      next.delete(name)
      return next
    })
  }

  const toggleBan = (name: string) => {
    setBanned((cur) => {
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const ready =
    Boolean(profile) &&
    brief.trim().length > 0 &&
    target.length > 0 &&
    metric.length > 0 &&
    !create.isPending

  const submit = () => {
    if (!profile || !ready) return
    // The selected metric doubles as the spec `metric` string and the
    // `primary_metric` constraint, mirroring how the manual path treats recall.
    const input: CreateStudyInput = {
      brief: brief.trim(),
      dataset_id: profile.dataset_id,
      target,
      metric,
      task_type: taskType,
      metric_rationale: '',
      primary_metric: metric,
      guardrail: guardrail.trim(),
      banned_columns: [...banned].join(', '),
      max_trials: 20,
      budget_seconds: 600,
    }
    create.mutate(input)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload a CSV</CardTitle>
        <CardDescription>
          Claude profiles your file on the server — column types, missingness, and candidate
          leakage — then you frame the target, metric, and exclusions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!unlocked && (
          <Alert>
            <TriangleAlertIcon className="size-4" />
            <AlertTitle>Locked</AlertTitle>
            <AlertDescription>
              Uploading a dataset is a write. Click <strong>Unlock</strong> in the top bar and
              paste the internal token to enable it.
            </AlertDescription>
          </Alert>
        )}

        {/* Stage 1 — file picker */}
        <Field label="CSV file" htmlFor="csv-file" required>
          <div className="flex flex-wrap items-center gap-3">
            {/* A label (not a <button>) so the native file input is the click
                target; styled with buttonVariants to match the design system. */}
            <label
              htmlFor="csv-file"
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'cursor-pointer',
                upload.isPending && 'pointer-events-none opacity-50',
              )}
            >
              {upload.isPending ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  Profiling…
                </>
              ) : (
                <>
                  <UploadIcon className="size-4" />
                  {profile ? 'Choose another .csv' : 'Choose .csv'}
                </>
              )}
            </label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              disabled={upload.isPending}
              onChange={(e) => {
                void onFile(e.target.files?.[0])
                // Allow re-selecting the same file to re-profile.
                e.target.value = ''
              }}
            />
            {fileName && (
              <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
            )}
          </div>
        </Field>

        {/* Stage 2 — profile preview + framing, shown once a profile lands */}
        {profile && (
          <>
            <Separator />
            <ProfilePreview
              profile={profile}
              target={target}
              banned={banned}
              onToggleBan={toggleBan}
            />

            <Separator />

            <Field label="Business question / brief" htmlFor="upload-brief" required>
              <Textarea
                id="upload-brief"
                rows={3}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="Predict … . Explain the business decision this should drive."
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Target column" htmlFor="upload-target" required>
                <Select value={target} onValueChange={onPickTarget}>
                  <SelectTrigger id="upload-target" className="w-full font-mono">
                    <SelectValue placeholder="Pick the column to predict" />
                  </SelectTrigger>
                  <SelectContent>
                    {profile.columns.map((c) => (
                      <SelectItem key={c.name} value={c.name} className="font-mono">
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Primary metric" htmlFor="upload-metric" required>
                <Select value={metric} onValueChange={setMetric} disabled={!target}>
                  <SelectTrigger id="upload-metric" className="w-full font-mono">
                    <SelectValue placeholder={target ? 'Pick a metric' : 'Pick a target first'} />
                  </SelectTrigger>
                  <SelectContent>
                    {metricOptions.map((m) => (
                      <SelectItem key={m} value={m} className="font-mono">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {target && (
                  <p className="text-xs text-muted-foreground">
                    Inferred task: {regression ? 'regression' : 'classification'} (target is{' '}
                    {targetCol?.dtype ?? 'unknown'}).
                  </p>
                )}
              </Field>
            </div>

            {!regression && (
              <Field label="False-positive guardrail (optional)" htmlFor="upload-guardrail">
                <Input
                  id="upload-guardrail"
                  className="font-mono"
                  value={guardrail}
                  onChange={(e) => setGuardrail(e.target.value)}
                  placeholder="false_positive_rate <= 0.20"
                />
              </Field>
            )}
          </>
        )}
      </CardContent>

      {profile && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t px-6 py-4">
          <span className="text-xs text-muted-foreground">
            {banned.size} column{banned.size === 1 ? '' : 's'} excluded · creating profiles &amp;
            proposes experiments.
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
      )}
    </Card>
  )
}
