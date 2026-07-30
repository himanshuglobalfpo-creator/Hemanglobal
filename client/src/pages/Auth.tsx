// ============================================================================
// AUTH PAGE — QBO-style: social login, email+password, email OTP code,
// signup, forgot password, reset password.
// ============================================================================
// Rendered by the AuthGate in App.tsx whenever there is no active session.
// The reset-password view is reachable from the emailed link:
//   {APP_BASE_URL}/#/reset-password?token=...
// (hash routing — we parse the token straight from window.location).
//
// Backend routes used here:
//   GET  /api/auth/google           — starts Google OAuth (full-page redirect)
//   GET  /api/auth/microsoft        — starts Microsoft OAuth (full-page redirect)
//   POST /api/auth/login            — email + password
//   POST /api/auth/signup           — name, orgName, email, password
//   POST /api/auth/otp/request      — sends 6-digit email code
//   POST /api/auth/otp/verify       — verifies code and logs in
//   POST /api/auth/request-password-reset
//   POST /api/auth/reset-password

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Logo } from "@/components/Layout";

type View = "login" | "signup" | "otp-request" | "otp-verify" | "forgot" | "reset";

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 10 * 60; // code expires in 10 minutes
const RESEND_AFTER_SECONDS = 30; // "Resend" link appears after 30s
const FETCH_TIMEOUT_MS = 10_000; // never spin longer than 10 seconds

// ---------------------------------------------------------------------------
// URL helpers (hash routing — params can live in either search or hash)
// ---------------------------------------------------------------------------
function paramFromLocation(name: string): string | null {
  const haystack = window.location.search + window.location.hash;
  const m = haystack.match(new RegExp(`[?&]${name}=([^&#]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function tokenFromLocation(): string | null {
  return paramFromLocation("token");
}

function initialView(): View {
  return (window.location.hash + window.location.pathname).includes("reset-password") && tokenFromLocation()
    ? "reset"
    : "login";
}

// Server error envelopes look like `400: {"error":"..."}` after apiRequest throws.
function friendlyError(e: any): string {
  const raw = String(e?.message || e || "Something went wrong");
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Connection error. Please check your internet and try again.";
  }
  const m = raw.match(/^\d{3}:\s*(.*)$/s);
  const body = m ? m[1] : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) return String(parsed.error);
  } catch {
    /* not JSON — fall through */
  }
  return body;
}

// Never let a request spin forever — reject after FETCH_TIMEOUT_MS.
function withTimeout<T>(p: Promise<T>, ms = FETCH_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Connection error. Please check your internet and try again.")),
        ms,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Brand SVGs
// ---------------------------------------------------------------------------
function EnvelopeIllustration() {
  return (
    <svg viewBox="0 0 96 72" className="h-20 w-auto mx-auto text-primary" fill="none" aria-hidden="true">
      <rect x="6" y="10" width="84" height="54" rx="6" stroke="currentColor" strokeWidth="3" />
      <path d="M8 14l40 30 40-30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 60l26-22M84 60L58 38" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Password strength: 4 dots that fill green as the password gets stronger.
//   1: length >= 8   2: has uppercase   3: has number   4: has special char
// ---------------------------------------------------------------------------
function passwordScore(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

function PasswordStrength({ password }: { password: string }) {
  const score = passwordScore(password);
  const labels = ["", "Weak", "Fair", "Good", "Strong"];
  return (
    <div className="flex items-center gap-2 pt-1" data-testid="password-strength">
      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={
              "h-2 w-2 rounded-full transition-colors " +
              (score >= i ? "bg-green-500" : "bg-gray-300")
            }
          />
        ))}
      </div>
      {password.length > 0 && (
        <span className={"text-xs " + (score >= 3 ? "text-green-600" : "text-muted-foreground")}>
          {labels[score]}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6-box OTP input — plain React inputs, no libraries.
// Auto-advance, backspace-to-previous, digits only, full-code paste support,
// numeric keyboard + SMS autofill on mobile.
// ---------------------------------------------------------------------------
function OtpInput({
  value,
  onChange,
  disabled,
}: {
  value: string; // up to 6 digits
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? "");

  const setDigit = (index: number, digit: string) => {
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join("").slice(0, OTP_LENGTH));
  };

  const handleChange = (index: number, raw: string) => {
    const cleaned = raw.replace(/\D/g, "");
    if (!cleaned) {
      setDigit(index, "");
      return;
    }
    if (cleaned.length > 1) {
      // Multi-character input (e.g. mobile keyboard suggestion) — treat as paste.
      applyPaste(index, cleaned);
      return;
    }
    setDigit(index, cleaned);
    if (index < OTP_LENGTH - 1) refs.current[index + 1]?.focus();
  };

  const applyPaste = (startIndex: number, text: string) => {
    const cleaned = text.replace(/\D/g, "");
    if (!cleaned) return;
    // Full-code paste fills from the start; partial paste fills from the cursor.
    const from = cleaned.length >= OTP_LENGTH ? 0 : startIndex;
    const next = digits.slice();
    for (let i = 0; i < cleaned.length && from + i < OTP_LENGTH; i++) {
      next[from + i] = cleaned[i];
    }
    onChange(next.join("").slice(0, OTP_LENGTH));
    const focusAt = Math.min(from + cleaned.length, OTP_LENGTH - 1);
    refs.current[focusAt]?.focus();
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus();
      setDigit(index - 1, "");
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && index > 0) {
      refs.current[index - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowRight" && index < OTP_LENGTH - 1) {
      refs.current[index + 1]?.focus();
      e.preventDefault();
    }
  };

  return (
    <div className="flex justify-center gap-2" data-testid="input-otp-boxes">
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          value={digit}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => {
            e.preventDefault();
            applyPaste(i, e.clipboardData.getData("text"));
          }}
          onFocus={(e) => e.target.select()}
          disabled={disabled}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={OTP_LENGTH} // allow paste of the full code into one box
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoFocus={i === 0}
          aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
          data-testid={`input-otp-${i}`}
          className="w-12 h-14 text-center text-2xl font-semibold rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Auth() {
  const [view, setViewRaw] = useState<View>(initialView);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  // Shared fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Signup-only
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  // Reset-only
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // OTP
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Banners / highlights
  const [verifiedBanner, setVerifiedBanner] = useState(false);
  const [signupSuccessBanner, setSignupSuccessBanner] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const setView = (v: View) => {
    setOtpError(null);
    if (v === "forgot") setForgotSent(false);
    setViewRaw(v);
  };

  // Handle URL params once on mount: OAuth errors, verification, invites.
  useEffect(() => {
    const error = paramFromLocation("error");
    if (error === "google_failed") {
      toast({
        title: "Error",
        description: "Google sign-in failed. Please try again.",
        variant: "destructive",
      });
    } else if (error === "microsoft_failed") {
      toast({
        title: "Error",
        description: "Microsoft sign-in failed. Please try again.",
        variant: "destructive",
      });
    }
    if (paramFromLocation("verified") === "1") setVerifiedBanner(true);
    const invite = paramFromLocation("invite");
    if (invite) {
      setInviteToken(invite);
      setViewRaw("signup");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1-second tick for the OTP countdown.
  useEffect(() => {
    if (view !== "otp-verify" || !otpExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [view, otpExpiresAt]);

  const secondsLeft = otpExpiresAt ? Math.max(0, Math.ceil((otpExpiresAt - now) / 1000)) : 0;
  const otpExpired = otpExpiresAt !== null && secondsLeft === 0;
  const secondsSinceSent = otpExpiresAt ? OTP_TTL_SECONDS - secondsLeft : 0;
  const canResend = secondsSinceSent >= RESEND_AFTER_SECONDS;
  const timerLabel = useMemo(() => {
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }, [secondsLeft]);

  async function submit(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await withTimeout(fn());
    } catch (e: any) {
      toast({ title: "Error", description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const refreshSession = async () => {
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    await queryClient.invalidateQueries();
  };

  // MFA two-step: when the password is right but TOTP is enabled, the server
  // returns { mfaRequired, mfaToken } instead of a session — we prompt for the
  // 6-digit (or recovery) code and finish at /api/auth/mfa/verify.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  const doLogin = () =>
    submit(async () => {
      const r = await apiRequest("POST", "/api/auth/login", { email, password });
      const body = await r.json();
      if (body?.mfaRequired && body?.mfaToken) {
        setMfaToken(body.mfaToken);
        setMfaCode("");
        return;
      }
      await refreshSession();
    });

  const doMfaVerify = () =>
    submit(async () => {
      await apiRequest("POST", "/api/auth/mfa/verify", { mfaToken, code: mfaCode.trim() });
      setMfaToken(null);
      await refreshSession();
    });

  const doSignup = () =>
    submit(async () => {
      await apiRequest("POST", "/api/auth/signup", {
        email,
        password,
        name,
        orgName,
        ...(inviteToken ? { inviteToken } : {}),
      });
      setSignupSuccessBanner(true);
      // Redirect to /#/ only once the session is confirmed via invalidateQueries.
      await refreshSession();
      window.location.hash = "#/";
    });

  const sendOtp = useCallback(
    (targetEmail: string) =>
      submit(async () => {
        await apiRequest("POST", "/api/auth/otp/request", { email: targetEmail });
        setOtpEmail(targetEmail);
        setOtpCode("");
        setOtpError(null);
        setOtpExpiresAt(Date.now() + OTP_TTL_SECONDS * 1000);
        setNow(Date.now());
        setViewRaw("otp-verify");
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const doVerifyOtp = async () => {
    setBusy(true);
    setOtpError(null);
    try {
      await withTimeout(
        (async () => {
          await apiRequest("POST", "/api/auth/otp/verify", { email: otpEmail, code: otpCode });
          await refreshSession();
        })(),
      );
    } catch (e: any) {
      // Show errors like "Incorrect code. 2 attempts remaining." inline below the boxes.
      setOtpError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const doForgot = () =>
    submit(async () => {
      await apiRequest("POST", "/api/auth/request-password-reset", { email });
      setForgotSent(true);
    });

  const doReset = () =>
    submit(async () => {
      if (newPassword !== confirmPassword) throw new Error("Passwords do not match");
      const token = tokenFromLocation();
      if (!token) throw new Error("Reset link is missing its token — request a new one.");
      await apiRequest("POST", "/api/auth/reset-password", { token, newPassword });
      toast({ title: "Password updated", description: "Sign in with your new password." });
      window.location.hash = "#/";
      setView("login");
    });

  const onEnter = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") fn();
  };

  const signupReady =
    !!name && !!orgName && !!email && password.length >= 8 && termsAccepted;

  const titles: Record<View, { title: string; subtitle: string }> = {
    login: { title: "Welcome back", subtitle: "Sign in to your account" },
    signup: { title: "Create your account", subtitle: "Start your free trial — no credit card needed" },
    "otp-request": { title: "Sign in with a code", subtitle: "We'll email you a 6-digit sign-in code" },
    "otp-verify": { title: "Enter your code", subtitle: `We sent a 6-digit code to ${otpEmail}` },
    forgot: { title: "Reset your password", subtitle: "Enter your email and we'll send a reset link" },
    reset: { title: "Choose a new password", subtitle: "This will log you out of all other devices" },
  };

  if (mfaToken) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm w-full rounded-lg border p-6 space-y-4">
          <h1 className="text-lg font-semibold">Two-factor authentication</h1>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator app, or one of your recovery codes.
          </p>
          <input
            autoFocus
            className="w-full rounded border px-3 py-2 text-sm"
            placeholder="123456 or XXXXX-XXXXX"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && mfaCode && doMfaVerify()}
          />
          <div className="flex gap-2">
            <button disabled={busy || !mfaCode} onClick={doMfaVerify}
              className="flex-1 rounded bg-primary text-primary-foreground px-3 py-2 text-sm font-medium disabled:opacity-60">
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button onClick={() => setMfaToken(null)} className="rounded border px-3 py-2 text-sm">Back</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 py-8">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md p-4 sm:p-8 space-y-6">
        <div className="flex justify-center">
          <Logo />
        </div>

        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold tracking-tight" data-testid="text-auth-title">
            {titles[view].title}
          </h1>
          <p className="text-sm text-muted-foreground">{titles[view].subtitle}</p>
        </div>

        {/* ?verified=1 — email verification success */}
        {verifiedBanner && (
          <div
            className="rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-3"
            data-testid="banner-email-verified"
          >
            ✓ Email verified! You can now sign in.
          </div>
        )}

        {/* ?invite=TOKEN — invited user */}
        {inviteToken && (view === "login" || view === "signup") && (
          <div
            className="rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-3"
            data-testid="banner-invited"
          >
            You've been invited — create an account or sign in to join your team.
          </div>
        )}

        {/* Signup success */}
        {signupSuccessBanner && (
          <div
            className="rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-3"
            data-testid="banner-signup-success"
          >
            Account created! Check your email to verify your address.
          </div>
        )}

        {/* ================================ LOGIN ================================ */}
        {view === "login" && (
          <div className="space-y-5">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-login-email"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="login-password">Password</Label>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setView("forgot")}
                    data-testid="link-forgot-password"
                  >
                    Forgot password?
                  </button>
                </div>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={onEnter(doLogin)}
                  data-testid="input-login-password"
                />
              </div>
              <Button
                className="w-full h-11"
                onClick={doLogin}
                disabled={busy || !email || !password}
                data-testid="button-login"
              >
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-center">
                <button
                  type="button"
                  className="text-[13px] text-muted-foreground underline hover:text-foreground"
                  onClick={() => setView("otp-request")}
                  data-testid="link-otp-request"
                >
                  Email me a code instead
                </button>
              </p>
            </div>

            <p className="text-sm text-center text-muted-foreground">
              Don't have an account?{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setView("signup")}
                data-testid="link-to-signup"
              >
                Create one
              </button>
            </p>
          </div>
        )}

        {/* ================================ SIGNUP =============================== */}
        {view === "signup" && (
          <div className="space-y-5">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="signup-name">Your full name</Label>
                <Input
                  id="signup-name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="input-signup-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-org">Organization / company name</Label>
                <Input
                  id="signup-org"
                  placeholder="Acme Consulting LLC"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  data-testid="input-signup-org"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-email">Work email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-signup-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-password">Password</Label>
                <Input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-signup-password"
                />
                <PasswordStrength password={password} />
              </div>
              <label className="flex items-start gap-2 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  data-testid="checkbox-signup-terms"
                />
                <span>
                  I agree to the{" "}
                  <a href="/terms" className="underline hover:text-foreground" target="_blank" rel="noreferrer">
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a href="/privacy" className="underline hover:text-foreground" target="_blank" rel="noreferrer">
                    Privacy Policy
                  </a>
                </span>
              </label>
              <Button
                className="w-full h-11"
                onClick={doSignup}
                disabled={busy || !signupReady}
                data-testid="button-signup"
              >
                {busy ? "Creating…" : "Create account"}
              </Button>
            </div>

            <p className="text-sm text-center text-muted-foreground">
              Already have an account?{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setView("login")}
                data-testid="link-to-login"
              >
                Sign in
              </button>
            </p>
          </div>
        )}

        {/* ============================ OTP — REQUEST ============================ */}
        {view === "otp-request" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="otp-email">Email</Label>
              <Input
                id="otp-email"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={onEnter(() => email && sendOtp(email))}
                data-testid="input-otp-email"
              />
            </div>
            <Button
              className="w-full h-11"
              onClick={() => sendOtp(email)}
              disabled={busy || !email}
              data-testid="button-otp-request"
            >
              {busy ? "Sending…" : "Send code"}
            </Button>
            <p className="text-sm text-center text-muted-foreground">
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setView("login")}
                data-testid="link-back-to-login"
              >
                ← Back to sign in
              </button>
            </p>
          </div>
        )}

        {/* ============================= OTP — VERIFY ============================ */}
        {view === "otp-verify" && (
          <div className="space-y-4">
            <OtpInput value={otpCode} onChange={setOtpCode} disabled={busy || otpExpired} />

            {otpError && (
              <p className="text-sm text-destructive text-center" data-testid="text-otp-error">
                {otpError}
              </p>
            )}

            <Button
              className="w-full h-11"
              onClick={doVerifyOtp}
              disabled={busy || otpCode.length !== OTP_LENGTH || otpExpired}
              data-testid="button-otp-verify"
            >
              {busy ? "Verifying…" : "Verify code"}
            </Button>

            <div className="text-center text-sm">
              {otpExpired ? (
                <p data-testid="text-otp-expired">
                  <span className="text-destructive">Code expired.</span>{" "}
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() => sendOtp(otpEmail)}
                    data-testid="link-otp-new-code"
                  >
                    Request a new code
                  </button>
                </p>
              ) : (
                <p className="text-muted-foreground" data-testid="text-otp-timer">
                  Code expires in {timerLabel}
                </p>
              )}
            </div>

            {!otpExpired && canResend && (
              <p className="text-sm text-center text-muted-foreground">
                Didn't get the code?{" "}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => sendOtp(otpEmail)}
                  data-testid="link-otp-resend"
                >
                  Resend
                </button>
              </p>
            )}

            <p className="text-sm text-center text-muted-foreground">
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setView("login")}
              >
                ← Back to sign in
              </button>
            </p>
          </div>
        )}

        {/* =============================== FORGOT ================================ */}
        {view === "forgot" &&
          (forgotSent ? (
            <div className="space-y-4 text-center" data-testid="panel-forgot-sent">
              <EnvelopeIllustration />
              <h2 className="text-lg font-medium">Check your inbox</h2>
              <p className="text-sm text-muted-foreground">
                If that address is registered, a password reset link is on its way to{" "}
                <span className="font-medium text-foreground">{email}</span>.
              </p>
              <p className="text-sm text-muted-foreground">
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => setView("login")}
                >
                  ← Back to sign in
                </button>
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={onEnter(doForgot)}
                  data-testid="input-forgot-email"
                />
              </div>
              <Button
                className="w-full h-11"
                onClick={doForgot}
                disabled={busy || !email}
                data-testid="button-forgot"
              >
                {busy ? "Sending…" : "Send reset link"}
              </Button>
              <p className="text-sm text-center text-muted-foreground">
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => setView("login")}
                >
                  ← Back to sign in
                </button>
              </p>
            </div>
          ))}

        {/* ================================ RESET ================================ */}
        {view === "reset" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                data-testid="input-reset-password"
              />
              <PasswordStrength password={newPassword} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm">Confirm new password</Label>
              <Input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={onEnter(doReset)}
                data-testid="input-reset-confirm"
              />
            </div>
            <Button
              className="w-full h-11"
              onClick={doReset}
              disabled={busy || newPassword.length < 8 || confirmPassword.length < 8}
              data-testid="button-reset"
            >
              {busy ? "Updating…" : "Update password"}
            </Button>
          </div>
        )}
      </div>

      {/* Footer — outside the card */}
      <p className="mt-6 text-[11px] text-muted-foreground">
        © 2025 LedgerLite ·{" "}
        <a href="/privacy" className="hover:text-foreground">
          Privacy
        </a>{" "}
        ·{" "}
        <a href="/terms" className="hover:text-foreground">
          Terms
        </a>
      </p>
    </div>
  );
}
