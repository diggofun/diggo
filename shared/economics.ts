export const BPS_DENOMINATOR = 10_000;

export function proportionalReward(
  blockReward: number,
  assignedPower: number,
  totalPower: number,
): number {
  if (blockReward < 0 || assignedPower < 0 || totalPower <= 0) return 0;
  return Math.min(blockReward, blockReward * (assignedPower / totalPower));
}

export function reducedReward(
  currentReward: number,
  reductionBps = 2_500,
  minimumReward = 1,
): number {
  if (currentReward <= 0) return 0;
  const reduction = Math.floor((currentReward * reductionBps) / BPS_DENOMINATOR);
  return Math.max(minimumReward, currentReward - reduction);
}

export function routeUpgradePayment(amount: number): {
  recycle: number;
  burn: number;
  protocol: number;
} {
  if (amount < 0 || !Number.isFinite(amount)) throw new Error("Invalid upgrade amount");
  const burn = Math.floor(amount * 0.2);
  const protocol = Math.floor(amount * 0.1);
  return { recycle: amount - burn - protocol, burn, protocol };
}

export function clampRewardToReserve(reward: number, reserve: number): number {
  return Math.max(0, Math.min(reward, reserve));
}
