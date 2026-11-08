export const PICKUP_INSTRUCTIONS_MAX = 1000;
export const CUSTOMER_NOTICE_MAX = 500;

export type CustomerInfoInput = {
  pickupInstructions: string;
  customerNotice: string;
  active: boolean;
};

export type ParsedCustomerInfo = {
  pickup_instructions: string | null;
  customer_notice: string | null;
  active: boolean;
};

export function parseCustomerInfoInput(
  input: CustomerInfoInput,
): { ok: true; data: ParsedCustomerInfo } | { ok: false; error: string } {
  const pickup = input.pickupInstructions.trim();
  if (pickup.length > PICKUP_INSTRUCTIONS_MAX) {
    return { ok: false, error: `Pickup instructions must be at most ${PICKUP_INSTRUCTIONS_MAX} characters` };
  }
  const notice = input.customerNotice.trim();
  if (notice.length > CUSTOMER_NOTICE_MAX) {
    return { ok: false, error: `Customer notice must be at most ${CUSTOMER_NOTICE_MAX} characters` };
  }
  return {
    ok: true,
    data: {
      pickup_instructions: pickup || null,
      customer_notice: notice || null,
      active: input.active,
    },
  };
}
