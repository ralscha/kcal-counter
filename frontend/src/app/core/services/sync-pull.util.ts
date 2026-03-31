export interface PullCursorState {
  lastSeq: number;
  templateCount: number;
  entryCount: number;
  pendingMutationCount: number;
  hasSnapshot: boolean;
}

export function resolvePullSinceSeq({
  lastSeq,
  templateCount,
  entryCount,
  hasSnapshot,
}: PullCursorState): number {
  if (lastSeq === 0) {
    return 0;
  }

  const hasLocalState = hasSnapshot || templateCount > 0 || entryCount > 0;
  return hasLocalState ? lastSeq : 0;
}
