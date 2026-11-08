'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyle, inputStyle, Field } from '@/components/Form';
import { saveCustomerInfo } from './actions';
import { CUSTOMER_NOTICE_MAX, PICKUP_INSTRUCTIONS_MAX } from './parse-customer-info';

export function CustomerInfoForm({
  warehouseId,
  initialPickupInstructions,
  initialCustomerNotice,
  initialActive,
}: {
  warehouseId: string;
  initialPickupInstructions: string;
  initialCustomerNotice: string;
  initialActive: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pickupInstructions, setPickupInstructions] = useState(initialPickupInstructions);
  const [customerNotice, setCustomerNotice] = useState(initialCustomerNotice);
  const [active, setActive] = useState(initialActive);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveCustomerInfo(warehouseId, {
        pickupInstructions,
        customerNotice,
        active,
      });
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        router.refresh();
      }
    });
  }

  const textareaStyle: React.CSSProperties = {
    ...inputStyle,
    minHeight: 120,
    resize: 'vertical',
    fontFamily: 'inherit',
  };

  return (
    <div style={{ display: 'grid', gap: '1.5rem', maxWidth: 640 }}>
      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255,84,112,0.08)',
            border: '1px solid rgba(255,84,112,0.4)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--danger)',
          }}
        >
          {error}
        </div>
      )}

      <Field
        label="Pickup instructions"
        htmlFor="pickupInstructions"
        hint={`Optional · up to ${PICKUP_INSTRUCTIONS_MAX} characters`}
      >
        <textarea
          id="pickupInstructions"
          value={pickupInstructions}
          onChange={(e) => setPickupInstructions(e.target.value)}
          maxLength={PICKUP_INSTRUCTIONS_MAX}
          rows={5}
          style={textareaStyle}
        />
      </Field>

      <Field
        label="Customer notice (off-site banner)"
        htmlFor="customerNotice"
        hint="Leave empty for a normal warehouse. When set, customers see this before bidding on this warehouse's auctions."
      >
        <textarea
          id="customerNotice"
          value={customerNotice}
          onChange={(e) => setCustomerNotice(e.target.value)}
          maxLength={CUSTOMER_NOTICE_MAX}
          rows={4}
          style={textareaStyle}
        />
      </Field>

      <Field
        label="Active"
        htmlFor="warehouseActive"
        hint="Inactive warehouses are hidden from auction, lotting and staff-app pickers. Nothing is deleted."
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 14 }}>
          <input
            id="warehouseActive"
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          Warehouse is active
        </label>
      </Field>

      <button onClick={handleSave} disabled={pending} style={{ ...buttonStyle, justifySelf: 'start' }}>
        {saved ? 'Saved!' : pending ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
