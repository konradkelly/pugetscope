import { useState } from "react";
import { Check } from "lucide-react";
import { api, type CurrentUser } from "../lib/api.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  user: CurrentUser | null;
  onAuthChange: (user: CurrentUser | null) => void;
  onClose: () => void;
}

export function AuthPanel({ user, onAuthChange, onClose }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

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
    </Panel>
  );
}
