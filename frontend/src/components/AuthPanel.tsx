import { useState } from "react";
import { Check } from "lucide-react";
import { api, type CurrentUser } from "../lib/api.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  user: CurrentUser | null;
  onAuthChange: (user: CurrentUser | null) => void;
  onClose: () => void;
  // Present when the panel was opened via a /reset-password/:token link
  // (App.tsx) — takes priority over everything else below (login/signup
  // mode, even an already-logged-in user), since visiting that link is an
  // explicit action tied to the token, not the current session.
  resetToken?: string | null;
  // Called once a reset actually succeeds, so App.tsx can navigate back to
  // "/" — resetToken itself is URL-derived, not state this component owns.
  onResetComplete?: () => void;
}

export function AuthPanel({ user, onAuthChange, onClose, resetToken, onResetComplete }: Props) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotDone, setForgotDone] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const newPasswordsMatch = confirmNewPassword.length > 0 && newPassword === confirmNewPassword;

  if (resetToken) {
    // Captured into a local const so the closure below keeps the narrowed
    // `string` type — TS doesn't retain a destructured prop's narrowing
    // inside a nested function declaration.
    const token = resetToken;

    async function handleReset(e: React.FormEvent) {
      e.preventDefault();
      setResetError(null);
      if (newPassword !== confirmNewPassword) {
        setResetError("passwords do not match");
        return;
      }
      setResetSubmitting(true);
      try {
        const loggedInUser = await api.resetPassword(token, newPassword);
        onAuthChange(loggedInUser);
        onResetComplete?.();
      } catch (err) {
        setResetError(err instanceof Error ? err.message : "something went wrong");
      } finally {
        setResetSubmitting(false);
      }
    }

    return (
      <Panel className="w-full p-3 text-sm sm:w-64">
        <PanelHeader title="Reset password" onClose={onClose} />
        <form onSubmit={handleReset} className="mt-2">
          <input
            type="password"
            required
            minLength={8}
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mb-2 w-full rounded border border-gray-300 px-2 py-1"
          />
          <div className="relative mb-2">
            <input
              type="password"
              required
              minLength={8}
              placeholder="Confirm new password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1 pr-7"
            />
            {newPasswordsMatch && (
              <Check
                size={16}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-green-600"
                aria-label="Passwords match"
              />
            )}
          </div>

          {resetError && <p className="mb-2 text-red-600">{resetError}</p>}

          <button
            type="submit"
            disabled={resetSubmitting}
            className="w-full rounded bg-sky-600 py-1 text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {resetSubmitting ? "Resetting…" : "Reset password"}
          </button>
        </form>
      </Panel>
    );
  }

  if (user) {
    return (
      <Panel className="w-full p-3 text-sm sm:w-64">
        <PanelHeader title="Account" onClose={onClose} />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="truncate">{user.email}</span>
          <button
            className="shrink-0 text-sky-700 hover:underline"
            onClick={async () => {
              await api.logout();
              onAuthChange(null);
            }}
          >
            Log out
          </button>
        </div>
      </Panel>
    );
  }

  if (mode === "forgot") {
    async function handleForgot(e: React.FormEvent) {
      e.preventDefault();
      setForgotError(null);
      setForgotSubmitting(true);
      try {
        await api.forgotPassword(forgotEmail);
        setForgotDone(true);
      } catch (err) {
        setForgotError(err instanceof Error ? err.message : "something went wrong");
      } finally {
        setForgotSubmitting(false);
      }
    }

    return (
      <Panel className="w-full p-3 text-sm sm:w-64">
        <PanelHeader title="Reset password" onClose={onClose} />
        {forgotDone ? (
          <p className="mt-2 text-gray-600">
            If that email is registered, we've sent a link to reset your password.
          </p>
        ) : (
          <form onSubmit={handleForgot} className="mt-2">
            <input
              type="email"
              required
              placeholder="Email"
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              className="mb-2 w-full rounded border border-gray-300 px-2 py-1"
            />
            {forgotError && <p className="mb-2 text-red-600">{forgotError}</p>}
            <button
              type="submit"
              disabled={forgotSubmitting}
              className="w-full rounded bg-sky-600 py-1 text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {forgotSubmitting ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
        <button
          type="button"
          className="mt-2 text-sky-700 hover:underline"
          onClick={() => {
            setMode("login");
            setForgotDone(false);
            setForgotError(null);
          }}
        >
          Back to log in
        </button>
      </Panel>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "signup" && password !== confirmPassword) {
      setError("passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      const loggedInUser = mode === "login"
        ? await api.login(email, password)
        : await api.signup(email, password);
      onAuthChange(loggedInUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel className="w-full p-3 text-sm sm:w-64">
      <PanelHeader title="Account" onClose={onClose} />
      <form onSubmit={handleSubmit} className="mt-2">
        <div className="mb-2 flex gap-3">
          <button
            type="button"
            className={mode === "login" ? "font-semibold" : "text-gray-400"}
            onClick={() => setMode("login")}
          >
            Log in
          </button>
          <button
            type="button"
            className={mode === "signup" ? "font-semibold" : "text-gray-400"}
            onClick={() => setMode("signup")}
          >
            Sign up
          </button>
        </div>

        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-2 w-full rounded border border-gray-300 px-2 py-1"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-2 w-full rounded border border-gray-300 px-2 py-1"
        />

        {mode === "signup" && (
          <div className="relative mb-2">
            <input
              type="password"
              required
              minLength={8}
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1 pr-7"
            />
            {passwordsMatch && (
              <Check
                size={16}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-green-600"
                aria-label="Passwords match"
              />
            )}
          </div>
        )}

        {error && <p className="mb-2 text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-sky-600 py-1 text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {mode === "login" ? "Log in" : "Sign up"}
        </button>
      </form>

      {mode === "login" && (
        <button
          type="button"
          className="mt-2 text-sky-700 hover:underline"
          onClick={() => setMode("forgot")}
        >
          Forgot password?
        </button>
      )}
    </Panel>
  );
}
