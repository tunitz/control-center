/**
 * The contract every chat engine implements (Hermes today, Pi from T3). Routes and the run
 * manager only talk to this surface; the session's stored `backend` picks the client.
 * Methods keep Hermes's names so HermesClient implementations are unchanged. `ref` is the
 * backend's own handle for a session (Pi: the session file); Hermes ignores it.
 */
import type { Delegations, HermesFrame, StartRunArgs } from "./hermes";

export type ChatBackendName = "hermes" | "pi";

export interface ChatBackend {
  createSession(): Promise<string>;
  deleteSession(id: string, ref?: string | null): Promise<void>;
  /** Selects the model for the session's next run (Pi: set_model, or resume with it). */
  lockModel(id: string, model: string, provider: string, ref?: string | null): Promise<void>;
  startRun(args: StartRunArgs): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }>;
  stopRun(runId: string): Promise<void>;
  steerRun(runId: string, message: string): Promise<void>;
  /** Answers an approval request (Pi only; Hermes approvals are read-only notices). */
  respondApproval?(runId: string, approvalId: string, approve: boolean): Promise<void>;
  /** Only backends that report finished background work implement this. */
  delegations?(sessionId: string): Promise<Delegations>;
}
