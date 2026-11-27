/** `r` の実行状態。プロセス内だけで保持し、再起動後に残さない。 */
export type ReviewRunPhase = 'reviewing' | 'reconsidering';
const activeReviews = new Map<string, ReviewRunPhase>();

export function getReviewRunPhase(sessionId: string): ReviewRunPhase | null {
  return activeReviews.get(sessionId) ?? null;
}

export function beginReviewRun(sessionId: string): boolean {
  if (activeReviews.has(sessionId)) return false;
  activeReviews.set(sessionId, 'reviewing');
  return true;
}

export function setReviewRunPhase(sessionId: string, phase: ReviewRunPhase): void {
  if (activeReviews.has(sessionId)) activeReviews.set(sessionId, phase);
}

export function endReviewRun(sessionId: string): void {
  activeReviews.delete(sessionId);
}
