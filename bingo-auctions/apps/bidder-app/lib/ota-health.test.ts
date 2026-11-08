// Tests for the refused-OTA detector. The 2026-09 failure — an update that
// downloads, crashes at import and is silently rolled back — is the first case.

import { describe, it, expect } from 'vitest';
import { otaHealthMessage, parseDownloadedMark, type OtaHealthInput } from './ota-health';

const HEALTHY: OtaHealthInput = {
  downloaded: { updateId: '01a0ce8d-195a-762e-a6cf-fc01bb7e727f', at: 1 },
  runningId: '01a0ce8d-195a-762e-a6cf-fc01bb7e727f',
  isEmergencyLaunch: false,
  emergencyLaunchReason: null,
};

describe('otaHealthMessage', () => {
  it('reports an update that downloaded but is not running (the 2026-09 rollback)', () => {
    const msg = otaHealthMessage({ ...HEALTHY, runningId: '098adf06-5986-4555-8714-377cf0d811a2' });
    expect(msg).toContain('ota refused');
    expect(msg).toContain('01a0ce8d-195a-762e-a6cf-fc01bb7e727f');
    expect(msg).toContain('098adf06-5986-4555-8714-377cf0d811a2');
  });

  it('names the running bundle "embedded" when there is no id', () => {
    expect(otaHealthMessage({ ...HEALTHY, runningId: null })).toContain('runs embedded');
  });

  it('is silent when the downloaded update is the one running', () => {
    expect(otaHealthMessage(HEALTHY)).toBeNull();
  });

  it('is silent when nothing was downloaded', () => {
    expect(otaHealthMessage({ ...HEALTHY, downloaded: null })).toBeNull();
  });

  it('reports an emergency launch even with no download recorded', () => {
    const msg = otaHealthMessage({
      ...HEALTHY,
      downloaded: null,
      isEmergencyLaunch: true,
      emergencyLaunchReason: 'Failed to launch embedded or launchable update',
    });
    expect(msg).toContain('emergency launch');
    expect(msg).toContain('Failed to launch');
  });
});

describe('parseDownloadedMark', () => {
  it('reads a valid mark', () => {
    expect(parseDownloadedMark('{"updateId":"abc","at":5}')).toEqual({ updateId: 'abc', at: 5 });
  });

  it('rejects empty, corrupt and id-less marks', () => {
    expect(parseDownloadedMark(null)).toBeNull();
    expect(parseDownloadedMark('{"upd')).toBeNull();
    expect(parseDownloadedMark('{"at":5}')).toBeNull();
    expect(parseDownloadedMark('{"updateId":""}')).toBeNull();
  });
});
