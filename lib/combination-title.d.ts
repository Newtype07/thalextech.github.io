export type CombinationTitleLeg = {
  expirationTs: number;
  strike: number;
  optionType: "call" | "put";
  signedQty: number;
};

export function formatCombinationTitle(legs: CombinationTitleLeg[], asset: string): string;
