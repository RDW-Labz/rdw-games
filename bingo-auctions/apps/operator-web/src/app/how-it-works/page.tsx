/**
 * /how-it-works — public marketing page.
 *
 * Bidder-focused walkthrough of BinGo Auctions, a single-operator online
 * auction house:
 *   1. How we run our auctions — intake → catalog → schedule
 *   2. Bidder workflow — discover → bid → win → pay
 *   3. Pickup workflow — schedule → warehouse map → hand off
 *
 * Server component. Uses design tokens from globals.css only.
 * No new dependencies.
 *
 * Audience: bidders, and App Store / Play Store reviewers who need to
 * understand what the app does.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { StepIcon, type StepIconName } from './StepIcons';
import { JsonLd, faqPageJsonLd } from '@/lib/seo';

// Rendered as the visible FAQ section below AND emitted as FAQPage JSON-LD —
// one source so the markup never drifts from what's on the page (Google
// requires FAQ structured data to match visible content).
const FAQS: Array<{ q: string; a: string }> = [
  {
    q: 'What is BinGo Auctions?',
    a: 'BinGo Auctions is an online liquidation auction house. We bring overstock, customer returns, and closeout inventory into our warehouse, catalog and photograph every item, and sell it in timed online auctions. We are the seller and merchant of record for every lot — there are no third-party sellers.',
  },
  {
    q: 'How does bidding work?',
    a: 'Create a free account, add a payment method, and bid on any live lot. Auctions use a soft close: a bid placed in the final minutes extends that lot so other bidders can respond, which prevents last-second sniping. You can also set a maximum bid and the system bids on your behalf up to that amount.',
  },
  {
    q: 'How do I pay for lots I win?',
    a: "When an auction closes you receive an itemized invoice — hammer price plus our buyer's premium and any applicable sales tax. The card on your account is charged automatically, and a receipt is emailed to you. Resellers with a valid resale certificate can apply for tax-exempt purchasing from their profile.",
  },
  {
    q: 'How do I get my items?',
    a: 'Winning lots are picked up in person at our warehouse during the posted pickup window. Show the QR code in your account at the door; staff scan it, and the app guides you to each of your lots by bin location.',
  },
  {
    q: 'What do the condition grades mean?',
    a: 'Appears New: unused in original packaging as far as we can tell. Open Box: complete but opened or repackaged. Good: used or incomplete but functional. As-Is: sold with known defects or untested — inspect the photos closely before bidding.',
  },
  {
    q: 'What if an item is not as described?',
    a: 'Inspect every item at pickup before you accept it. If it is materially different from its listing, tell our staff right there and decline it — we refund that lot on the spot. Once you accept and take an item, the sale is final.',
  },
  {
    q: 'Do you have a loyalty or referral program?',
    a: 'Yes to both. Loyalty points are earned on auction wins and at our retail stores (one phone-linked balance across both) and can be redeemed for auction credit from your profile. Referrals earn you and the friend you invite $5 in auction credit each after their first completed purchase.',
  },
];

export const metadata: Metadata = {
  // absolute: the layout template would append "— BinGo Auctions" onto a
  // title that already contains the brand.
  title: { absolute: 'How BinGo Auctions Works' },
  description:
    'How BinGo Auctions works: we intake and catalog inventory into our warehouse, run timed online auctions you bid on from the app, and make local pickup painless with a warehouse walking route.',
  openGraph: {
    images: [{ url: '/og-default.png', width: 1200, height: 630 }],
  },
};

// ─── layout ──────────────────────────────────────────────────────────────────
const MAX_W = 860;

const pageWrap: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  minHeight: '100vh',
};

const innerWrap: React.CSSProperties = {
  maxWidth: MAX_W,
  margin: '0 auto',
  padding: '0 1.5rem',
};

export default function HowItWorksPage() {
  return (
    <div style={pageWrap}>
      <JsonLd data={faqPageJsonLd(FAQS)} />
      {/* Back nav */}
      <div style={{ ...innerWrap, paddingTop: '2rem' }}>
        <Link
          href="/"
          style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}
        >
          &larr; BinGo Auctions
        </Link>
      </div>

      {/* Page header */}
      <header style={{ ...innerWrap, padding: '4rem 1.5rem 3rem' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: '0.75rem',
          }}
        >
          How it works
        </div>
        <h1
          style={{
            fontSize: 'clamp(2rem, 5vw, 3rem)',
            fontWeight: 900,
            letterSpacing: -1.5,
            lineHeight: 1.08,
            margin: '0 0 1rem',
          }}
        >
          From our warehouse to your hands.
        </h1>
        <p
          style={{
            color: 'var(--fg-muted)',
            fontSize: '1.1rem',
            lineHeight: 1.65,
            maxWidth: 580,
            margin: 0,
          }}
        >
          BinGo Auctions is the auctioneer and seller — we bring overstock, returns, and
          liquidation inventory into our warehouse, catalog every item, and run timed online
          auctions you bid on directly. Here's how the whole thing works, from intake to pickup.
        </p>
      </header>

      {/* Sections */}
      <WorkflowSection
        number="01"
        title="How we run our auctions"
        subtitle="From warehouse intake to live bidding"
        intro="BinGo Auctions sources inventory, catalogs it, and runs the auctions ourselves. We are the
        seller of record for every lot — there's no middleman and no third-party sellers."
        steps={[
          {
            icon: 'truck',
            title: 'Inventory comes in',
            body: `We bring overstock, customer returns, and liquidation lots into our warehouse and organize them into bins by row, shelf, and zone so every item has a known home.`,
          },
          {
            icon: 'tag',
            title: 'Every item is cataloged',
            body: `Our team scans each item with the BinGo Staff app. The app's AI vision identifies the item from a photo — drafting a title, description, and estimated retail value — then assigns the lot to its bin location.`,
          },
          {
            icon: 'calendar',
            title: 'Auctions are built and scheduled',
            body: `We group lots into a timed auction, set staggered soft-close timing (so lots don't all end at once and last-second sniping doesn't decide everything), and publish. The auction appears instantly in the app and on the site.`,
          },
          {
            icon: 'gavel',
            title: 'You bid, win, and pay',
            body: `When a lot closes, the winning bidder is invoiced automatically. BinGo Auctions is the merchant of record — you pay us directly, then pick up locally. No third-party seller to chase.`,
          },
        ]}
      />

      <WorkflowSection
        number="02"
        title="The bidder workflow"
        subtitle="From installing the app to winning lots"
        intro="Bidders are anyone who creates a free BinGo Auctions account. One account gives you access
        to every BinGo Auctions auction — no separate registrations, no re-entering payment info for
        each event."
        steps={[
          {
            icon: 'download',
            title: 'Download and create a free account',
            body: `The BinGo Auctions app is a free download. Sign up once with an email address and verify your identity. A payment method is added at registration — we place a hold to confirm the card is valid before allowing bids.`,
          },
          {
            icon: 'search',
            title: 'Browse live and upcoming auctions',
            body: `The app's home feed shows every live and upcoming BinGo Auctions auction. Filter by category or auction end time. Lot photos are full-screen; descriptions include condition notes and the AI-generated retail estimate.`,
          },
          {
            icon: 'bolt',
            title: 'Bid in real time',
            body: `BinGo Auctions uses a soft-close model: if a bid arrives in the last few minutes of a lot's closing window, the lot extends automatically to give other bidders a chance to respond. This prevents the frustration of last-second sniping and tends to drive fairer final prices.`,
          },
          {
            icon: 'card',
            title: 'Receive invoice and pay',
            body: `When the auction closes, winning bidders receive an invoice via push notification and email. Your total includes the hammer price, our buyer's premium, and any applicable sales tax (collected and remitted by BinGo Auctions as seller of record).`,
          },
          {
            icon: 'calendar',
            title: 'Schedule a pickup time',
            body: `After payment, bidders see our pickup schedule and choose a pickup window. A QR code is generated for the pickup — warehouse staff scan it at the door to confirm the bidder and pull up their lot list.`,
          },
        ]}
        alt
      />

      <WorkflowSection
        number="03"
        title="The pickup workflow"
        subtitle="Warehouse day without the chaos"
        intro="Pickup is the hardest part of a physical auction — too many people, too many lots, staff
        running around looking for items. Our warehouse map and Staff app are built specifically to
        make pickup day run like a warehouse, not a yard sale."
        steps={[
          {
            icon: 'qr',
            title: 'Bidder checks in at the door',
            body: `The bidder opens the BinGo Auctions app and shows their pickup QR code. A staff member scans it with the Staff app — this confirms the bidder's identity and pulls up their complete lot list with bin locations.`,
          },
          {
            icon: 'map',
            title: 'App generates a walking route',
            body: `The bidder's app shows an interactive warehouse map with their lots highlighted. The route is optimized to minimize backtracking — bidders walk a logical path and self-navigate to each lot. Staff aren't running the floor explaining where everything is.`,
          },
          {
            icon: 'box',
            title: 'Staff confirms each lot',
            body: `As the bidder collects each lot, the Staff app marks it as picked up. This creates a real-time record of what has left the building — useful for dispute prevention, since a timestamped scan is hard to argue with.`,
          },
          {
            icon: 'search',
            title: 'Inspect at pickup',
            body: `Bidders inspect each item at pickup before accepting it. If a lot is materially not as described, staff review it against the original listing photos on the spot and refund that lot then and there. Once an item is accepted and taken, the sale is final.`,
          },
        ]}
        cyan
      />

      {/* FAQ — visible content mirrored into FAQPage JSON-LD above */}
      <section
        style={{
          padding: '4rem 1.5rem',
          background: 'var(--bg-elev)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              fontWeight: 900,
              letterSpacing: -0.75,
              marginBottom: '1.5rem',
            }}
          >
            Frequently asked questions
          </h2>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {FAQS.map((faq) => (
              <details
                key={faq.q}
                style={{
                  background: 'var(--bg-elev-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '1rem 1.25rem',
                }}
              >
                <summary
                  style={{
                    fontWeight: 700,
                    fontSize: '0.95rem',
                    cursor: 'pointer',
                  }}
                >
                  {faq.q}
                </summary>
                <p
                  style={{
                    fontSize: 14,
                    lineHeight: 1.7,
                    color: 'var(--fg-muted)',
                    margin: '0.75rem 0 0',
                  }}
                >
                  {faq.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section
        style={{
          padding: '5rem 1.5rem',
          textAlign: 'center',
          borderTop: '1px solid var(--border)',
        }}
      >
        <div style={innerWrap}>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
              fontWeight: 900,
              letterSpacing: -1,
              marginBottom: '1rem',
            }}
          >
            Ready to start bidding?
          </h2>
          <p style={{ color: 'var(--fg-muted)', fontSize: '1rem', marginBottom: '2rem' }}>
            Creating an account is free. Browse live auctions and place your first bid in minutes.
          </p>
          <div
            style={{
              display: 'flex',
              gap: '0.75rem',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Link href="/signup" className="btn-primary">
              Create a free account
            </Link>
            <Link href="/browse" className="btn-secondary">
              Browse auctions
            </Link>
          </div>
        </div>
      </section>

      {/* Minimal footer */}
      <footer
        style={{
          padding: '2rem 1.5rem',
          borderTop: '1px solid var(--border)',
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--fg-dim)',
        }}
      >
        &copy; 2026 BinGo Auctions &nbsp;&middot;&nbsp;
        <Link href="/legal/terms" style={{ color: 'var(--fg-dim)' }}>Terms</Link>
        &nbsp;&middot;&nbsp;
        <Link href="/legal/privacy" style={{ color: 'var(--fg-dim)' }}>Privacy</Link>
        &nbsp;&middot;&nbsp;
        <Link href="/support" style={{ color: 'var(--fg-dim)' }}>Support</Link>
      </footer>
    </div>
  );
}

// ─── WorkflowSection ──────────────────────────────────────────────────────────

function WorkflowSection({
  number,
  title,
  subtitle,
  intro,
  steps,
  alt,
  cyan,
}: {
  number: string;
  title: string;
  subtitle: string;
  intro: string;
  steps: { icon: StepIconName; title: string; body: string }[];
  alt?: boolean;
  /** Cyan icon-chip variant (used for the pickup section). */
  cyan?: boolean;
}) {
  return (
    <section
      style={{
        padding: '4rem 1.5rem',
        background: alt ? 'var(--bg-elev)' : 'var(--bg)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        {/* Section header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <span
            style={{
              fontSize: 'clamp(2.5rem, 5vw, 3.5rem)',
              fontWeight: 900,
              color: 'var(--accent-dim)',
              lineHeight: 1,
              userSelect: 'none',
              letterSpacing: -2,
            }}
          >
            {number}
          </span>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              fontWeight: 900,
              letterSpacing: -0.75,
              margin: 0,
            }}
          >
            {title}
          </h2>
        </div>

        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--accent)',
            textTransform: 'uppercase',
            letterSpacing: 1,
            marginBottom: '1rem',
          }}
        >
          {subtitle}
        </div>

        <p
          style={{
            color: 'var(--fg-muted)',
            fontSize: '1rem',
            lineHeight: 1.7,
            maxWidth: 680,
            marginBottom: '2.5rem',
          }}
        >
          {intro}
        </p>

        {/* Steps */}
        <div style={{ display: 'grid', gap: '1rem' }}>
          {steps.map((step, i) => (
            <StepCard
              key={step.title}
              number={i + 1}
              icon={step.icon}
              title={step.title}
              body={step.body}
              cyan={cyan}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── StepCard ─────────────────────────────────────────────────────────────────

function StepCard({
  number,
  icon,
  title,
  body,
  cyan,
}: {
  number: number;
  icon: StepIconName;
  title: string;
  body: string;
  cyan?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr',
        gap: '1rem',
        alignItems: 'start',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '1.25rem',
      }}
    >
      {/* Step number badge */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: 'var(--accent-dim)',
          border: '1px solid rgba(251,101,20,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 900,
          fontSize: 15,
          color: 'var(--accent)',
          flexShrink: 0,
        }}
      >
        {number}
      </div>

      {/* Content */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: '0.4rem',
          }}
        >
          {/* Icon chip — orange by default, cyan for the pickup section */}
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: cyan ? 'rgba(43,169,203,0.12)' : 'rgba(246,145,30,0.12)',
              color: cyan ? 'var(--cyan)' : 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <StepIcon name={icon} size={22} />
          </div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</div>
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--fg-muted)' }}>{body}</div>
      </div>
    </div>
  );
}
