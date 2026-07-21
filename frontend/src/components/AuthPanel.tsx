import { useState } from "react";
import { api, type CurrentUser } from "../lib/api.js";

interface Props {
  user: CurrentUser | null;
  onAuthChange: (user: CurrentUser | null) => void;
}

export function AuthPanel({ user, onAuthChange }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-white/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
        <span>{user.email}</span>
        <button
          className="text-sky-700 hover:underline"
          onClick={async () => {
            await api.logout();
            onAuthChange(null);
          }}
        >
          Log out
        </button>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
    <form
      onSubmit={handleSubmit}
      className="w-64 rounded-lg bg-white/95 p-4 text-sm shadow-lg backdrop-blur"
    >
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

      {error && <p className="mb-2 text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded bg-sky-600 py-1 text-white hover:bg-sky-700 disabled:opacity-50"
      >
        {mode === "login" ? "Log in" : "Sign up"}
      </button>
    </form>
  );
}
