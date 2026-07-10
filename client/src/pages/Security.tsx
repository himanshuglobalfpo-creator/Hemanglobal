// client/src/pages/Security.tsx — MFA (TOTP) management + reusable Attachments.
import { useState, useEffect } from "react";
import { apiRequest, readCsrfToken } from "@/lib/queryClient";

export default function Security() {
  const [status, setStatus] = useState<"idle" | "pending" | "enabled">("idle");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [msg, setMsg] = useState("");
  const [disablePw, setDisablePw] = useState("");
  const [disableCode, setDisableCode] = useState("");

  useEffect(() => {
    // /api/auth/me doesn't expose totpEnabled; infer from setup flow. Keep it simple:
    // the section always offers setup; enable/disable calls report their own errors.
  }, []);

  const setup = async () => {
    setMsg("");
    const r = await apiRequest("POST", "/api/auth/mfa/setup", {});
    const b = await r.json();
    setSecret(b.secret);
    setUri(b.otpauthUri);
    setStatus("pending");
  };

  const enable = async () => {
    setMsg("");
    try {
      const r = await apiRequest("POST", "/api/auth/mfa/enable", { code: code.trim() });
      const b = await r.json();
      setRecovery(b.recoveryCodes);
      setStatus("enabled");
      setMsg(b.message);
    } catch (e: any) {
      setMsg(String(e.message || e));
    }
  };

  const disable = async () => {
    setMsg("");
    try {
      const r = await apiRequest("POST", "/api/auth/mfa/disable", { password: disablePw, code: disableCode.trim() });
      const b = await r.json();
      setStatus("idle");
      setSecret(""); setUri(""); setRecovery(null);
      setMsg(b.message);
    } catch (e: any) {
      setMsg(String(e.message || e));
    }
  };

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Security — Two-factor authentication</h1>
      {msg && <div className="rounded border bg-muted px-3 py-2 text-sm">{msg}</div>}

      {status === "idle" && (
        <div className="rounded-lg border p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Protect your account with an authenticator app (TOTP). Owners are required to
            enable this within 7 days of account creation.
          </p>
          <button onClick={setup} className="rounded bg-primary text-primary-foreground px-4 py-2 text-sm font-medium">
            Set up two-factor authentication
          </button>
        </div>
      )}

      {status === "pending" && (
        <div className="rounded-lg border p-4 space-y-3">
          <p className="text-sm">1. In your authenticator app, add an account by <b>manual entry</b> with this secret:</p>
          <code className="block rounded bg-muted px-3 py-2 text-sm break-all select-all">{secret}</code>
          <p className="text-xs text-muted-foreground break-all">or use this otpauth URI: {uri}</p>
          <p className="text-sm">2. Enter the current 6-digit code to confirm:</p>
          <div className="flex gap-2">
            <input className="rounded border px-3 py-2 text-sm w-40" placeholder="123456"
              value={code} onChange={(e) => setCode(e.target.value)} />
            <button onClick={enable} disabled={!code}
              className="rounded bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-60">
              Enable
            </button>
          </div>
        </div>
      )}

      {status === "enabled" && recovery && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-amber-900">
          <p className="font-medium text-sm">Recovery codes — shown ONCE. Store them somewhere safe.</p>
          <div className="grid grid-cols-2 gap-1 font-mono text-sm">
            {recovery.map((c) => <div key={c}>{c}</div>)}
          </div>
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-medium">Disable two-factor authentication</h2>
        <p className="text-xs text-muted-foreground">Requires your password AND a current code (or a recovery code).</p>
        <div className="flex flex-wrap gap-2">
          <input type="password" className="rounded border px-3 py-2 text-sm" placeholder="Password"
            value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
          <input className="rounded border px-3 py-2 text-sm w-44" placeholder="Code or recovery code"
            value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
          <button onClick={disable} disabled={!disablePw || !disableCode}
            className="rounded border px-4 py-2 text-sm disabled:opacity-60">Disable</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachments — paperclip section reused by Invoice and Bill detail views.
// Upload: raw body with metadata in query params (see server design note).
// ---------------------------------------------------------------------------
export function Attachments({ entityType, entityId }: { entityType: "invoice" | "bill"; entityId: number }) {
  const [items, setItems] = useState<Array<{ id: number; filename: string; sizeBytes: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = async () => {
    try {
      const r = await apiRequest("GET", `/api/attachments?entityType=${entityType}&entityId=${entityId}`);
      setItems(await r.json());
    } catch { /* entity may not be persisted yet */ }
  };
  useEffect(() => { refresh();   }, [entityType, entityId]);

  const upload = async (file: File) => {
    setBusy(true); setErr("");
    try {
      const token = readCsrfToken();
      const res = await fetch(
        `/api/attachments?entityType=${entityType}&entityId=${entityId}&filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream", ...(token ? { "x-csrf-token": token } : {}) },
          body: file,
        }
      );
      if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
      await refresh();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    await apiRequest("DELETE", `/api/attachments/${id}`);
    await refresh();
  };

  return (
    <div className="mt-4 rounded border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">📎 Attachments</span>
        <label className="text-sm underline cursor-pointer">
          {busy ? "Uploading…" : "Attach file"}
          <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx" disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}
      {items.length === 0 && <div className="text-xs text-muted-foreground">No attachments yet.</div>}
      {items.map((a) => (
        <div key={a.id} className="flex items-center justify-between text-sm">
          <a className="underline truncate mr-2" href={`/api/attachments/${a.id}/download`}>{a.filename}</a>
          <span className="text-xs text-muted-foreground mr-2">{Math.ceil(a.sizeBytes / 1024)} KB</span>
          <button onClick={() => remove(a.id)} className="text-xs text-red-600">delete</button>
        </div>
      ))}
    </div>
  );
}
