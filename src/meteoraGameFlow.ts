export interface MeteoraActivationResult {
  player: { streak: number };
}

export interface MeteoraMiningStart {
  activate(): Promise<MeteoraActivationResult>;
  refresh(): Promise<void>;
}

/** Activation is the idempotent authority that opens the shift and assigns its mine. */
export async function startMeteoraMining(flow: MeteoraMiningStart): Promise<number> {
  const activated = await flow.activate();
  await flow.refresh();
  return activated.player.streak;
}
