import { useEffect, useState } from "react";
import * as api from "./api";
import type { Analysis, Car, EngineProfile, Finding, SessionSummary } from "./api";
import { Heatmap, divergeColor, knockColor, seqColor } from "./Heatmap";

export function App() {
  const [profiles, setProfiles] = useState<EngineProfile[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [car, setCar] = useState<Car | null>(null);
  const [session, setSession] = useState<{ id: string; label: string | null; derived: Analysis } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refreshCars = () => api.getCars().then(setCars).catch((e) => setErr(e.message));
  useEffect(() => { api.getProfiles().then(setProfiles).catch((e) => setErr(e.message)); refreshCars(); }, []);

  return (
    <div className="app">
      <header>
        <h1 onClick={() => { setCar(null); setSession(null); }}>speedTech</h1>
        <span className="sub">BMW MS41 log analyzer</span>
        {(car || session) && <button className="link" onClick={() => { setSession(null); setCar(car); }}>← back</button>}
      </header>
      {err && <div className="error" onClick={() => setErr(null)}>{err} (dismiss)</div>}

      {!car && <CarsView profiles={profiles} cars={cars} onCreate={refreshCars} onOpen={setCar} setErr={setErr} />}
      {car && !session && <CarView car={car} onOpenSession={(d) => setSession(d)} setErr={setErr} />}
      {session && car && <SessionView car={car} sessionId={session.id} label={session.label} a={session.derived} setErr={setErr} />}
    </div>
  );
}

function CarsView({ profiles, cars, onCreate, onOpen, setErr }: {
  profiles: EngineProfile[]; cars: Car[]; onCreate: () => void; onOpen: (c: Car) => void; setErr: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [fi, setFi] = useState(false);
  useEffect(() => { if (profiles[0] && !profileId) setProfileId(profiles[0].id); }, [profiles]);

  const submit = async () => {
    try {
      await api.createCar({ name, engine_profile_id: profileId, forced_induction: { enabled: fi, type: fi ? "turbo" : "none" } });
      setName(""); onCreate();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="cols">
      <section>
        <h2>Cars</h2>
        {cars.length === 0 && <p className="muted">No cars yet — create one →</p>}
        <ul className="list">
          {cars.map((c, i) => (
            <li key={c.id} style={{ "--i": i } as React.CSSProperties} onClick={() => onOpen(c)}>
              <strong>{c.name}</strong>
              <span className="muted">{c.engine_label} · {c.ecu} · {c.forced_induction_json.enabled ? c.forced_induction_json.type : "NA"}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>New car</h2>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="E36 hybrid" /></label>
        <label>Engine
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={fi} onChange={(e) => setFi(e.target.checked)} /> Forced induction (turbo)</label>
        <button disabled={!name || !profileId} onClick={submit}>Create car</button>
      </section>
    </div>
  );
}

function CarView({ car, onOpenSession, setErr }: {
  car: Car; onOpenSession: (d: { id: string; label: string | null; derived: Analysis }) => void; setErr: (s: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => api.getSessions(car.id).then(setSessions).catch((e) => setErr(e.message));
  useEffect(() => { refresh(); }, [car.id]);

  const upload = async () => {
    setBusy(true);
    try { await api.uploadSession(car.id, files, label); setFiles([]); setLabel(""); refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const open = async (id: string) => {
    try { const s = await api.getSession(id); onOpenSession({ id: s.id, label: s.label, derived: s.derived }); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="cols">
      <section>
        <h2>{car.name} <span className="muted">{car.engine_label}</span></h2>
        {sessions.length === 0 && <p className="muted">No sessions — upload a batch →</p>}
        <ul className="list">
          {sessions.map((s, i) => (
            <li key={s.id} style={{ "--i": i } as React.CSSProperties} onClick={() => open(s.id)}>
              <strong>{s.label ?? "session"}</strong>
              <span className="muted">{new Date(s.uploaded_at).toLocaleString()}</span>
              {s.headline && <span className="headline">{s.headline}</span>}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Upload batch</h2>
        <p className="muted">RomRaider CSV{car.forced_induction_json.enabled ? " + Innovate .log.txt for boost" : ""}.</p>
        <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="3rd gear pull" /></label>
        <button data-busy={busy || undefined} disabled={busy || files.length === 0} onClick={upload}>{busy ? "Analyzing…" : "Upload & analyze"}</button>
      </section>
    </div>
  );
}

function SessionView({ car, sessionId, label, a, setErr }: { car: Car; sessionId: string; label: string | null; a: Analysis; setErr: (s: string) => void }) {
  const [diff, setDiff] = useState<import("./api").DiffResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const compare = async () => {
    setComparing(true);
    try { setDiff(await api.compareSession(sessionId, "prev")); }
    catch (e) { setErr((e as Error).message); } finally { setComparing(false); }
  };
  const rpm = car.config_json.rpm_axis as number[];
  const load = car.config_json.load_axis as number[];
  const ignVals = a.maps.ign.map((c) => c.mean);
  const ignMin = Math.min(...ignVals, 0), ignMax = Math.max(...ignVals, 1);
  const boostVals = a.maps.boost?.map((c) => c.mean) ?? [];

  return (
    <div>
      <h2>{label ?? "Session"} <span className="muted">{car.name}</span></h2>

      <div className="segments">
        {Object.entries(a.segments).map(([k, v], i) => <span key={k} style={{ "--i": i } as React.CSSProperties} className={`seg ${k}`}>{k}: {v}</span>)}
      </div>

      <h3>Findings</h3>
      <ul className="findings">
        {a.findings.map((f, i) => <FindingRow key={i} f={f} i={i} />)}
        {a.findings.length === 0 && <li className="muted">No findings.</li>}
      </ul>

      {a.recommendations.length > 0 && <>
        <h3>Recommendations</h3>
        <ul className="findings">{a.recommendations.map((f, i) => <FindingRow key={i} f={f} i={i} />)}</ul>
      </>}

      <h3>Compare vs history <button data-busy={comparing || undefined} onClick={compare} disabled={comparing}>{comparing ? "comparing…" : "vs previous session"}</button></h3>
      {diff && (diff.baseline === null
        ? <p className="muted">{diff.message}</p>
        : <>
            <p className="muted">baseline: {diff.baseline} · {diff.compared_cells} cells compared · {diff.insufficient} insufficient</p>
            <ul className="findings">
              {diff.findings.map((f, i) => (
                <li key={i} style={{ "--i": i } as React.CSSProperties} className={`finding ${f.type === "regression" ? "critical" : f.type === "improvement" ? "info" : "warn"}`}>
                  <span className="sev">{f.type}</span>
                  <span className="code">{f.metric} {f.delta > 0 ? "+" : ""}{f.delta.toFixed(2)}</span>
                  <span className="msg">{f.message}</span>
                </li>
              ))}
              {diff.findings.length === 0 && <li className="muted">No significant changes vs baseline.</li>}
            </ul>
          </>)}

      <h3>Maps</h3>
      <div className="maps">
        <Heatmap title="AFR error (lean = red)" cells={a.maps.afr_error} rpmAxis={rpm} loadAxis={load} color={divergeColor(1.5)} fmt={(v) => (v > 0 ? "+" : "") + v.toFixed(1)} index={0} />
        <Heatmap title="Knock (° pulled)" cells={a.maps.knock} rpmAxis={rpm} loadAxis={load} color={knockColor} index={1} />
        <Heatmap title="Ignition advance (°)" cells={a.maps.ign} rpmAxis={rpm} loadAxis={load} color={seqColor(ignMin, ignMax)} index={2} />
        {a.maps.boost && a.maps.boost.length > 0 &&
          <Heatmap title="Boost (psi)" cells={a.maps.boost} rpmAxis={rpm} loadAxis={load} color={seqColor(Math.min(...boostVals), Math.max(...boostVals))} index={3} />}
      </div>

      {a.quality.issues.length > 0 && <>
        <h3>Data quality</h3>
        <ul className="muted">{a.quality.issues.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </>}
    </div>
  );
}

function FindingRow({ f, i = 0 }: { f: Finding; i?: number }) {
  return (
    <li className={`finding ${f.severity}`} style={{ "--i": i } as React.CSSProperties}>
      <span className="sev">{f.severity}</span>
      <span className="code">{f.code}</span>
      <span className="msg">{f.message}</span>
    </li>
  );
}
