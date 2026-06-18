import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { login } from "@/lib/fleetApi";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      qc.invalidateQueries();
      toast.success("Signed in");
      navigate("/", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "login failed";
      setError(msg || "Invalid credentials");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 border rounded-lg p-6 bg-card">
        <div>
          <h1 className="text-2xl font-bold">Firefik panel</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to continue.</p>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1.5 rounded text-sm"
            required
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1.5 rounded text-sm"
            required
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || !username.trim() || !password} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
