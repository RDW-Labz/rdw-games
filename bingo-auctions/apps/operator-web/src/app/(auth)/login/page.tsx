// Shared login page — bingoauctions.com/login
//
// Server component wrapper. Exports metadata and delegates all interactive
// auth logic to LoginFormClient (the 'use client' boundary lives there).
//
// /signup is the bidder signup page. BinGo Auctions is a single-operator
// auction house — there is no operator onboarding flow.

import type { Metadata } from 'next';
import { LoginFormClient } from './LoginFormClient';

export const metadata: Metadata = {
  title: 'Sign In',
  description:
    'Sign in to your BinGo Auctions account to bid on live auctions, track your bids, and manage pickups.',
  openGraph: {
    images: [{ url: '/og-default.png', width: 1200, height: 628 }],
  },
};

export default function LoginPage() {
  return <LoginFormClient />;
}
