export function fetchForwardSnapshot(args: { instruments: import("../thalex-instrument.ts").ThalexInstrument[]; spot: number;
  asset: string; signal?: AbortSignal }): Promise<{ nodes: { seconds: number; iv: number }[];
    asOf: number; spot: number; failures: string[]; source: string }>;
