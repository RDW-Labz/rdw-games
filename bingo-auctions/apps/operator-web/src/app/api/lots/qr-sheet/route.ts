// Per-lot QR sheet PDF — printable lot labels in selectable Avery sizes.
//
// Output: a PDF whose page size and grid layout depend on the chosen
// `size`. Each label cell carries a QR (encoding the public lot URL) on
// the left, and the lot_code (bold) plus a truncated title on the right.
// Optional "Was BF#…" line below the title shows the legacy code when
// the lot was imported from another platform.
//
// Selection modes (POST body, exactly one of):
//   { lot_ids:   ["uuid", …] }              — explicit list (max ~500)
//   { auction_id: "uuid" }                  — all lots in an auction
//   { batch_id:   "uuid" }                  — all lots in an import batch
//
// + size: "avery_5160" | "avery_5163" | "thermal_2x4"
//
// Sizes
// -----
//   avery_5160   1.00" × 2.625"   30/page    3 cols × 10 rows  (US Letter)
//   avery_5163   2.00" × 4.000"   10/page    2 cols × 5  rows  (US Letter)
//   thermal_2x4  2.00" × 4.000"   1/page     direct print      (288×144 pt)
//
// Auth: getSupabaseServer() verifies the caller is signed in. RLS on
// `lots` already scopes results to the caller's operator, so if a caller
// passes lot_ids they don't own the query simply returns fewer rows.
//
// Runtime: nodejs (opennextjs-cloudflare). Built on pdf-lib (NOT pdfkit)
// for the same Workers-compat reason as the bin QR sheet — pdfkit needs
// fs reads for its AFM font tables, which don't reliably resolve in the
// worker bundle. pdf-lib embeds Helvetica as a JS string.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// --------------------------------------------------------------------------
// Public URL prefix encoded in the QR — must match the universal-link host
// configured for bingoauctions.com (see 0103: resolve_lot_by_qr_token + the
// /l/[token] route handler).
// --------------------------------------------------------------------------
const PUBLIC_LOT_URL_BASE = 'https://bingoauctions.com/l/';

const MAX_LOTS_PER_CALL = 500;

// --------------------------------------------------------------------------
// Layout specs (all values in PDF points; 72 pt = 1 inch).
// --------------------------------------------------------------------------

type LabelSize = 'avery_5160' | 'avery_5163' | 'thermal_2x4';

interface LayoutSpec {
  pageWidth: number;
  pageHeight: number;
  cols: number;
  rows: number;
  // Top-of-page offset to the top of the first row of labels.
  marginTop: number;
  // Left-of-page offset to the left of the first column of labels.
  marginLeft: number;
  cellWidth: number;
  cellHeight: number;
  // Horizontal gap between columns (rows are edge-to-edge for both Avery
  // SKUs we support).
  gapX: number;
  gapY: number;
  // Padding inside each label cell. Used as inner whitespace around QR
  // and text so the design tolerates ±1mm printer drift.
  innerPadding: number;
}

const LAYOUTS: Record<LabelSize, LayoutSpec> = {
  // Avery 5160 — 1" × 2 5/8", 30 per US Letter sheet.
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
  // Avery 5163 — 2" × 4", 10 per US Letter sheet.
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
  // Thermal 2"×4" — one label per page, no grid, no margins.
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

// --------------------------------------------------------------------------
// Request schema. Exactly one of lot_ids / auction_id / batch_id required.
// --------------------------------------------------------------------------

const requestSchema = z
  .object({
    lot_ids: z.array(z.string().uuid()).min(1).max(MAX_LOTS_PER_CALL).optional(),
    auction_id: z.string().uuid().optional(),
    batch_id: z.string().uuid().optional(),
    size: z.enum(['avery_5160', 'avery_5163', 'thermal_2x4']),
  })
  .refine(
    (v) => {
      const provided = [v.lot_ids, v.auction_id, v.batch_id].filter(
        (x) => x !== undefined,
      ).length;
      return provided === 1;
    },
    { message: 'exactly one of lot_ids, auction_id, batch_id is required' },
  );

interface LotRow {
  id: string;
  lot_code: string;
  title: string;
  qr_token: string;
  legacy_lot_code: string | null;
}

// --------------------------------------------------------------------------
// Truncate `text` to fit inside `maxWidth` at `size`pt of `font`. Appends
// an ellipsis if a cut was needed. Returns the original string when it
// already fits.
// --------------------------------------------------------------------------
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
  const { lot_ids, auction_id, batch_id, size } = parsed.data;

  // -- 2. Auth -------------------------------------------------------------
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // -- 3. Resolve lot set (RLS scopes to the caller's operator) ------------
  const selectCols = 'id, lot_code, title, qr_token, legacy_lot_code';
  let lotsQuery = supabase.from('lots').select(selectCols);
  if (lot_ids) {
    lotsQuery = lotsQuery.in('id', lot_ids);
  } else if (auction_id) {
    lotsQuery = lotsQuery.eq('auction_id', auction_id);
  } else if (batch_id) {
    lotsQuery = lotsQuery.eq('lot_import_batch_id', batch_id);
  }
  const { data: lots, error: lotsErr } = await lotsQuery.order('lot_code').limit(
    MAX_LOTS_PER_CALL,
  );

  if (lotsErr) {
    return NextResponse.json(
      { error: 'lots_query_failed', detail: lotsErr.message },
      { status: 500 },
    );
  }
  if (!lots?.length) {
    return NextResponse.json({ error: 'no_lots' }, { status: 422 });
  }

  const typedLots = lots as unknown as LotRow[];

  // -- 4. Pre-generate QR PNGs in parallel ---------------------------------
  const qrBuffers = await Promise.all(
    typedLots.map((l) =>
      QRCode.toBuffer(`${PUBLIC_LOT_URL_BASE}${l.qr_token}`, {
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

  for (let i = 0; i < typedLots.length; i++) {
    const lot = typedLots[i]!;
    const indexOnPage = i % labelsPerPage;
    if (i > 0 && indexOnPage === 0) {
      page = doc.addPage([layout.pageWidth, layout.pageHeight]);
    }

    const col = indexOnPage % layout.cols;
    const row = Math.floor(indexOnPage / layout.cols);

    // Cell coordinates measured from the top-left (then converted to
    // pdf-lib's bottom-left origin further down).
    const cellLeftX =
      layout.marginLeft + col * (layout.cellWidth + layout.gapX);
    const cellTopFromTop =
      layout.marginTop + row * (layout.cellHeight + layout.gapY);

    // Cell interior, with innerPadding shaved off all sides.
    const innerLeftX = cellLeftX + layout.innerPadding;
    const innerTopFromTop = cellTopFromTop + layout.innerPadding;
    const innerWidth = layout.cellWidth - 2 * layout.innerPadding;
    const innerHeight = layout.cellHeight - 2 * layout.innerPadding;

    // QR fills the cell height (minus inner padding) and is square.
    const qrSize = innerHeight;
    const qrTopFromTop = innerTopFromTop;
    const qrBottomY = layout.pageHeight - qrTopFromTop - qrSize;

    page.drawImage(qrImages[i]!, {
      x: innerLeftX,
      y: qrBottomY,
      width: qrSize,
      height: qrSize,
    });

    // Text column starts to the right of the QR with a small gutter.
    const textGutter = 6;
    const textLeftX = innerLeftX + qrSize + textGutter;
    const textWidth = innerWidth - qrSize - textGutter;

    // Font sizes scale with the label size — 5160 is tight, 5163/thermal
    // can show more. The thresholds match what fits inside cellWidth at
    // the median lot_code length ("CLR-000087", ~70pt at 11pt bold).
    const isLarge = size !== 'avery_5160';
    const codeSize = isLarge ? 14 : 11;
    const titleSize = isLarge ? 10 : 9;
    const legacySize = isLarge ? 8 : 7;
    const lineGap = isLarge ? 4 : 2;

    // lot_code (top line). Bold. Truncated only if absurdly long.
    const lotCode = truncateToWidth(
      helveticaBold,
      lot.lot_code,
      codeSize,
      textWidth,
    );
    const codeTopFromTop = innerTopFromTop;
    const codeBaselineY =
      layout.pageHeight - codeTopFromTop - codeSize;
    page.drawText(lotCode, {
      x: textLeftX,
      y: codeBaselineY,
      size: codeSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    // Title (one line, truncated with ellipsis if needed).
    const titleText = truncateToWidth(
      helvetica,
      lot.title,
      titleSize,
      textWidth,
    );
    const titleBaselineY = codeBaselineY - lineGap - titleSize;
    page.drawText(titleText, {
      x: textLeftX,
      y: titleBaselineY,
      size: titleSize,
      font: helvetica,
      color: rgb(0, 0, 0),
    });

    // Legacy code (optional). Only shown if it'd fit below the title
    // without spilling out of the cell.
    if (lot.legacy_lot_code) {
      const legacyText = truncateToWidth(
        helvetica,
        `Was ${lot.legacy_lot_code}`,
        legacySize,
        textWidth,
      );
      const legacyBaselineY = titleBaselineY - lineGap - legacySize;
      // qrBottomY is the floor of the cell interior; only draw if we're
      // above it. This protects 5160's tight 1" cell from overflowing.
      if (legacyBaselineY >= qrBottomY) {
        page.drawText(legacyText, {
          x: textLeftX,
          y: legacyBaselineY,
          size: legacySize,
          font: helvetica,
          color: rgb(0.4, 0.4, 0.4),
        });
      }
    }
  }

  const pdfBytes = await doc.save();

  return new NextResponse(pdfBytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="lot-labels-${size}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
