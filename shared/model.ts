// Wire types retain the existing runtime RPC shape.
// The editor holds unvalidated drafts, so only protocol fields are widened.
import type {
  AppConfig,
  Connection,
  ModelSelection,
} from "../runtime/src/contract.ts";
export type {
  ModelSelection,
  RendererMethod,
  RestorePreview,
} from "../runtime/src/contract.ts";
export type ModelConnection = Omit<Connection, "protocol" | "apiType"> & {
  protocol: string;
  apiType: string;
};
export type AppConfiguration = Omit<AppConfig, "modelConnections"> & {
  modelConnections: ModelConnection[];
};
export type ConfigDocument = { config: AppConfiguration; revision: string };
export type ModelOption = {
  connectionId: string;
  connectionName: string | null;
  modelName: string;
  apiType: string;
};
export type TopicSession = {
  id: string;
  title: string;
  temporary: number;
  updatedAt: number;
  projectId: string | null;
};
export type FocusState = {
  activeProjectId: string | null;
  contextMode: string;
  activeSessionId: string | null;
  interruptedSessionId: string | null;
  version: number;
};
export type TimelineMessage = {
  id: string;
  sessionId: string;
  sequence: number;
  role: string;
  content: string;
  status: string | null;
  runId: string | null;
  errorCode: string | null;
  modelName: string | null;
  connectionId: string | null;
  attempt: number | null;
  routeReason: string | null;
  interactionId: string | null;
  interactionVersion: number | null;
  projectId: string | null;
  executionInteractionVersion: number | null;
  executionProjectId: string | null;
  snapshotId: string | null;
};
export type AssistantSnapshot = {
  generation: string;
  activity: ActivityState;
  projects: TandemProject[];
  pendingInteractions: PendingInteraction[];
  focus: FocusState;
  models: ModelOption[];
  defaultModel: ModelSelection | null;
  configError: string | null;
  sessions: TopicSession[];
  messages: TimelineMessage[];
  changedMessages: TimelineMessage[];
  cursor: number;
  hasMore: boolean;
};
export type TandemProject = {
  id: string;
  title: string;
  description: string;
  status: string;
  version: number;
};
export type RouteCandidate = {
  sessionId: string;
  projectId: string | null;
  title: string;
  reason: string;
  updatedAt: number;
};
export type RouteExplanation = {
  action: string;
  reason: string;
  candidates: RouteCandidate[];
};
export type PendingInteraction = {
  id: string;
  sequence: number;
  input: string;
  version: number;
  route: RouteExplanation;
};
export type ContextFragment = {
  sourceType: string;
  sourceId: string;
  sourceVersion: string;
  projectId: string | null;
  role: string;
  content: string;
  deleted: boolean | null;
};
export type RunContext = {
  id: string;
  mode: string;
  projectId: string | null;
  fragments: ContextFragment[];
};
export type DeletionItem = { id: string };
export type ProjectDeletion = {
  token: string;
  title: string;
  interactions: DeletionItem[];
  messages: DeletionItem[];
  runs: DeletionItem[];
  tasks: DeletionItem[];
  memories: DeletionItem[];
  sharedSnapshots: string[];
  derivedMessages: string[];
};
export type CorrectionRecord = {
  id: string;
  from_project: string | null;
  to_project: string | null;
  version: number;
  created_at: number;
};
export type CorrectionHistory = { corrections: CorrectionRecord[] };
export type ActivityState = {
  runs: ActivityRun[];
  approvals: ApprovalCard[];
  tasks: PersistentTask[];
  grants: DirectoryGrant[];
};
export type ActivityRun = {
  id: string;
  status: string;
  error_code: string | null;
  project_id: string | null;
  assistant_message_id: string;
  version: number;
  steps: number;
  tokens: number;
  active_ms: number;
  step_limit: number;
  token_limit: number;
  time_limit: number;
  pause_reason: string | null;
  estimated: number;
  modelName: string;
  task_id: string | null;
  revision: number | null;
  stepsDetail: ExecutionStep[];
};
export type ExecutionStep = {
  id: string;
  kind: string;
  status: string;
  snapshot_id: string | null;
  detail: string;
};
export type ApprovalCard = {
  id: string;
  run_id: string;
  name: string;
  args: string;
  expires_at: number;
};
export type DirectoryGrant = {
  id: string;
  project_id: string | null;
  label: string;
  status: string;
};
export type PersistentTask = {
  id: string;
  project_id: string | null;
  session_id: string;
  revision: number;
  status: string;
  deliverable: string;
  criteria: string;
  evidence: string | null;
  result_ref: string | null;
};
