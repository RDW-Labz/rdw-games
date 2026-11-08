// Reusable 4-step guided condition modal.
//
// Port of Lottr App's ConditionWorkflow.jsx to React Native.
// Renders as a full-screen overlay (caller wraps in a Modal or
// presents it from a fullScreenModal route). Returns a
// ConditionWorkflowData object matching domain-lotting's types.
//
// Usage:
//   import { ConditionWorkflow } from '@/features/lotting/ConditionWorkflow';
//   <ConditionWorkflow
//     initial={existingData}
//     onSave={(data) => { /* use data */ }}
//     onClose={() => setVisible(false)}
//   />

import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  SafeAreaView,
  Modal,
  StyleSheet,
} from 'react-native';
import type { ConditionWorkflowData } from '@auction-platform/domain-lotting';
import { colors, type } from '@auction-platform/design-system';

// ─── Data tables ─────────────────────────────────────────────────────────────

const CONDITIONS = [
  {
    key: 'New/Sealed' as const,
    label: 'New / Sealed',
    desc: 'Factory sealed, never opened',
    color: '#22c55e',
  },
  {
    key: 'New/Open Box' as const,
    label: 'New / Open Box',
    desc: 'Opened but unused, all parts present',
    color: '#22c55e',
  },
  {
    key: 'Like New' as const,
    label: 'Like New',
    desc: 'Used briefly, no visible wear',
    color: '#5cacff',
  },
  {
    key: 'Very Good' as const,
    label: 'Very Good',
    desc: 'Light wear, fully functional',
    color: '#5cacff',
  },
  {
    key: 'Good' as const,
    label: 'Good',
    desc: 'Normal wear, works properly',
    color: '#ffb347',
  },
  {
    key: 'Fair' as const,
    label: 'Fair',
    desc: 'Heavy wear or cosmetic damage, still works',
    color: '#ffb347',
  },
  {
    key: 'Damaged/Parts' as const,
    label: 'Damaged / For Parts',
    desc: 'Significant damage, may not work',
    color: '#ff5c5c',
  },
] as const;

type ConditionKey = (typeof CONDITIONS)[number]['key'];

const DAMAGE_TYPES = [
  'Scratches',
  'Dents',
  'Cracks',
  'Stains',
  'Tears',
  'Rust',
  'Chips',
  'Fading',
  'Water damage',
  'Bent/Warped',
];

const MISSING_PARTS = [
  'None missing',
  'Remote',
  'Power cord',
  'Battery',
  'Charger',
  'Manual',
  'Hardware/screws',
  'Accessories',
  'Original box',
  'Other',
];

const FUNCTIONALITY: { key: ConditionWorkflowData['functionality']; label: string; color: string }[] = [
  { key: 'untested', label: 'Untested', color: colors.textMuted },
  { key: 'works', label: 'Powers on / Works', color: '#22c55e' },
  { key: 'partial', label: 'Partial function', color: '#ffb347' },
  { key: 'broken', label: 'Does not work', color: colors.danger },
  { key: undefined, label: 'N/A (no power)', color: colors.textMuted },
] as { key: ConditionWorkflowData['functionality']; label: string; color: string }[];

const ASSEMBLY: { key: ConditionWorkflowData['assembly']; label: string }[] = [
  { key: undefined, label: 'N/A' },
  { key: 'assembled', label: 'Fully assembled' },
  { key: 'partial', label: 'Partially assembled' },
  { key: 'unassembled', label: 'Unassembled / In box' },
  { key: 'incomplete', label: 'Incomplete assembly' },
];

const STEP_LABELS = ['Condition', 'Damage', 'Missing', 'Function'];

// ─── Sub-components ───────────────────────────────────────────────────────────

function Chip({
  label,
  active,
  color,
  onPress,
}: {
  label: string;
  active: boolean;
  color?: string;
  onPress: () => void;
}) {
  const c = color ?? '#22c55e';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        paddingVertical: 14,
        borderRadius: 10,
        backgroundColor: active ? `${c}1A` : colors.surface,
        borderWidth: 1.5,
        borderColor: active ? `${c}66` : colors.border,
        opacity: pressed ? 0.75 : 1,
        justifyContent: 'center',
      })}
    >
      <Text
        style={{
          color: active ? c : colors.textMuted,
          fontSize: 13,
          fontWeight: '700',
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export type ConditionWorkflowProps = {
  initial?: Partial<ConditionWorkflowData>;
  onSave: (data: ConditionWorkflowData & { conditionNotes: string }) => void;
  onClose: () => void;
  visible?: boolean;
};

export function ConditionWorkflow({
  initial,
  onSave,
  onClose,
  visible = true,
}: ConditionWorkflowProps) {
  const [step, setStep] = useState(0);
  const [condition, setCondition] = useState<ConditionKey | ''>(
    (initial?.condition as ConditionKey) ?? '',
  );
  const [damages, setDamages] = useState<string[]>(initial?.damages ?? []);
  const [missing, setMissing] = useState<string[]>(initial?.missing ?? []);
  const [functionality, setFunctionality] = useState<
    ConditionWorkflowData['functionality']
  >(initial?.functionality);
  const [assembly, setAssembly] = useState<ConditionWorkflowData['assembly']>(
    initial?.assembly,
  );

  const toggleDamage = (d: string) =>
    setDamages((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );

  const toggleMissing = (m: string) => {
    if (m === 'None missing') {
      setMissing(['None missing']);
      return;
    }
    setMissing((prev) => {
      const next = prev.filter((x) => x !== 'None missing');
      return next.includes(m) ? next.filter((x) => x !== m) : [...next, m];
    });
  };

  const shouldReadDesc =
    condition !== '' && !['New/Sealed', 'New/Open Box'].includes(condition);

  const buildResult = () => {
    const parts: string[] = [];
    if (damages.length > 0) parts.push('Damage: ' + damages.join(', '));
    if (missing.length > 0 && !missing.includes('None missing'))
      parts.push('Missing: ' + missing.join(', '));
    const funcLabel = FUNCTIONALITY.find((f) => f.key === functionality)?.label;
    if (funcLabel && functionality !== 'untested') parts.push('Function: ' + funcLabel);
    const asmLabel = ASSEMBLY.find((a) => a.key === assembly)?.label;
    if (asmLabel && assembly != null) parts.push('Assembly: ' + asmLabel);
    return {
      condition: condition || undefined,
      damages,
      missing,
      functionality,
      assembly,
      conditionNotes: parts.join('. '),
    };
  };

  // ── Step renderers ──────────────────────────────────────────────────────────

  const renderStep0 = () => (
    <ScrollView
      contentContainerStyle={{ gap: 8, paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.sectionLabel}>What condition is this item?</Text>
      {CONDITIONS.map((c) => (
        <Pressable
          key={c.key}
          onPress={() => {
            setCondition(c.key);
            setStep(1);
          }}
          style={({ pressed }) => ({
            padding: 16,
            borderRadius: 12,
            backgroundColor:
              condition === c.key ? `${c.color}1A` : colors.surface,
            borderWidth: 1.5,
            borderColor:
              condition === c.key ? `${c.color}55` : colors.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Text
            style={{
              fontSize: 15,
              fontWeight: '800',
              color: condition === c.key ? c.color : colors.text,
            }}
          >
            {c.label}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 3 }}>
            {c.desc}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );

  const renderStep1 = () => (
    <ScrollView
      contentContainerStyle={{ gap: 8, paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.sectionLabel}>Any damage? (tap all that apply)</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip
          label="No damage"
          active={damages.length === 0}
          color="#22c55e"
          onPress={() => {
            setDamages([]);
            setStep(2);
          }}
        />
        {DAMAGE_TYPES.map((d) => (
          <Chip
            key={d}
            label={d}
            active={damages.includes(d)}
            color="#ffb347"
            onPress={() => toggleDamage(d)}
          />
        ))}
      </View>
      {damages.length > 0 && (
        <Pressable onPress={() => setStep(2)} style={s.nextBtn}>
          <Text style={s.nextBtnText}>Next — Missing parts</Text>
        </Pressable>
      )}
    </ScrollView>
  );

  const renderStep2 = () => (
    <ScrollView
      contentContainerStyle={{ gap: 8, paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.sectionLabel}>Missing parts? (tap all that apply)</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {MISSING_PARTS.map((m) => (
          <Chip
            key={m}
            label={m}
            active={missing.includes(m)}
            color={m === 'None missing' ? '#22c55e' : '#ffb347'}
            onPress={() => toggleMissing(m)}
          />
        ))}
      </View>
      {missing.length > 0 && (
        <Pressable onPress={() => setStep(3)} style={s.nextBtn}>
          <Text style={s.nextBtnText}>Next — Functionality</Text>
        </Pressable>
      )}
    </ScrollView>
  );

  const renderStep3 = () => (
    <ScrollView
      contentContainerStyle={{ gap: 8, paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.sectionLabel}>Does it work?</Text>
      {FUNCTIONALITY.map((f) => (
        <Chip
          key={f.label}
          label={f.label}
          active={functionality === f.key}
          color={f.color}
          onPress={() => setFunctionality(f.key)}
        />
      ))}

      <Text style={[s.sectionLabel, { marginTop: 16 }]}>Assembly status</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {ASSEMBLY.map((a) => (
          <Chip
            key={a.label}
            label={a.label}
            active={assembly === a.key}
            onPress={() => setAssembly(a.key)}
          />
        ))}
      </View>

      {shouldReadDesc && (
        <View style={s.readDescBanner}>
          <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
            READ DESCRIPTION flag active
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
            Non-new items get a red banner on the listing photo
          </Text>
        </View>
      )}

      {/* Summary */}
      <View style={s.summaryBox}>
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label, marginBottom: 6 }}>
          Summary
        </Text>
        <Text style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>
          <Text style={{ fontWeight: '800' }}>{condition}</Text>
          {damages.length > 0 && ` · Damage: ${damages.join(', ')}`}
          {missing.length > 0 &&
            !missing.includes('None missing') &&
            ` · Missing: ${missing.join(', ')}`}
          {functionality && ` · ${FUNCTIONALITY.find((f) => f.key === functionality)?.label ?? ''}`}
        </Text>
      </View>

      <Pressable onPress={() => onSave(buildResult())} style={s.saveBtn}>
        <Text style={s.saveBtnText}>Save condition</Text>
      </Pressable>
    </ScrollView>
  );

  const stepRenderers = [renderStep0, renderStep1, renderStep2, renderStep3];

  const inner = (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ color: '#22c55e', fontSize: 16, fontWeight: '800' }}>
            Condition
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            Step {step + 1}/4
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {step > 0 && (
            <Pressable
              onPress={() => setStep((s) => s - 1)}
              accessibilityRole="button"
              accessibilityLabel="Back"
              accessibilityHint="Returns to the previous condition step"
              style={s.ghostBtn}
            >
              <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
                Back
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            accessibilityHint="Discards the condition workflow without saving"
            style={s.ghostBtn}
          >
            <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '700' }}>
              Cancel
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Progress bar (A11Y-P1-RN-7: progressbar role announces "step N of 4"). */}
      <View
        style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 16, marginBottom: 4 }}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Condition workflow progress, step ${step + 1} of ${STEP_LABELS.length}`}
        accessibilityValue={{ min: 1, max: STEP_LABELS.length, now: step + 1 }}
      >
        {STEP_LABELS.map((_label, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: i <= step ? '#22c55e' : colors.border,
            }}
          />
        ))}
      </View>

      {/* Step labels */}
      <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 16, marginBottom: 16 }}>
        {STEP_LABELS.map((label, i) => (
          <Text
            key={i}
            style={{
              flex: 1,
              fontSize: 9,
              textAlign: 'center',
              color: i <= step ? '#22c55e' : colors.textDim,
              fontWeight: '700',
              textTransform: 'uppercase',
            }}
          >
            {label}
          </Text>
        ))}
      </View>

      <View style={{ flex: 1, paddingHorizontal: 16 }}>
        {(stepRenderers[step] ?? renderStep0)()}
      </View>
    </SafeAreaView>
  );

  // Can be rendered standalone or inside a Modal
  if (!visible) return null;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {inner}
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 8,
  },
  ghostBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  nextBtn: {
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  nextBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '800',
  },
  saveBtn: {
    marginTop: 8,
    padding: 18,
    borderRadius: 12,
    backgroundColor: '#22c55e',
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
  },
  readDescBanner: {
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.danger}55`,
    backgroundColor: colors.dangerDim,
  },
  summaryBox: {
    marginTop: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
});
