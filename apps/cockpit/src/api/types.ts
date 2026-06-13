/**
 * Single source of truth for entity shapes: re-exported from the generated
 * OpenAPI types (packages/api-types). Never hand-write a response shape — if a
 * field is missing, the spec must change first.
 */
import type { components, operations } from '@labmate/api-types'

type Schemas = components['schemas']

export type Study = Schemas['Study']
export type StudyDetail = Schemas['StudyDetail']
export type DatasetVersion = Schemas['DatasetVersion']
export type ColumnProfile = Schemas['ColumnProfile']
export type SplitStrategy = Schemas['SplitStrategy']
export type Hypothesis = Schemas['Hypothesis']
export type Run = Schemas['Run']
export type Critique = Schemas['Critique']
export type Decision = Schemas['Decision']
export type Feedback = Schemas['Feedback']
export type Artifact = Schemas['Artifact']
export type Report = Schemas['Report']
export type ApprovalRequest = Schemas['ApprovalRequest']
export type GradeResult = Schemas['GradeResult']
export type Budget = Schemas['Budget']
export type Constraints = Schemas['Constraints']
export type ApiErrorBody = Schemas['Error']

export type RunStatus = Run['status']
export type CritiqueKind = Critique['kind']
export type DecisionAction = Decision['action']
export type FeedbackType = Feedback['type']
export type HypothesisStatus = NonNullable<Hypothesis['status']>
export type StudyStatus = Study['status']

export type StudyListResponse =
  operations['listStudies']['responses']['200']['content']['application/json']
export type RequestApprovalResponse =
  operations['requestApproval']['responses']['200']['content']['application/json']
