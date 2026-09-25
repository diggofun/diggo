export interface SettledClaimAllSummary {
  items: Array<unknown>;
  totalItems: number;
  remainingItems: number;
  complete: boolean;
}

/** Settlement copy must describe the batch that settled, not the wallet's whole balance. */
export function settledClaimAllNotice(batch: SettledClaimAllSummary): string {
  if (!Number.isInteger(batch.totalItems) || batch.totalItems < batch.items.length) {
    throw new Error("The backend returned inconsistent claim-all totals. No collection was reported.");
  }
  if (!Number.isInteger(batch.remainingItems) || batch.remainingItems < 0) {
    throw new Error("The backend returned an invalid claim-all remainder. No collection was reported.");
  }
  if (batch.totalItems !== batch.items.length + batch.remainingItems) {
    throw new Error("The backend returned inconsistent claim-all totals. No collection was reported.");
  }
  if (batch.complete !== (batch.remainingItems === 0)) {
    throw new Error("The backend returned inconsistent claim-all continuation data. No collection was reported.");
  }

  if (batch.remainingItems > 0) {
    return `Collected ${batch.items.length} of ${batch.totalItems} coins in one transaction. ${batch.remainingItems} more remain; run Claim all again for the next batch.`;
  }
  return `Collected all ${batch.totalItems} accrued coins to your wallet in one transaction.`;
}
