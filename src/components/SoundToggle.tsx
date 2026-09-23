/**
 * The header's sound switch.
 *
 * Audio is opt-in and remembered per browser (see src/sound.ts): the button starts muted, states
 * its own state through aria-pressed, and plays a short confirmation when it is switched on so the
 * player can tell immediately that the game now has sound.
 */
import { Volume2, VolumeX } from "lucide-react";
import { useSoundEnabled } from "../sound";

export function SoundToggle() {
  const [enabled, setEnabled] = useSoundEnabled();
  const label = enabled ? "Mute sound effects" : "Unmute sound effects";
  return (
    <button
      type="button"
      className={"sound-toggle" + (enabled ? " is-on" : "")}
      aria-pressed={enabled}
      title={label}
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}
      <span className="sr-only">{label}</span>
    </button>
  );
}

