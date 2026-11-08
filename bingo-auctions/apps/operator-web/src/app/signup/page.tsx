// Bidder signup page — bingoauctions.com/signup.
//
// Server component wrapper. Exports metadata and delegates all interactive
// auth logic to SignupFormClient (the 'use client' boundary lives there).
//
// /signup is the canonical bidder signup form. BinGo Auctions is a
// single-operator auction house — there is no operator waitlist.

import type { Metadata } from 'next';
import { SignupFormClient } from './SignupFormClient';

export const metadata: Metadata = {
  title: 'Sign Up to Bid',
  description:
    'Create a free BinGo Auctions account to bid on our live online auctions, win lots, and schedule local pickup.',
  openGraph: {
    images: [{ url: '/og-default.png', width: 1200, height: 628 }],
  },
};

export default function BidderSignupPage() {
  return <SignupFormClient />;
}
