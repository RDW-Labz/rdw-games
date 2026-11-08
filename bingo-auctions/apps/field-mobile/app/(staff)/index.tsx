// Staff home. For now, a thin menu listing the picker workflows.
// As Phase C and Phase 3 come online this gains additional sections
// (warehouse layout capture, LotTR mobile) and admins/managers see
// extra cards (staff invites, operator settings).

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Link, type Href, useFocusEffect } from 'expo-router';
import {
  useOperatorRole,
  listMyReports,
  unseenResolved,
} from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { WorkflowIcon, type WorkflowIconName } from '../../components/WorkflowIcon';
import { useActiveWorker } from '@/features/auth/WorkerContext';
import { getLastSeen } from '@/features/feedback/seen-store';

export default function StaffHome() {
  const role = useOperatorRole();
  const roleLabel = role.kind === 'staff' ? role.role : '…';
  const { worker, openSwitcher } = useActiveWorker();

  // How many of this worker's reports were resolved since they last looked.
  //
  // On focus rather than on mount: they arrive here straight from the feedback
  // screen that just cleared the badge, and a stale count sitting there would
  // undo the one thing the screen was for.
  const [fixedForYou, setFixedForYou] = useState(0);
  const refreshFixed = useCallback(() => {
    const label = worker?.displayName ?? null;
    if (!label) {
      setFixedForYou(0);
      return;
    }
    void (async () => {
      const [rows, since] = await Promise.all([listMyReports(label), getLastSeen(label)]);
      setFixedForYou(unseenResolved(rows, since).length);
    })();
  }, [worker?.displayName]);

  useFocusEffect(refreshFixed);
  useEffect(refreshFixed, [refreshFixed]);

  return (
    <ScrollView
      testID="staff-home-screen"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 24, gap: 12 }}
    >
      <Text
        style={{
          color: colors.primary,
          fontSize: 11,
          ...type.label,
          marginBottom: 4,
        }}
      >
        BinGo Staff · {roleLabel}
      </Text>
      <Text
        style={{
          color: colors.text,
          fontSize: 28,
          ...type.displayHero,
          marginBottom: 12,
        }}
      >
        Field operations
      </Text>

      {worker && (
        <Pressable
          onPress={openSwitcher}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: colors.surface,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
            paddingVertical: 12,
            paddingHorizontal: 14,
            marginBottom: 8,
          }}
        >
          <Text style={{ color: colors.text, fontWeight: '800' }}>Clocked in: {worker.displayName}</Text>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>Switch / clock out ›</Text>
        </Pressable>
      )}

      <Section title="Receiving">
        <Link href="/put-away" asChild>
          <PrimaryAction
            icon="putaway"
            label="Put-away — single, batch, shelf scan"
            tone="primary"
          />
        </Link>
      </Section>

      <Section title="Check Out">
        <Link href={'/checkout' as Href} asChild>
          <PrimaryAction
            testID="tab-checkout"
            icon="checkout"
            label="Check Out — verify, stage, hand over"
            tone="primary"
          />
        </Link>
      </Section>

      <Section title="Warehouse layout">
        <Link href="/layout" asChild>
          <PrimaryAction
            icon="layout"
            label="Set up the floor map + bin photos"
            tone="surface"
          />
        </Link>
      </Section>

      <Section title="Lotting">
        <Link href="/lotting" asChild>
          <PrimaryAction
            testID="tab-lotting-hub"
            icon="lotting"
            label="Scan UPC → identify + price"
            tone="surface"
          />
        </Link>
      </Section>

      <Section title="Inventory">
        <Link href={'/layout/bins/contents' as Href} asChild>
          <PrimaryAction
            testID="tab-bin-lookup"
            icon="binlookup"
            label="Bin lookup — scan a bin, see what's in it"
            tone="surface"
          />
        </Link>
        <Link href={'/layout/lots/find' as Href} asChild>
          <PrimaryAction
            testID="tab-lot-lookup"
            icon="binlookup"
            label="Lot lookup — scan an item, see where it is"
            tone="surface"
          />
        </Link>
        <Link href={'/layout/bins/audit' as Href} asChild>
          <PrimaryAction
            testID="tab-bin-audit"
            icon="binlookup"
            label="Bin audit — check a bin against the system"
            tone="surface"
          />
        </Link>
      </Section>

      {/* 2026-08-13 — the testers' channel back to us. `ghost` tone on
          purpose: it belongs on the home screen so it's findable from
          anywhere without hunting, but it is not a warehouse workflow and
          shouldn't compete with the cards above for a picker's attention.
          
          2026-08-30 — unless something they reported got fixed. Then it is
          promoted to `surface` and says so. This is the only feedback the
          reporter ever gets that the thing they took two minutes to write up
          actually changed the app, and it is worth one card's attention for
          exactly as long as it takes them to read it. */}
      <Section title="Help us improve">
        <Link href={'/feedback' as Href} asChild>
          <PrimaryAction
            testID="tab-feedback"
            icon="feedback"
            label={
              fixedForYou > 0
                ? `✓ ${fixedForYou} of your report${fixedForYou === 1 ? ' was' : 's were'} fixed — see what changed`
                : 'Report a bug or suggest an idea'
            }
            tone={fixedForYou > 0 ? 'surface' : 'ghost'}
          />
        </Link>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        style={{
          color: colors.textMuted,
          fontSize: 11,
          ...type.label,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

const PrimaryAction = ({
  icon,
  label,
  tone,
  ...rest
}: {
  icon: WorkflowIconName;
  label: string;
  tone: 'primary' | 'surface' | 'ghost';
} & React.ComponentProps<typeof Pressable>) => {
  const isPrimary = tone === 'primary';
  const fg = isPrimary ? '#000' : colors.text;
  return (
    <Pressable
      {...rest}
      style={{
        padding: 16,
        backgroundColor:
          tone === 'primary'
            ? colors.primary
            : tone === 'surface'
              ? colors.surface
              : 'transparent',
        borderColor: tone === 'ghost' ? colors.border : 'transparent',
        borderWidth: tone === 'ghost' ? 1 : 0,
        borderRadius: 10,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
        }}
      >
        <WorkflowIcon name={icon} size={24} color={fg} />
        <Text
          style={{
            color: fg,
            fontSize: 14,
            textAlign: 'center',
            flexShrink: 1,
            ...type.label,
          }}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
};
