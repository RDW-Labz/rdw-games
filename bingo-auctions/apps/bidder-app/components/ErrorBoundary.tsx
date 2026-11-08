// ErrorBoundary — last-resort safety net so a render-time exception
// inside a screen produces a visible fallback UI instead of a silent
// crash to home screen.
//
// Why this file exists:
//   2026-05-24 — TestFlight bidder iOS build is insta-crashing on three
//   different taps with no logs (Sentry was removed earlier today after
//   IT caused its own crashes — see auction_platform_ios26_launch_crash.md).
//   Without a boundary, a runtime exception in a React subtree unwinds
//   all the way up, expo-router catches it but iOS terminates the JS
//   bundle, and the user sees the app close. With a boundary, the
//   exception is trapped at the wrapper level and we render a screen
//   with the error.message in a copyable TextInput, so the user can
//   read the message out loud or screenshot it and we finally see
//   what's blowing up.
//
// Class component is required — React's error boundary API only fires
// componentDidCatch / getDerivedStateFromError on class components.
// Functional components can't catch render errors (they're called as
// pure functions; a throw inside their render unwinds past them).
//
// Design tokens match the rest of the bidder app:
//   bg     colors.bg (packages/design-system/src/theme.ts)
//   text   #e8eaf0  (TEXT_PRIMARY)
//   muted  #8a93a6  (TEXT_MUTED)
//   accent #5FE065  (BRANDED_BUTTON_GREEN — same brand-green CTA used
//                   across HomeHero / SectionBanner / BrandedButton)
//
// Logging: we console.error so anyone running `npx react-native log-ios`
// or attached to Console.app sees the failure surface. No telemetry
// dependency — Sentry was removed and re-adding it here would re-open
// the iOS 26 onHeaderHeightChange crash that prompted its removal.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { colors } from '@auction-platform/design-system';

const SCREEN_BG = colors.bg;
const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
const BRAND_GREEN = '#5FE065';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional override for the Reload button. When omitted the button
   * resets internal state AND calls router.replace('/') so the user
   * lands on a known-good screen instead of re-mounting the broken one.
   */
  onReset?: () => void;
  /**
   * Optional label shown above the error message. Useful when the same
   * boundary wraps multiple distinct screens — pass the screen name so
   * the user knows which screen blew up when they read the message.
   */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

const INITIAL_STATE: ErrorBoundaryState = {
  error: null,
  componentStack: null,
};

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = INITIAL_STATE;
  }

  // React calls this synchronously during render. Returning a state
  // object swaps the subtree out for our fallback before paint.
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  // Followup call once React has assembled the component stack. We log
  // here so the message + stack land in the device console — anyone
  // tailing `npx react-native log-ios` (or Xcode's Console) will see it.
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error is the boundary's whole point — it's the ONE place
    // in the bidder app where we deliberately keep a console call.
    // eslint-disable-next-line no-console
    console.error(
      '[ErrorBoundary] caught render error:',
      error.message,
      info.componentStack,
    );
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleReload = (): void => {
    // Clear internal state so the subtree re-renders fresh if the
    // caller's onReset triggers a remount.
    this.setState(INITIAL_STATE);
    if (this.props.onReset) {
      this.props.onReset();
      return;
    }
    // Fallback: bounce to root so the user lands somewhere known-good.
    router.replace('/');
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error == null) return this.props.children;

    // Render the fallback UI. ScrollView guarantees the error text is
    // readable even on small phones where the message + stack overflow
    // the viewport.
    const message = error.message || 'Unknown error';
    const stackText = componentStack ?? '';

    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.card}>
          <Text style={styles.title}>Something went wrong</Text>
          {this.props.label != null && (
            <Text style={styles.label}>{this.props.label}</Text>
          )}
          <Text style={styles.body}>
            The screen ran into an error and could not render. Tap Reload to
            return to the home screen. If this keeps happening, copy the
            message below and send it to support.
          </Text>

          <Text style={styles.hint}>Error message</Text>
          {/* Read-only TextInput so the user can tap-and-hold to copy the
              full message text. A plain Text node can't be selected on
              iOS without selectable=true, and even then the copy
              experience is worse than a TextInput. */}
          <TextInput
            value={message}
            editable={false}
            multiline
            selectTextOnFocus
            style={styles.errorInput}
          />

          {stackText.length > 0 && (
            <>
              <Text style={styles.hint}>Component stack</Text>
              <TextInput
                value={stackText.trim()}
                editable={false}
                multiline
                selectTextOnFocus
                style={[styles.errorInput, styles.stackInput]}
              />
            </>
          )}

          <Pressable
            onPress={this.handleReload}
            style={({ pressed }) => [
              styles.reloadButton,
              pressed && styles.reloadPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Reload"
          >
            <Text style={styles.reloadText}>Reload</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: SCREEN_BG,
  },
  scrollContent: {
    padding: 16,
    paddingTop: 48,
    paddingBottom: 48,
  },
  card: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    padding: 20,
    gap: 12,
  },
  title: {
    color: TEXT_PRIMARY,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  label: {
    color: BRAND_GREEN,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  body: {
    color: TEXT_MUTED,
    fontSize: 14,
    lineHeight: 20,
  },
  hint: {
    color: TEXT_MUTED,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  errorInput: {
    color: TEXT_PRIMARY,
    backgroundColor: SCREEN_BG,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    fontFamily: 'Menlo',
    minHeight: 60,
    textAlignVertical: 'top',
  },
  stackInput: {
    minHeight: 120,
    fontSize: 11,
  },
  reloadButton: {
    marginTop: 8,
    backgroundColor: BRAND_GREEN,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  reloadPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  reloadText: {
    color: '#0a0c11',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
});
