import type { CSSProperties } from 'react';
import { resolveLotIdentity, type LotIdentityInput } from './lot-identity';

export type LotIdentityProps = {
  lot: LotIdentityInput;
  showSignatureRule?: boolean;
  /** 'lg' = the 40px identity on lot detail (G-SPEC); default = row size. */
  size?: 'md' | 'lg';
};

const signatureRule: CSSProperties = {
  borderLeft: 'var(--console-signature-width) solid var(--console-action)',
  paddingLeft: 'var(--console-space-2)',
};

function formatSecondaryBin(code: string): string {
  const upper = code.toUpperCase();
  if (upper.startsWith('BIN-') || upper.startsWith('BIN ')) return code;
  return `BIN ${code}`;
}

export function LotIdentity({ lot, showSignatureRule = true, size = 'md' }: LotIdentityProps) {
  const identity = resolveLotIdentity(lot);
  const blockStyle: CSSProperties = showSignatureRule ? signatureRule : {};

  return (
    <div style={blockStyle}>
      <div
        className="console-v2-code"
        style={{
          fontFamily: 'var(--console-body)',
          fontSize: size === 'lg' ? 'var(--console-text-code-lg)' : 'var(--console-text-section)',
          fontWeight: 'var(--console-weight-strong)',
          lineHeight: size === 'lg' ? '1.2' : 'var(--console-leading-tight)',
          color: identity.unavailable ? 'var(--console-ink-dim)' : 'var(--console-ink)',
        }}
      >
        {identity.primary}
      </div>
      {identity.secondary ? (
        <div
          className="console-v2-code"
          style={{
            fontFamily: 'var(--console-body)',
            fontSize: 'var(--console-text-sm)',
            fontWeight: 'var(--console-weight-strong)',
            lineHeight: 'var(--console-leading-control)',
            color: 'var(--console-ink-secondary)',
          }}
        >
          {formatSecondaryBin(identity.secondary)}
        </div>
      ) : null}
      {identity.noSticker && !identity.unavailable ? (
        <div
          style={{
            marginTop: 'var(--console-space-1)',
            fontSize: 'var(--console-text-xs)',
            fontWeight: 'var(--console-weight-label)',
            color: 'var(--console-warning)',
            letterSpacing: 'var(--console-tracking-label)',
            textTransform: 'uppercase',
          }}
        >
          No sticker
        </div>
      ) : null}
    </div>
  );
}
