// Operator Console shared component library (design-system rollout Wave 0).
//
// One import surface for every console screen. The per-route waves (auctions,
// bidders, invoices, dashboard, …) migrate to these so status color, tables,
// KPIs, filters, dividers, and numeric type are identical everywhere and drift
// is impossible. All are server-component-safe (hover/animation live in
// `.console-*` classes in globals.css); none require 'use client' on their own.

export { StatusPill, statusTone } from './StatusPill';
export { FilterPills } from './FilterPills';
export type { FilterOption } from './FilterPills';
export { DataTable } from './DataTable';
export type { Column } from './DataTable';
export { KpiCard, LiveChip } from './KpiCard';
export { SectionDivider } from './SectionDivider';
export { MoneyText, MonoText } from './MoneyText';
