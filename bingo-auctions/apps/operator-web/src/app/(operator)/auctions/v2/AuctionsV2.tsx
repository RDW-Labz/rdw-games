import Link from 'next/link';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { CloneAuctionButton } from '../CloneAuctionButton';
import { ConsoleV2Page } from '@/components/console-v2/ConsoleV2Page';
import { rowMotion } from '@/components/console-v2/motion';
import { AuctionStatusPill } from './AuctionStatusPill';
import { lastCloseParts, splitDateLabel, type DateLabelParts } from './auction-date-label';
import type { AuctionListV2Row, AuctionsV2Props } from './auction-list-types';

// Auctions list, v2 skin on the v1 table (Braden 2026-10-13: lists keep the
// v1 table layout, not cards). Columns and order match v1 — Thumbs · Title ·
// Status · Starts · Ends · Premium · Clone — with v2's extras folded in as
// small second lines (warehouse · lots · Off-site under the title, Last close
// under Ends). The thumbs column is a fixed 120px <col> so a title can never
// run under the strip (the v1 flex row lets them collide).

function ThumbStrip({ row }: { row: AuctionListV2Row }) {
  const urls = row.featuredImageUrls.slice(0, 3);
  if (urls.length === 0) return null;
  return (
    <div className="console-v2-list-thumbs">
      {urls.map((u, i) => (
        // plain <img>, as v1: opennextjs has known edge cases with <Image> over CF resizing
        <img
          key={`${u}-${i}`}
          src={u}
          alt={`${row.title}, featured photo ${i + 1}`}
          loading="lazy"
          decoding="async"
          className="console-v2-list-thumb"
        />
      ))}
    </div>
  );
}

function DateText({ parts }: { parts: DateLabelParts }) {
  return (
    <>
      {parts.date ? <span className="console-v2-list-nowrap">{parts.date}</span> : null}
      {parts.date && parts.time ? ' ' : null}
      {parts.time ? <span className="console-v2-list-nowrap">{parts.time}</span> : null}
    </>
  );
}

export function AuctionsV2({ rows }: AuctionsV2Props) {
  return (
    <ConsoleV2Page className="console-v2-auctions-list">
      <header className="console-v2-motion-reveal">
        <div className="console-v2-auctions-list-head">
          <h1 className="console-v2-display console-v2-auctions-list-title">Auctions</h1>
          <div className="console-v2-auctions-list-actions">
            <Link href="/auctions/auto-build" className="console-v2-btn console-v2-btn--secondary console-v2-pressable">
              Auto-build
            </Link>
            <Link href="/auctions/new" className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable">
              New auction
            </Link>
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="console-v2-auctions-empty console-v2-motion-reveal">
          No auctions yet.{' '}
          <Link href="/auctions/new" className="console-v2-code">
            Create one
          </Link>
          .
        </p>
      ) : (
        <div className="console-v2-list-table-wrap console-v2-motion-reveal">
          <table className="console-v2-list-table console-v2-auctions-table">
            <caption className="console-v2-sr-only">Auctions, most recent start first</caption>
            <colgroup>
              <col className="console-v2-list-col-thumbs" />
              <col />
              <col className="console-v2-auctions-col-status" />
              <col className="console-v2-auctions-col-date" />
              <col className="console-v2-auctions-col-date" />
              <col className="console-v2-auctions-col-premium" />
              <col className="console-v2-auctions-col-clone" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" data-col="thumbs">
                  <span className="console-v2-sr-only">Photos</span>
                </th>
                <th scope="col" data-col="title">Title</th>
                <th scope="col" data-col="status">Status</th>
                <th scope="col" data-col="starts">Starts</th>
                <th scope="col" data-col="ends">Ends</th>
                <th scope="col" data-col="premium" className="console-v2-list-num">Premium</th>
                <th scope="col" data-col="clone">
                  <span className="console-v2-sr-only">Clone</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const motion = rowMotion(idx);
                return (
                  <tr key={row.id} className={`console-v2-list-row ${motion.className}`} style={motion.style}>
                    <td data-col="thumbs">
                      <ThumbStrip row={row} />
                    </td>
                    <td data-col="title">
                      <Link href={`/auctions/${row.id}`} className="console-v2-list-title">
                        {row.title}
                      </Link>
                      <div className="console-v2-list-meta">
                        <span>{row.warehouseName}</span>
                        <span aria-hidden>·</span>
                        <span>{formatCount(row.lotCount)} lots</span>
                        {row.offSite ? <span className="console-v2-list-offsite">Off-site</span> : null}
                      </div>
                    </td>
                    <td data-col="status">
                      <AuctionStatusPill status={row.status} />
                    </td>
                    <td data-col="starts" className="console-v2-list-date">
                      <DateText parts={splitDateLabel(row.startsAtLabel)} />
                    </td>
                    <td data-col="ends" className="console-v2-list-date">
                      <DateText parts={splitDateLabel(row.firstCloseLabel)} />
                      <div className="console-v2-list-sub">
                        <span className="console-v2-list-nowrap">Last close</span>{' '}
                        <DateText parts={lastCloseParts(row.firstCloseLabel, row.lastCloseLabel)} />
                      </div>
                    </td>
                    <td data-col="premium" className="console-v2-list-num">
                      {row.premiumLabel}
                    </td>
                    <td data-col="clone" className="console-v2-auctions-row-clone">
                      <CloneAuctionButton auctionId={row.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleV2Page>
  );
}
