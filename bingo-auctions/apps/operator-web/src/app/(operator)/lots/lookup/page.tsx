// Universal Lot Lookup (2026-07-14 feature request; #773 title fallback).
//
// "If I have a lot code in my hand, I should be able to find everything about
// that item from one search." Staff type or scan a lot code (the human
// PNK-485-9989 sticker value, the minted lot_code, or a QR token) and land
// directly on the lot's detail page — which now carries the full ownership /
// fulfillment history (winner, invoice, paid date, pickup + refund status).
//
// #773 adds a title fallback for staff who only know the product name. The
// exact code resolver still runs first and a hit redirects immediately, so a
// code match always wins over a title match. Only an authoritative miss falls
// through to the case-insensitive title list.
//
// Resolution reuses staff_scan_lot_owner (mig 0257) — the same operator-scoped
// _find_lot_by_scan ladder the checkout "whose item is this?" scan uses
// (qr_token → lot_code → sticker_code → lpn → fnsku → asin → external_code).
// The title list is operator-scoped and excludes soft-deleted lots. Session
// scoping is inherited from the (operator) layout; the RPC has its own
// current_operator_id() guard.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { lotDisplayCode } from '@auction-platform/shared';
import { getSupabaseServer } from '@/lib/supabase-server';
import {
  candidatesFor,
  classifyCodeLookup,
  classifyTitleSearchAuth,
  LOCATION_UNAVAILABLE_LABEL,
  LOT_LOOKUP_LIMIT,
  lookupLocation,
  lookupRetryHref,
  lotTitleQuery,
  LOOKUP_MESSAGES,
  parseLotLookupInput,
  toAssignmentResult,
  type LookupAssignmentResult,
} from '@/lib/lot-lookup';
import { PageHeader, buttonStyle, inputStyle } from '@/components/Form';
import { DataTable, MonoText, StatusPill, type Column } from '@/components/console';

type Embedded<T> = T | T[] | null;

type TitleMatch = {
  id: string;
  lot_code: string | null;
  sticker_code: string | null;
  display_code: string | null;
  title: string;
  status: string;
  auctions: Embedded<{ title: string | null }>;
  warehouses: Embedded<{ name: string | null }>;
  bins: Embedded<{ code: string | null; aisle: string | null; bay: string | null }>;
};

function firstEmbedded<T>(row: Embedded<T>): T | null {
  return Array.isArray(row) ? (row[0] ?? null) : row;
}

export default async function LotLookupPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  const raw = parseLotLookupInput(code);

  let notFound = false;
  let lookupError: string | null = null;
  let titleMatches: TitleMatch[] = [];

  let locationsByLot = new Map<string, LookupAssignmentResult>();

  if (raw) {
    const supabase = await getSupabaseServer();

    // 1. Exact code lookup — always first, always wins. Only an authoritative
    // `lot_not_found` falls through; a failed or unverifiable resolver is an
    // error, not a title-only miss.
    const { data: codeData, error: codeError } = await supabase.rpc('staff_scan_lot_owner', {
      p_candidates: candidatesFor(raw),
    });
    if (codeError) {
      lookupError = LOOKUP_MESSAGES.code;
    } else {
      const resolution = classifyCodeLookup(codeData);
      if (resolution.kind === 'lot') {
        // Land on the canonical detail page — it now shows the full history.
        redirect(`/lots/${resolution.lotId}`);
      }
      if (resolution.kind === 'error') lookupError = resolution.message;
    }

    // 2. Title fallback only after a confirmed code miss.
    const titleQuery = lookupError ? null : lotTitleQuery(raw);
    if (titleQuery) {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      const auth = classifyTitleSearchAuth(user, userError);
      if (auth.kind === 'error') {
        lookupError = auth.message;
      } else {
        const { data: me, error: meError } = await supabase
          .from('operator_users')
          .select('operator_id')
          .eq('user_id', auth.userId)
          .maybeSingle();
        const operatorId = !meError && typeof me?.operator_id === 'string' ? me.operator_id : null;

        if (meError) {
          lookupError = LOOKUP_MESSAGES.operatorLookup;
        } else if (!operatorId) {
          lookupError = LOOKUP_MESSAGES.operator;
        } else {
          const { data: lots, error: titleError } = await supabase
            .from('lots')
            .select(
              'id, lot_code, sticker_code, display_code, title, status, auctions(title), warehouses(name), bins(code, aisle, bay)',
            )
            .eq('operator_id', operatorId)
            .is('deleted_at', null)
            .filter('title', titleQuery.operator, titleQuery.pattern)
            .order('title', { ascending: true })
            .order('id', { ascending: true })
            .limit(LOT_LOOKUP_LIMIT);

          if (titleError) {
            lookupError = LOOKUP_MESSAGES.title;
          } else {
            titleMatches = (lots ?? []) as unknown as TitleMatch[];
            if (titleMatches.length > 0) {
              // Latest qualifying assignment for EACH displayed lot, rather
              // than one unbounded global result set. The global list could
              // exceed the 1,000-row API cap and hide a lot's newest staging
              // event behind older rows for other lots.
              const results = await Promise.all(
                titleMatches.map(async (lot) => {
                  const { data, error } = await supabase
                    .from('bin_assignments')
                    .select('status, bins(code, aisle, bay, warehouses(name))')
                    .eq('lot_id', lot.id)
                    .in('status', ['staged', 'picked_up'])
                    .order('assigned_at', { ascending: false })
                    .limit(1);
                  return [
                    lot.id,
                    toAssignmentResult(
                      data as Array<{ status: string; bins: unknown }> | null,
                      error,
                    ),
                  ] as const;
                }),
              );
              locationsByLot = new Map(results);
            }
          }
        }
      }
    }

    if (!lookupError && titleMatches.length === 0) notFound = true;
  }

  const columns: Column<TitleMatch>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (lot) => <MonoText>{lotDisplayCode(lot) ?? lot.id.slice(0, 8)}</MonoText>,
    },
    { key: 'title', header: 'Title', cell: (lot) => lot.title },
    {
      key: 'auction',
      header: 'Auction',
      cell: (lot) => firstEmbedded(lot.auctions)?.title ?? '—',
    },
    { key: 'status', header: 'Status', cell: (lot) => <StatusPill status={lot.status} /> },
    {
      key: 'location',
      header: 'Location',
      cell: (lot) => {
        const location = lookupLocation(
          firstEmbedded(lot.warehouses)?.name ?? null,
          firstEmbedded(lot.bins),
          locationsByLot.get(lot.id),
        );
        if (location.kind === 'unavailable') {
          return (
            <Link href={lookupRetryHref(raw)} title="Retry the location lookup">
              {LOCATION_UNAVAILABLE_LABEL}
            </Link>
          );
        }
        return location.label;
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Lot lookup" />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 640, lineHeight: 1.5, marginBottom: 16 }}>
        Enter or scan any lot code, sticker code, or QR to jump straight to that item&apos;s full
        history — status, auction, winning bidder, invoice, pickup, refund, and current location.
        You can also search by part of the product title.
      </p>

      <form method="get" style={{ display: 'flex', gap: 8, maxWidth: 520, marginBottom: 16 }}>
        <input
          type="text"
          name="code"
          defaultValue={raw}
          autoFocus
          placeholder="e.g. PNK-485-9989 or VEVOR ice maker"
          aria-label="Lot code or title"
          autoComplete="off"
          autoCapitalize="off"
          maxLength={100}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button type="submit" style={buttonStyle}>
          Look up
        </button>
      </form>

      {lookupError && (
        <div
          style={{
            maxWidth: 520,
            padding: '10px 14px',
            marginBottom: 16,
            background: 'var(--urgent-red-dim)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {lookupError}
        </div>
      )}

      {notFound && (
        <div
          style={{
            maxWidth: 520,
            padding: '10px 14px',
            background: 'var(--urgent-red-dim)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          No lot found for <strong>{raw}</strong>. Check the code or title, or it may belong to a
          different operator.
        </div>
      )}

      {titleMatches.length > 0 && (
        <div style={{ maxWidth: 1100 }}>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginBottom: 8 }}>
            No code matched, so these lots match the title <strong>{raw}</strong>.{' '}
            <Link href="/lots/lookup">Clear</Link>
          </p>
          <DataTable
            columns={columns}
            rows={titleMatches}
            rowKey={(lot) => lot.id}
            rowHref={(lot) => `/lots/${lot.id}`}
          />
        </div>
      )}
    </div>
  );
}
