/**
 * Set or change the public username (worker/profile.ts).
 *
 * The rules are the shared ones (shared/username.ts), so an obvious mistake is answered before the
 * request leaves the browser - but the server still decides, and its answer is what is shown. Each
 * refusal gets its own line: taken (409), too soon (429, with the wait it reported), invalid (400)
 * and a session that has to be renewed (401). A saved name lands in the shared cache, so the header
 * and the leaderboard update at the same moment.
 */
import { useState, type FormEvent } from "react";
import { USERNAME_RULES, formatUsernameCooldown, usernameRejectionMessage, validateUsername } from "../../shared/username";
import { ApiError, setUsername } from "../api";
import { shortAddress } from "../format";
import { rememberUsername, useUsername } from "../username";

export interface UsernameEditorProps {
  /** The signed-in wallet, or null when the editor should not be shown at all. */
  wallet: string | null;
  onChanged?(username: string): void;
}

/** The line to show for a refused save: the server's own copy wherever it has some. */
function refusalMessage(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.status === 409) return "That username is already taken.";
    if (caught.status === 429) {
      const wait = caught.retryAfterSec ?? USERNAME_RULES.cooldownSeconds;
      return "You can change your username again in " + formatUsernameCooldown(wait) + ".";
    }
    if (caught.status === 401) return "Sign in again to change your username.";
    return caught.message;
  }
  return "Could not save that username. Try again.";
}

export function UsernameEditor({ wallet, onChanged }: UsernameEditorProps) {
  const { username, loading } = useUsername(wallet);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  // Callers key this component by wallet, so a different player gets a fresh form rather than one
  // player's half-typed draft.
  if (wallet === null) return null;
  // A plain local, so the closure below keeps the non-null narrowing.
  const viewer = wallet;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const validation = validateUsername(draft);
    if (!validation.ok) {
      setError(usernameRejectionMessage(validation.reason));
      setSaved("");
      return;
    }
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const stored = await setUsername(validation.username);
      rememberUsername(viewer, stored.username);
      setDraft("");
      setSaved("You are " + stored.username + ".");
      onChanged?.(stored.username);
    } catch (caught) {
      setError(refusalMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="username-editor" onSubmit={(event) => void submit(event)}>
      <p className="report-mine">
        {loading && username === null
          ? "Checking your username…"
          : username === null
            ? "No username yet: leaderboards show " + shortAddress(viewer) + "."
            : "Your username: " + username}
      </p>
      <label>
        <span>{username === null ? "Pick a username" : "Change username"}</span>
        <input
          className="admin-input"
          type="text"
          value={draft}
          maxLength={USERNAME_RULES.maxLength}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          placeholder={username ?? "miner_" + shortAddress(viewer).replace("…", "")}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
            setSaved("");
          }}
        />
      </label>
      <button className="btn btn-primary" type="submit" disabled={saving || draft.trim().length === 0}>
        {saving ? "Saving…" : "Save username"}
      </button>
      <small>3-20 characters: letters, numbers and underscores. Changing it again waits 7 days.</small>
      {saved && <p className="form-message">{saved}</p>}
      {error && (
        <p className="wallet-menu-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
