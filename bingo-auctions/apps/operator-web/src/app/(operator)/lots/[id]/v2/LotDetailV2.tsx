import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatCents } from '@auction-platform/shared/money';
import { Card } from '@/components/console-v2/Card';
import { LotIdentity } from '@/components/console-v2/LotIdentity';
import { revealStyle, rowMotion } from '@/components/console-v2/motion';
import { SectionHeader } from '@/components/console-v2/SectionHeader';
import { StatusPill } from '@/components/console-v2/StatusPill';
import { lotFloorStage } from '@/components/console-v2/stage-hue';
import { LotDetailFloorRail } from './LotDetailFloorRail';
import type { LotDetailV2Props } from './lot-detail-types';

function FactGrid({
  items,
}: {
  items: Array<{ term: string; detail: ReactNode; wide?: boolean }>;
}) {
  return (
    <dl className="console-v2-lot-facts">
      {items.map((item) => (
        <div key={item.term} className={item.wide ? 'console-v2-lot-facts__wide' : undefined}>
          <dt>{item.term}</dt>
          <dd>{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChooseNextStep({
  actions,
  primaryAction,
}: Pick<LotDetailV2Props, 'actions' | 'primaryAction'>) {
  const blocks: Array<{ key: string; title: string; body: ReactNode; primary?: boolean }> = [];

  if (actions.removedState) {
    return (
      <section id="lot-v2-decisions" className="console-v2-lot-decisions console-v2-motion-reveal" style={revealStyle(4)}>
        <SectionHeader title="Choose the next step" stageHue="lotting" />
        <Card style={{ marginTop: 'var(--console-space-4)' }}>{actions.removedState}</Card>
      </section>
    );
  }

  if (actions.withdraw) {
    blocks.push({
      key: 'withdraw',
      title: 'Withdraw from auction',
      body: actions.withdraw,
    });
  }
  if (actions.relist) {
    blocks.push({
      key: 'relist',
      title: 'Relot / Relist',
      body: actions.relist,
      primary: primaryAction === 'relist',
    });
  }
  if (actions.remove) {
    blocks.push({
      key: 'remove',
      title: "Can't be sold again?",
      body: actions.remove,
      primary: primaryAction === 'remove',
    });
  }
  if (actions.keep) {
    blocks.push({
      key: 'keep',
      title: 'Keeping it for the business?',
      body: actions.keep,
      primary: primaryAction === 'keep',
    });
  }
  if (actions.cancel) {
    blocks.push({
      key: 'cancel',
      title: 'Cancel lot',
      body: actions.cancel,
      primary: primaryAction === 'cancel',
    });
  }
  if (actions.delete) {
    blocks.push({
      key: 'delete',
      title: 'Delete lot',
      body: actions.delete,
      primary: primaryAction === 'delete',
    });
  }

  if (blocks.length === 0) {
    return (
      <section id="lot-v2-decisions" className="console-v2-lot-decisions console-v2-motion-reveal" style={revealStyle(4)}>
        <SectionHeader title="Choose the next step" stageHue="lotting" />
        <p style={{ margin: 'var(--console-space-4) 0 0', color: 'var(--console-ink-secondary)' }}>
          No fix actions are available for this lot right now.
        </p>
      </section>
    );
  }

  return (
    <section id="lot-v2-decisions" className="console-v2-lot-decisions console-v2-motion-reveal" style={revealStyle(4)}>
      <SectionHeader
        title="Choose the next step"
        stageHue="lotting"
        subtitle="Only actions you are allowed to take on this record."
      />
      <div className="console-v2-lot-action-stack">
        {blocks.map((block, index) => (
          <details
            key={block.key}
            className="console-v2-lot-action-details"
            open={index === 0 || block.primary}
          >
            <summary className="console-v2-lot-action-summary">
              {block.title}
              {block.primary ? (
                <span className="console-v2-sr-only"> — suggested next step</span>
              ) : null}
            </summary>
            <div
              className={
                block.primary ? 'console-v2-lot-action-body console-v2-lot-action-body--primary' : 'console-v2-lot-action-body'
              }
              data-action={block.key}
            >
              {block.body}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

export function LotDetailV2(props: LotDetailV2Props) {
  const {
    lotId,
    identity,
    successor,
    photos,
    facts,
    owner,
    actions,
    primaryAction,
    bids,
    bidFootnote,
    timeline,
    floorLocationNote,
  } = props;

  const lineageFacts =
    facts.lineage.length > 0
      ? facts.lineage.map((parent) => (
          <span key={parent.id}>
            <Link href={`/lots/${parent.id}`} className="console-v2-code">
              {parent.lot_code}
            </Link>
            <span style={{ color: 'var(--console-ink-secondary)' }}>
              {' '}
              · {parent.relistLabel} · {parent.status}
              {parent.closed_at ? ` · closed ${parent.closed_at}` : ''}
            </span>
          </span>
        ))
      : 'None on this record';

  return (
    <div
      data-console-v2
      className="console-v2-lot-detail console-v2-motion-page-in"
      style={{
        fontFamily: 'var(--console-font-body)',
        color: 'var(--console-ink)',
        margin: 'calc(-2rem)',
        padding: 'var(--console-page-gutter)',
        background: 'var(--console-gradient-frame)',
        minHeight: '100%',
      }}
    >
      <div className="console-v2-lot-shell">
        <LotDetailFloorRail
          locationNote={floorLocationNote}
          currentStage={lotFloorStage({
            lotStatus: identity.status,
            invoiceStatus: owner?.invoiceStatus ?? null,
            pickedUp: owner?.pickedUp ?? false,
          })}
          revealIndex={0}
        />
        <div className="console-v2-lot-work">
          <header id="lot-v2-identity" className="console-v2-motion-reveal" style={revealStyle(1)}>
            <p
              style={{
                margin: '0 0 var(--console-space-2)',
                fontSize: 'var(--console-text-sm)',
                color: 'var(--console-ink-secondary)',
              }}
            >
              Lot detail
            </p>
            <h1
              className="console-v2-display"
              style={{
                margin: '0 0 var(--console-space-5)',
                fontSize: 'var(--console-text-title)',
                lineHeight: 'var(--console-leading-tight)',
                maxWidth: '48rem',
              }}
            >
              One label, the record behind it, and the next eligible action.
            </h1>
          </header>

          <section
            className="console-v2-lot-identity-band console-v2-motion-reveal"
            style={revealStyle(2)}
            aria-labelledby="lot-v2-identity"
          >
            <div className="console-v2-lot-identity-band__main">
              <div className="console-v2-lot-identity-hero">
                <LotIdentity
                  size="lg"
                  lot={{
                    lot_code: identity.lot_code,
                    sticker_code: identity.sticker_code,
                    display_code: identity.display_code,
                  }}
                />
              </div>
              <p
                style={{
                  margin: 'var(--console-space-3) 0 var(--console-space-2)',
                  fontSize: 'var(--console-text-section)',
                  fontWeight: 'var(--console-weight-strong)',
                  lineHeight: 'var(--console-leading-body)',
                }}
              >
                {identity.title}
              </p>
              <p
                style={{
                  margin: 0,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 'var(--console-space-2)',
                  alignItems: 'center',
                  color: 'var(--console-ink-secondary)',
                  fontSize: 'var(--console-text-sm)',
                }}
              >
                {identity.auctionId ? (
                  <Link href={`/auctions/${identity.auctionId}`}>{identity.auctionTitle ?? '—'}</Link>
                ) : (
                  <span>{identity.auctionTitle ?? '—'}</span>
                )}
                <span aria-hidden="true">·</span>
                <span>{identity.warehouseName ?? '—'}</span>
                <span aria-hidden="true">·</span>
                <span>{identity.locationSummary}</span>
                <StatusPill status={identity.status} />
                {identity.relistCount > 0 ? (
                  <span style={{ color: 'var(--console-warning)', fontWeight: 'var(--console-weight-strong)' }}>
                    relist #{identity.relistCount}
                  </span>
                ) : null}
              </p>
              {identity.metaLine ? (
                <p
                  style={{
                    margin: 'var(--console-space-2) 0 0',
                    fontSize: 'var(--console-text-sm)',
                    color: 'var(--console-ink-secondary)',
                  }}
                >
                  {identity.metaLine}
                </p>
              ) : null}
            </div>
            <div className="console-v2-lot-identity-band__actions">
              <Link
                href={`/lots/${lotId}/photos`}
                className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
              >
                Photos
              </Link>
              <Link
                href={`/lots/${lotId}/edit`}
                className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
              >
                Edit lot
              </Link>
            </div>
          </section>

          {successor ? (
            <section className="console-v2-lot-successor console-v2-motion-reveal" style={revealStyle(3)} aria-live="polite">
              <h2 className="console-v2-display" style={{ margin: 0, fontSize: 'var(--console-text-base)' }}>
                Carried over — this record is history
              </h2>
              <p style={{ margin: 'var(--console-space-2) 0 0', fontSize: 'var(--console-text-sm)' }}>
                This item was relisted{successor.chainLength > 1 ? ` ${successor.chainLength} more times` : ''}.
                The current record is{' '}
                <Link href={`/lots/${successor.id}`} className="console-v2-code">
                  {successor.displayCode}
                </Link>{' '}
                — use it for status, auction and location.
              </p>
              <FactGrid
                items={[
                  {
                    term: 'Current status',
                    detail: (
                      <>
                        <StatusPill status={successor.status} />
                        {successor.auctionTitle && successor.auctionId ? (
                          <>
                            {' '}
                            <Link href={`/auctions/${successor.auctionId}`}>{successor.auctionTitle}</Link>
                          </>
                        ) : null}
                      </>
                    ),
                  },
                  { term: 'Current close', detail: successor.closeLabel },
                  { term: 'Current location', detail: successor.location ?? '—' },
                  ...(successor.showLotCodeStat
                    ? [{ term: 'Current lot code', detail: <span className="console-v2-code">{successor.lotCode}</span> }]
                    : []),
                ]}
              />
            </section>
          ) : null}

          <ChooseNextStep actions={actions} primaryAction={primaryAction} />

          <section id="lot-v2-record" className="console-v2-motion-reveal" style={revealStyle(5)}>
            <Card>
              <SectionHeader title="What is on record" stageHue="lotting" style={{ margin: 'calc(-1 * var(--console-space-5)) calc(-1 * var(--console-space-5)) var(--console-space-4)' }} />
              <div className="console-v2-lot-evidence">
                <div className="console-v2-lot-photo-slot">{photos}</div>
                <FactGrid
                  items={[
                    { term: 'Starting bid', detail: formatCents(facts.startingBidCents) },
                    { term: 'Current / final bid', detail: facts.currentBidLabel },
                    { term: 'MSRP', detail: facts.msrpLabel },
                    { term: 'Close (this run)', detail: facts.closeLabel },
                    {
                      term: 'Location on record',
                      detail: (
                        <>
                          {facts.locationLabel}
                          <p
                            style={{
                              margin: 'var(--console-space-2) 0 0',
                              fontSize: 'var(--console-text-sm)',
                              color: 'var(--console-ink-secondary)',
                              fontWeight: 'var(--console-weight-body)',
                            }}
                          >
                            A recorded shelf is not proof of current possession.
                          </p>
                        </>
                      ),
                      wide: true,
                    },
                    { term: 'Earlier run', detail: lineageFacts, wide: true },
                  ]}
                />
              </div>
              {facts.description ? (
                <div style={{ marginTop: 'var(--console-space-5)' }}>
                  <h3 className="console-v2-display" style={{ margin: '0 0 var(--console-space-2)', fontSize: 'var(--console-text-base)' }}>
                    Description
                  </h3>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{facts.description}</p>
                </div>
              ) : null}
            </Card>
          </section>

          <section
            id="lot-v2-ownership"
            className="console-v2-motion-reveal"
            style={{ ...revealStyle(6), marginTop: 'var(--console-space-4)' }}
          >
            <Card>
              <SectionHeader
                title="Invoice and handoff"
                stageHue="paid"
                subtitle="Latest invoice for this record only."
                style={{ margin: 'calc(-1 * var(--console-space-5)) calc(-1 * var(--console-space-5)) var(--console-space-4)' }}
              />
              {owner ? (
                <FactGrid
                  items={[
                    {
                      term: 'Sold to',
                      detail: (
                        <Link href={`/bidders/${owner.bidderId}`}>
                          {owner.bidderName ?? '—'}
                          {owner.bidderNumber != null ? ` · #${owner.bidderNumber}` : ''}
                        </Link>
                      ),
                    },
                    {
                      term: 'Email',
                      detail: owner.email ? (
                        <a href={`mailto:${owner.email}`}>{owner.email}</a>
                      ) : (
                        <span className="console-v2-code">{owner.bidderId}</span>
                      ),
                    },
                    {
                      term: 'Invoice',
                      detail: (
                        <>
                          <Link href={`/invoices/${owner.invoiceId}`} className="console-v2-code">
                            #{owner.invoiceShort}
                          </Link>
                          {' '}
                          <StatusPill status={owner.invoiceStatus} />
                        </>
                      ),
                    },
                    {
                      term: 'Winning bid',
                      detail:
                        owner.winningBidCents != null ? formatCents(owner.winningBidCents) : '—',
                    },
                    { term: 'Purchased', detail: owner.purchasedLabel },
                    { term: 'Pickup', detail: owner.pickupText },
                    { term: 'Refund', detail: owner.refundText },
                  ]}
                />
              ) : (
                <p style={{ margin: 0, color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-sm)' }}>
                  Not sold — this lot has never been on a customer invoice.
                </p>
              )}
            </Card>
          </section>

          <section className="console-v2-motion-reveal" style={{ ...revealStyle(7), marginTop: 'var(--console-space-6)' }}>
            <SectionHeader title={`Bid history (${bids.length})`} stageHue="auction" />
            {bids.length === 0 ? (
              <p style={{ color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-sm)' }}>No bids yet.</p>
            ) : (
              <div className="console-v2-lot-bids-wrap">
                <table className="console-v2-lot-bids console-v2-dense-table">
                  <caption className="console-v2-sr-only">Bids on this lot</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Bidder</th>
                      <th scope="col">Visible</th>
                      <th scope="col">Max</th>
                      <th scope="col">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bids.map((b, index) => (
                      <tr key={b.id} className={rowMotion(index).className} style={rowMotion(index).style}>
                        <td>
                          <div className="console-v2-cell-inner">
                            <span className="console-v2-code" style={{ fontSize: 'var(--console-text-sm)' }}>
                              {b.placedLabel}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="console-v2-cell-inner">{b.bidderLabel}</div>
                        </td>
                        <td className="console-v2-lot-bids__money">
                          <div className="console-v2-cell-inner">{formatCents(b.amountCents)}</div>
                        </td>
                        <td className="console-v2-lot-bids__money console-v2-lot-bids__money--muted">
                          <div className="console-v2-cell-inner">{formatCents(b.maxAmountCents)}</div>
                        </td>
                        <td>
                          <div className="console-v2-cell-inner">
                            {b.isAuto ? 'auto-bid' : 'manual'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {bidFootnote ? (
              <p
                style={{
                  color: 'var(--console-ink-secondary)',
                  fontSize: 'var(--console-text-sm)',
                  marginTop: 'var(--console-space-2)',
                }}
              >
                &quot;Visible&quot; is the price publicly shown after this bid landed; &quot;Max&quot; is the
                bidder&apos;s proxy ceiling. Auto-bids are generated by the proxy mechanism when a rival bidder
                bumps the price.
              </p>
            ) : null}
          </section>

          <section
            id="lot-v2-timeline"
            className="console-v2-motion-reveal"
            style={{ ...revealStyle(8), marginTop: 'var(--console-space-6)' }}
          >
            {/* The record trail spans every stage — stage-less, off-white title. */}
            <SectionHeader title={`Timeline (${timeline.length})`} />
            {timeline.length === 0 ? (
              <p style={{ color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-sm)' }}>
                No history recorded yet. The audit trail started at migration 0098 — older lots may have minimal
                history.
              </p>
            ) : (
              <ol className="console-v2-lot-timeline">
                {timeline.map((evt) => (
                  <li key={evt.id}>
                    <span className="console-v2-code" style={{ fontSize: 'var(--console-text-sm)' }}>
                      {evt.whenLabel}
                    </span>
                    <strong>{evt.eventLabel}</strong>
                    {evt.transition ? (
                      <span style={{ color: 'var(--console-ink-secondary)' }}>{evt.transition}</span>
                    ) : null}
                    {evt.actorLabel ? (
                      <span style={{ color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-helper)' }}>
                        by {evt.actorLabel}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
