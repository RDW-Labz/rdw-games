// What a worker sees right after sending feedback (owner 2026-10-30). The
// name is the PIN-identified worker on this phone (floor phones share one
// login), so the person who typed it is the one thanked.
export const FEEDBACK_OWNERS = 'Braden and Jared';

export function feedbackAck(workerName: string | null | undefined): { title: string; body: string } {
  const name = workerName?.trim();
  return {
    title: name ? `Got it, ${name}.` : 'Got it.',
    body: `${FEEDBACK_OWNERS} have it. Their reply and the status show under "Your reports" on this screen.`,
  };
}

/** Label in front of the reply under "Your reports". */
export const REPLY_LABEL = 'Reply:';
