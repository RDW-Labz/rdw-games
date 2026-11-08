import { describe, expect, it } from 'vitest';
import { feedbackAck } from './feedback-ack';

describe('feedbackAck', () => {
  it('thanks the clocked-in worker by name', () => {
    expect(feedbackAck('Pat')).toEqual({
      title: 'Got it, Pat.',
      body: 'Braden and Jared have it. Their reply and the status show under "Your reports" on this screen.',
    });
  });
  it('still confirms when nobody is clocked in', () => {
    expect(feedbackAck(null).title).toBe('Got it.');
    expect(feedbackAck('   ').title).toBe('Got it.');
  });
});
