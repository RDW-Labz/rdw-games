// US phone display: "(870) 577-5971". Digits only, a leading country code 1
// on an 11-digit number is dropped; anything that isn't 10 digits after that
// is shown exactly as stored. Display only — never use the result as data.
export function formatUsPhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return trimmed;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
