// Thin fetch wrappers for the backend API. Errors surface the server's {error} message.
async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
}

export interface EngineProfile { id: string; label: string; ecu_default: string; }
export interface Car { id: string; name: string; engine_label: string; ecu: string; forced_induction_json: { enabled: boolean; type: string }; config_json: any; }
export interface Finding { severity: "info" | "warn" | "critical"; code: string; cell?: string; message: string; confidence: number; evidence: Record<string, unknown>; }
export interface CellStat { cell: string; rpm_bin: number; load_bin: number; n: number; mean: number; min: number; max: number; }
export interface Analysis {
  segments: Record<string, number>;
  maps: { afr_error: CellStat[]; ign: CellStat[]; knock: CellStat[]; boost?: CellStat[] };
  trims: Record<string, number>;
  findings: Finding[];
  recommendations: Finding[];
  quality: { dead_channels: string[]; sample_rate_hz: number; issues: string[] };
}
export interface SessionSummary { id: string; uploaded_at: string; label: string | null; headline: string | null; }
export interface DiffFinding { type: "regression" | "improvement" | "neutral"; severity: string; cell?: string; metric: string; delta: number; significance: number; message: string; }
export interface DiffResult { baseline: string | null; message?: string; scalar_deltas?: Record<string, number | null>; findings: DiffFinding[]; compared_cells?: number; insufficient?: number; }

export const getProfiles = () => fetch("/engine-profiles").then(j<EngineProfile[]>);
export const getCars = () => fetch("/cars").then(j<Car[]>);
export const createCar = (body: unknown) =>
  fetch("/cars", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(j<Car>);
export const getSessions = (carId: string) => fetch(`/cars/${carId}/sessions`).then(j<SessionSummary[]>);
export const getSession = (id: string) => fetch(`/sessions/${id}`).then(j<{ id: string; label: string | null; derived: Analysis; logs: any[] }>);
export const compareSession = (id: string, baseline = "prev") => fetch(`/sessions/${id}/compare?baseline=${baseline}`).then(j<DiffResult>);
export function uploadSession(carId: string, files: File[], label: string) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  if (label) fd.append("label", label);
  return fetch(`/cars/${carId}/sessions`, { method: "POST", body: fd }).then(j<{ id: string }>);
}
