// Blank QR sticker sheet PDF — pre-printed generic stickers for Flow B
// (pre-stickered lotting). The PDF is a grid of N stickers, each
// encoding a fresh UUID that's been parked in `lot_sticker_pool`
// (see migration 0110). Operator applies a sticker to an item before
// or during AI lotting, then scans the sticker in the field-mobile app
// to rotate that lot's qr_token onto the scanned UUID.
//
// POST body:
//   { count: number, size: 'avery_5160' | 'avery_5163' | 'thermal_2x4' }
//
// Returns: application/pdf with a content-disposition naming the batch.
//
// Auth: caller must be signed-in operator staff. We rely on
// `mint_blank_qr_batch` to enforce that — it raises 42501 if
// current_operator_id() is NULL.
//
// Layout: identical Avery / thermal sizes as /api/lots/qr-sheet so
// operators can re-use the same sheets / printer config. The only
// content difference is the right-hand text: instead of lot_code +
// title, blank stickers show "BLANK — assign at lotting" plus a
// short, human-readable UUID prefix for backup-traceability if a
// sticker gets separated from its pool row.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Must match the universal-link host configured for bingoauctions.com
// (see 0103: resolve_lot_by_qr_token + /l/[token] route handler).
const PUBLIC_LOT_URL_BASE = 'https://bingoauctions.com/l/';

const MAX_STICKERS_PER_CALL = 500;

// --------------------------------------------------------------------------
// Layout specs — copy of /api/lots/qr-sheet so the two routes stay in
// lockstep. Cell width/height + paddings already proven to print clean
// on Avery 5160 / 5163 + 2"x4" thermal direct-print.
// --------------------------------------------------------------------------

type LabelSize = 'avery_5160' | 'avery_5163' | 'thermal_2x4';

interface LayoutSpec {
  pageWidth: number;
  pageHeight: number;
  cols: number;
  rows: number;
  marginTop: number;
  marginLeft: number;
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
  innerPadding: number;
}

const LAYOUTS: Record<LabelSize, LayoutSpec> = {
  avery_5160: {
    pageWidth: 612,
    pageHeight: 792,
    cols: 3,
    rows: 10,
    marginTop: 39.6,
    marginLeft: 10.8,
    cellWidth: 189,
    cellHeight: 72.5,
    gapX: 10.8,
    gapY: 0,
    innerPadding: 4,
  },
  avery_5163: {
    pageWidth: 612,
    pageHeight: 792,
    cols: 2,
    rows: 5,
    marginTop: 36,
    marginLeft: 10.8,
    cellWidth: 288,
    cellHeight: 144,
    gapX: 0,
    gapY: 0,
    innerPadding: 6,
  },
  thermal_2x4: {
    pageWidth: 288,
    pageHeight: 144,
    cols: 1,
    rows: 1,
    marginTop: 0,
    marginLeft: 0,
    cellWidth: 288,
    cellHeight: 144,
    gapX: 0,
    gapY: 0,
    innerPadding: 6,
  },
};

const requestSchema = z.object({
  count: z.number().int().min(1).max(MAX_STICKERS_PER_CALL),
  size: z.enum(['avery_5160', 'avery_5163', 'thermal_2x4']),
});

function truncateToWidth(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '…';
  const ellipsisWidth = font.widthOfTextAtSize(ellipsis, size);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = text.slice(0, mid);
    if (font.widthOfTextAtSize(candidate, size) + ellipsisWidth <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo).trimEnd() + ellipsis;
}

export async function POST(req: NextRequest) {
  // -- 1. Parse + validate body --------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.issues[0]?.message ?? 'invalid' },
      { status: 400 },
    );
  }
  const { count, size } = parsed.data;

  // -- 2. Auth -------------------------------------------------------------
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // -- 3. Mint the batch (RPC validates operator membership) ---------------
  // mint_blank_qr_batch is SECURITY DEFINER + checks current_operator_id()
  // → raises 42501 if the caller isn't operator staff. The RLS policy on
  // lot_sticker_pool then scopes pool rows to the caller's operator.
  const { data: minted, error: mintErr } = await supabase
    .rpc('mint_blank_qr_batch', { p_count: count })
    .single<{ batch_id: string; qr_tokens: string[] }>();
  if (mintErr) {
    // 42501 = insufficient_privilege (not operator staff).
    const code = (mintErr as { code?: string }).code;
    const status = code === '42501' ? 403 : 500;
    return NextResponse.json(
      { error: 'mint_failed', detail: mintErr.message },
      { status },
    );
  }
  if (!minted || !minted.qr_tokens?.length) {
    return NextResponse.json({ error: 'mint_failed', detail: 'empty_batch' }, { status: 500 });
  }
  const batchId = minted.batch_id;
  const qrTokens = minted.qr_tokens;

  // -- 4. Pre-generate QR PNGs in parallel ---------------------------------
  const qrBuffers = await Promise.all(
    qrTokens.map((token) =>
      QRCode.toBuffer(`${PUBLIC_LOT_URL_BASE}${token}`, {
        errorCorrectionLevel: 'M',
        margin: 0,
        width: 240,
      }),
    ),
  );

  // -- 5. Build PDF --------------------------------------------------------
  const layout = LAYOUTS[size];
  const labelsPerPage = layout.cols * layout.rows;

  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const qrImages = await Promise.all(qrBuffers.map((buf) => doc.embedPng(buf)));

  let page = doc.addPage([layout.pageWidth, layout.pageHeight]);

  for (let i = 0; i < qrTokens.length; i++) {
    const token = qrTokens[i]!;
    const indexOnPage = i % labelsPerPage;
    if (i > 0 && indexOnPage === 0) {
      page = doc.addPage([layout.pageWidth, layout.pageHeight]);
    }

    const col = indexOnPage % layout.cols;
    const row = Math.floor(indexOnPage / layout.cols);

    const cellLeftX = layout.marginLeft + col * (layout.cellWidth + layout.gapX);
    const cellTopFromTop = layout.marginTop + row * (layout.cellHeight + layout.gapY);

    const innerLeftX = cellLeftX + layout.innerPadding;
    const innerTopFromTop = cellTopFromTop + layout.innerPadding;
    const innerWidth = layout.cellWidth - 2 * layout.innerPadding;
    const innerHeight = layout.cellHeight - 2 * layout.innerPadding;

    const qrSize = innerHeight;
    const qrTopFromTop = innerTopFromTop;
    const qrBottomY = layout.pageHeight - qrTopFromTop - qrSize;

    page.drawImage(qrImages[i]!, {
      x: innerLeftX,
      y: qrBottomY,
      width: qrSize,
      height: qrSize,
    });

    const textGutter = 6;
    const textLeftX = innerLeftX + qrSize + textGutter;
    const textWidth = innerWidth - qrSize - textGutter;

    const isLarge = size !== 'avery_5160';
    const headlineSize = isLarge ? 12 : 10;
    const subSize = isLarge ? 9 : 8;
    const tokenSize = isLarge ? 8 : 7;
    const lineGap = isLarge ? 4 : 2;

    // Headline — bold, signals this is unassigned. Stays identical
    // across sticker sizes so operators can recognize them on the
    // sheet at a glance.
    const headline = truncateToWidth(helveticaBold, 'BLANK', headlineSize, textWidth);
    const headlineTopFromTop = innerTopFromTop;
    const headlineBaselineY = layout.pageHeight - headlineTopFromTop - headlineSize;
    page.drawText(headline, {
      x: textLeftX,
      y: headlineBaselineY,
      size: headlineSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    // Sub-line — instructional copy. Truncated for the tight 5160 cell.
    const sub = truncateToWidth(
      helvetica,
      'Assign at lotting',
      subSize,
      textWidth,
    );
    const subBaselineY = headlineBaselineY - lineGap - subSize;
    page.drawText(sub, {
      x: textLeftX,
      y: subBaselineY,
      size: subSize,
      font: helvetica,
      color: rgb(0.3, 0.3, 0.3),
    });

    // Truncated UUID — human-readable backup if the sticker gets
    // physically separated from its pool row. Just the first 8 chars
    // matches how Supabase's dashboard displays UUIDs in logs.
    const shortToken = token.slice(0, 8);
    const tokenText = truncateToWidth(
      helvetica,
      shortToken,
      tokenSize,
      textWidth,
    );
    const tokenBaselineY = subBaselineY - lineGap - tokenSize;
    if (tokenBaselineY >= qrBottomY) {
      page.drawText(tokenText, {
        x: textLeftX,
        y: tokenBaselineY,
        size: tokenSize,
        font: helvetica,
        color: rgb(0.5, 0.5, 0.5),
      });
    }
  }

  const pdfBytes = await doc.save();
  const shortBatch = batchId.slice(0, 8);

  return new NextResponse(pdfBytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="blank-stickers-batch-${shortBatch}.pdf"`,
      'cache-control': 'no-store',
      // Surface the batch_id to clients that want to follow up via JSON
      // queries (the operator console "recent batches" panel can use
      // this for the "where did I just print?" link).
      'x-blank-qr-batch-id': batchId,
    },
  });
}
