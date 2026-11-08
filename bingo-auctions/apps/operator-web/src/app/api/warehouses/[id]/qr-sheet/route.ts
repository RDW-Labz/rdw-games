// QR sheet PDF — printable bin labels for the warehouse.
//
// Output: a multi-page PDF, US-Letter, 4 columns × 6 rows of QR + bin code
// labels (24 per page). Each cell:
//   ┌────────────┐
//   │  [QR PNG]  │
//   │            │
//   │  A-02-3-04 │  ← human-readable code
//   │  Aisle A   │  ← optional aisle hint
//   └────────────┘
// Operators print on adhesive label sheets and stick on physical bins.
//
// The QR encodes the bin's qr_token UUID directly (the BinScanner accepts
// either bare UUIDs or auction-platform://bin/<uuid> URIs; we use bare
// UUIDs here for max scanner compatibility).
//
// 2026-05-21: rewritten from pdfkit to pdf-lib. pdfkit reads its Helvetica
// AFM font data via fs.readFileSync(...AFM_PATH) at module init, which
// doesn't reliably resolve in the opennextjs-cloudflare worker bundle
// (Workers runtime restricts fs access to bundled assets, and pdfkit's
// AFM files weren't being copied through). The route was 500-ing in
// production. pdf-lib embeds its standard 14 fonts as JS strings — no
// fs reads, no AFM lookup, Workers-friendly.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLS = 4;
const ROWS = 6;
const MARGIN = 36; // 0.5"
const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const HEADER_H = 28; // first-page header takes this much off the top

// --------------------------------------------------------------------------
// Filter schema for POST. All fields optional; empty body == "all active
// bins" (same as the GET path). Filters AND together — e.g. aisles=['A']
// + unverified_only=true returns only A-aisle bins with no scan timestamp.
//
// bin_ids takes precedence when present: an explicit selection from the
// BinsTable row checkboxes bypasses the other filters entirely (the UI
// already shows the user exactly which rows they checked).
// --------------------------------------------------------------------------
const filterSchema = z
  .object({
    bin_ids: z.array(z.string().uuid()).min(1).max(2000).optional(),
    aisles: z.array(z.string().min(1).max(8)).max(50).optional(),
    sections: z.array(z.string().min(1).max(60)).max(50).optional(),
    unverified_only: z.boolean().optional(),
    search: z.string().max(60).optional(),
  })
  .strict();

type BinRow = { id: string; code: string; aisle: string; qr_token: string };

async function loadWarehouse(id: string) {
  const supabase = await getSupabaseServer();
  const { data: warehouse, error } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('id', id)
    .single();
  if (error || !warehouse) {
    return { supabase, warehouse: null as null };
  }
  return { supabase, warehouse };
}

function naturalSort(rows: BinRow[]): BinRow[] {
  return rows
    .slice()
    .sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' }),
    );
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, warehouse } = await loadWarehouse(id);
  if (!warehouse) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // GET: "print everything" — every active bin in the warehouse.
  const { data: bins, error: binsErr } = await supabase
    .from('bins')
    .select('id, code, aisle, qr_token')
    .eq('warehouse_id', id)
    // 0094: retired_at is the canonical active filter. The old is_active
    // column was never written by any RPC; retired_at IS NULL is the new
    // contract for "this bin is in use and should appear on the QR sheet".
    .is('retired_at', null);

  if (binsErr) {
    return NextResponse.json(
      { error: 'bins_query_failed', detail: binsErr.message },
      { status: 500 },
    );
  }
  if (!bins?.length) {
    return NextResponse.json({ error: 'no_bins' }, { status: 422 });
  }

  return renderPdf(naturalSort(bins as BinRow[]), warehouse as { id: string; name: string });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, warehouse } = await loadWarehouse(id);
  if (!warehouse) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let body: unknown = {};
  try {
    const text = await req.text();
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = filterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.issues[0]?.message ?? 'invalid' },
      { status: 400 },
    );
  }
  const { bin_ids, aisles, sections, unverified_only, search } = parsed.data;

  let query = supabase
    .from('bins')
    .select('id, code, aisle, qr_token')
    .eq('warehouse_id', id)
    .is('retired_at', null);

  if (bin_ids && bin_ids.length > 0) {
    // Explicit selection wins over everything else.
    query = query.in('id', bin_ids);
  } else {
    if (aisles && aisles.length > 0) query = query.in('aisle', aisles);
    if (sections && sections.length > 0) query = query.in('section', sections);
    if (unverified_only) query = query.is('scanned_at', null);
    if (search && search.trim().length > 0) {
      // Case-insensitive substring match on the code OR aisle, mirroring the
      // BinsTable client-side filter so "Print filtered" matches the UI.
      const term = search.trim().replace(/[%_]/g, (m) => `\\${m}`);
      query = query.or(`code.ilike.%${term}%,aisle.ilike.%${term}%`);
    }
  }

  const { data: bins, error: binsErr } = await query;
  if (binsErr) {
    return NextResponse.json(
      { error: 'bins_query_failed', detail: binsErr.message },
      { status: 500 },
    );
  }
  if (!bins?.length) {
    return NextResponse.json({ error: 'no_bins' }, { status: 422 });
  }

  return renderPdf(naturalSort(bins as BinRow[]), warehouse as { id: string; name: string });
}

async function renderPdf(bins: BinRow[], warehouse: { id: string; name: string }) {

  // 2026-05-25: rewritten to be Cloudflare Worker memory-friendly.
  // Prior version generated ALL QR PNGs in parallel and embedded ALL of
  // them into pdf-lib in parallel — for a 148-bin warehouse (BinGo) this
  // blew through the Worker's 128 MB cap and returned 1102 "exceeded its
  // limits".
  //
  // Memory analysis:
  //   * 240px QR PNG ≈ 3 KB; 148 bins × 3 KB = ~450 KB raw bytes
  //   * pdf-lib's embedPng allocates an internal image stream copy
  //   * Promise.all means peak memory holds ALL buffers + ALL pdf-lib
  //     intermediate state simultaneously
  //   * The 128 MB cap is a hard Workers ceiling — no higher memory tier
  //     exists on Workers Paid; the fix has to be memory-side.
  //
  // Fix: process QR generation + embed sequentially in batches of 12.
  // Peak memory now bounded to BATCH_SIZE × per-bin state regardless of
  // bin count. QR raster kept at 240 px so future single-large-QR prints
  // (aisle endcap labels etc.) don't need raster regen — at the current
  // 24-per-page grid the cell is ~50mm wide so 240 vs 180 is invisible
  // on print, but the higher raster gives headroom for blow-up prints.

  const cellW = (PAGE_W - 2 * MARGIN) / COLS;
  const cellH = (PAGE_H - 2 * MARGIN) / ROWS;
  const qrSize = Math.min(cellW, cellH) - 32;

  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const qrImages: Awaited<ReturnType<typeof doc.embedPng>>[] = [];
  const BATCH_SIZE = 12;
  for (let i = 0; i < bins.length; i += BATCH_SIZE) {
    const batch = bins.slice(i, i + BATCH_SIZE);
    const buffers = await Promise.all(
      batch.map((b) =>
        QRCode.toBuffer(b.qr_token as string, {
          errorCorrectionLevel: 'M',
          margin: 0,
          width: 240,
        }),
      ),
    );
    for (const buf of buffers) {
      qrImages.push(await doc.embedPng(buf));
    }
  }

  let page = doc.addPage([PAGE_W, PAGE_H]);

  // Page header on first page only — the rest are pure label grids so the
  // adhesive sheets are usable.
  // pdf-lib uses PDF coordinates (origin = bottom-left), so y is measured
  // from the bottom. We flip in our cell loop below.
  page.drawText(`${warehouse.name as string} — Bin labels`, {
    x: MARGIN,
    y: PAGE_H - 32,
    size: 14,
    font: helveticaBold,
    color: rgb(0, 0, 0),
  });
  page.drawText(
    `${bins.length} bins · printed ${new Date().toLocaleString()}`,
    {
      x: MARGIN,
      y: PAGE_H - 48,
      size: 8,
      font: helvetica,
      color: rgb(0.3, 0.3, 0.3),
    },
  );

  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i]!;
    const indexOnPage = i % (COLS * ROWS);
    if (i > 0 && indexOnPage === 0) {
      page = doc.addPage([PAGE_W, PAGE_H]);
    }

    const col = indexOnPage % COLS;
    const row = Math.floor(indexOnPage / COLS);

    // First page reserves the top HEADER_H pixels for the header.
    const isFirstPage = i < COLS * ROWS;
    const topOffset = isFirstPage ? HEADER_H : 0;

    // PDF coords: origin is bottom-left. Convert from "from-top" to
    // "from-bottom" by subtracting from PAGE_H.
    const cellTopFromTop = MARGIN + topOffset + row * cellH;
    const cellTopY = PAGE_H - cellTopFromTop;

    const cellLeftX = MARGIN + col * cellW;

    // QR — centered horizontally in the cell, with 8px top padding inside
    // the cell. Image is drawn from its bottom-left corner in pdf-lib.
    const qrX = cellLeftX + (cellW - qrSize) / 2;
    const qrTopFromTop = cellTopFromTop + 8;
    const qrBottomY = PAGE_H - qrTopFromTop - qrSize;
    page.drawImage(qrImages[i]!, {
      x: qrX,
      y: qrBottomY,
      width: qrSize,
      height: qrSize,
    });

    // Bin code (large, bold) — centered under the QR.
    const code = bin.code as string;
    const codeSize = 13;
    const codeWidth = helveticaBold.widthOfTextAtSize(code, codeSize);
    page.drawText(code, {
      x: cellLeftX + (cellW - codeWidth) / 2,
      y: qrBottomY - codeSize - 4,
      size: codeSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    // Aisle hint (small, regular) — centered under the bin code.
    const aisleText = `Aisle ${bin.aisle as string}`;
    const aisleSize = 8;
    const aisleWidth = helvetica.widthOfTextAtSize(aisleText, aisleSize);
    page.drawText(aisleText, {
      x: cellLeftX + (cellW - aisleWidth) / 2,
      y: qrBottomY - codeSize - 4 - aisleSize - 4,
      size: aisleSize,
      font: helvetica,
      color: rgb(0.3, 0.3, 0.3),
    });
  }

  const pdfBytes = await doc.save();

  return new NextResponse(pdfBytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="bin-labels-${(warehouse.name as string)
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
