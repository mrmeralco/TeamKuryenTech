export interface CoinBatch {
  id: string;
  amountCents: number;
  remainingCents: number;
  earnedDate: string;
  expiresAt: string;
  source: string;
  expiryNoticeSent: boolean;
  [metadata: string]: unknown;
}

export interface CoinLedgerEntry {
  id: string;
  kind: "earning" | "spending" | "expiration";
  source: string;
  amountCents: number;
  date: string;
  batchId?: string;
}

export interface CoinState {
  batches: CoinBatch[];
  ledger: CoinLedgerEntry[];
  lastCheckIn: string | null;
  streak: number;
  claimedCycles: string[];
}

export function addCalendarMonths(date: Date, months?: number): Date;
export function addCoinBatch(amountCents: number, source: string, date?: Date, metadata?: Record<string, unknown>): CoinBatch;
export function awardMonthlyReduction(currentKwh: number, previousKwh: number, cycleId: string): number;
export function checkIn(source?: HTMLElement): boolean;
export function coinBalanceCents(state?: CoinState): number;
export function formatCoins(cents: number): string;
export function getCoinState(options?: { reconcile?: boolean }): CoinState;
export function redeemCoinBatches(amountCents: number, windowActive?: boolean, destination?: "bill" | "subscription"): number;
export function setGameUser(userId?: string | null): void;
export function setGameCallbacks(callbacks: Record<string, unknown>): void;
export function saveMonthlyEnergyTarget(target: number): boolean;
export function getMonthlyEnergyTarget(): number;
export function rewardsPage(): string;
export function goalsPage(): string;
export function gamificationCard(): string;
export function renderGameChrome(currentPage: string): void;
export function animateNumbers(): void;
export const CHART_COLORS: string[];
