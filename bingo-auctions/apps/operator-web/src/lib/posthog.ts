// PostHog client for operator-web. We don't initialize at module load —
// the operator's identity isn't known until the layout fetches it. The
// PostHogProvider component handles init + identify in one place.
//
// Use cases:
//   - Track operator funnel: signup → onboarding → first auction → first
//     paid invoice.
//   - Feature flags (PostHog free tier covers this) for gradual rollout.

'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

let initialized = false;

export function initPostHog() {
  if (initialized) return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    capture_pageview: true,
    capture_pageleave: true,
    persistence: 'localStorage+cookie',
  });
  initialized = true;
}

export function PostHogIdentify({
  userId,
  operatorId,
  role,
}: {
  userId: string | null;
  operatorId: string | null;
  role: string | null;
}) {
  useEffect(() => {
    initPostHog();
    if (!initialized) return;
    if (userId) {
      posthog.identify(userId, {
        operator_id: operatorId,
        role,
      });
    } else {
      posthog.reset();
    }
  }, [userId, operatorId, role]);
  return null;
}

export { posthog };
