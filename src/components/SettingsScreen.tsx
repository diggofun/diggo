import { useState } from "react";
import { BOT_COLORS, BOT_SHAPE_NAMES, Bot, type BotLook } from "./Bot";
import { profileBotOf } from "../preferences";
import {
  BOT_ACCESSORIES,
  accessoryOf,
  saveProfileBot,
  saveTheme,
  useProfileBot,
  useTheme,
  withAccessory,
  type BotAccessory,
  type ThemeMode,
} from "../preferences";

const THEMES: { mode: ThemeMode; label: string }[] = [
  { mode: "dark", label: "Dark" },
  { mode: "light", label: "Light" },
];


const ACCESSORY_LABELS: Record<BotAccessory, string> = {
  none: "Nothing",
  "hat:hardhat": "Hard hat",
  "hat:cap": "Cap",
  "hat:beanie": "Beanie",
  "hat:crown": "Crown",
  "hat:party": "Party hat",
  "hat:bow": "Bow",
  "hat:tophat": "Top hat",
  "eyewear:glasses": "Glasses",
  "eyewear:shades": "Shades",
  "eyewear:goggles": "Goggles",
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Settings: the colour theme (kept on this device) and the player's profile bot (saved with the
 * wallet, like the username, so it shows next to their name on the leaderboards).
 */
export function SettingsScreen({ wallet }: { wallet: string | null }) {
  const theme = useTheme();
  const { look, custom } = useProfileBot(wallet);
  const accessory = accessoryOf(look);
  const [message, setMessage] = useState("");
  const save = (next: BotLook | null) => {
    if (!wallet) return;
    setMessage("");
    void saveProfileBot(wallet, next, custom ? profileBotOf(look) : null).catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Your bot could not be saved. Try again."),
    );
  };
  const update = (next: BotLook) => save(next);

  return (
    <section className="page-shell settings-screen">
      <header className="screen-head">
        <h1>Settings</h1>
        <p>Pick a theme and dress your bot.</p>
      </header>

      <article className="settings-card">
        <h2>Theme</h2>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={theme === option.mode}
              className={theme === option.mode ? "active" : undefined}
              onClick={() => saveTheme(option.mode)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </article>

      <article className="settings-card bot-editor">
        <div className="bot-editor-preview">
          <Bot {...look} size={140} mood="idle" />
          <div>
            <h2>Your bot</h2>
            <p>
              {wallet
                ? "It stands next to your name on the leaderboards, in the header and on your profile."
                : "Connect and sign in with your wallet to pick your bot. It is saved with your wallet, like your username."}
            </p>
            {wallet && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={!custom} onClick={() => save(null)}>
                Reset
              </button>
            )}
            {message && <p className="form-message" role="alert">{message}</p>}
          </div>
        </div>

        <fieldset className="bot-editor-fields" disabled={!wallet}>

        <h3 id="bot-shape">Shape</h3>
        <div className="bot-picker" role="radiogroup" aria-labelledby="bot-shape">
          {BOT_SHAPE_NAMES.map((shape) => {
            const label = capitalize(shape);
            return (
              <button
                key={shape}
                type="button"
                role="radio"
                aria-checked={look.shape === shape}
                aria-label={label}
                title={label}
                className={look.shape === shape ? "active" : undefined}
                onClick={() => update({ ...look, shape })}
              >
                <Bot shape={shape} color={look.color} size={44} still />
              </button>
            );
          })}
        </div>

        <h3 id="bot-color">Colour</h3>
        <div className="color-picker" role="radiogroup" aria-labelledby="bot-color">
          {BOT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={look.color === color}
              aria-label={color}
              title={color}
              className={look.color === color ? "active" : undefined}
              style={{ background: color }}
              onClick={() => update({ ...look, color })}
            />
          ))}
        </div>

        <h3 id="bot-accessory">Accessory</h3>
        <p className="settings-hint">One at a time.</p>
        <div className="bot-picker" role="radiogroup" aria-labelledby="bot-accessory">
          {BOT_ACCESSORIES.map((option) => {
            const preview = withAccessory(look, option);
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={accessory === option}
                aria-label={ACCESSORY_LABELS[option]}
                title={ACCESSORY_LABELS[option]}
                className={accessory === option ? "active" : undefined}
                onClick={() => update(preview)}
              >
                <Bot {...preview} size={44} still />
                <span>{ACCESSORY_LABELS[option]}</span>
              </button>
            );
          })}
        </div>
        </fieldset>
      </article>
    </section>
  );
}
