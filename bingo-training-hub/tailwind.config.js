/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  safelist: ['btn-primary', 'btn-cream', 'btn-orange', 'btn-ghost', 'btn-danger'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#eadfc9', line: '#d3c9b5', lineh: '#e3d9c3', deep: '#decfb2' },
        sheet: { DEFAULT: '#fdf8f0', 2: '#fef9f1', 3: '#f5efe6', nav: '#fffbf3' },
        ink: { DEFAULT: '#373737', strong: '#212121', 2: '#636363', 3: '#8b8b8b', 4: '#9a9393', rule: '#424242', dash: '#313131' },
        navy: { DEFAULT: '#283f7d', 2: '#365abd', 3: '#3b60c5', deep: '#1f3568' },
        cobalt: { DEFAULT: '#024cb8', deep: '#023689', soft: '#a8bdd3', tracing: '#c0c8d0' },
        stone: { DEFAULT: '#c1baae', 2: '#d2cbc0' },
        signal: { orange: '#ec633d', orange2: '#e05c3a', red: '#e76051', reject: '#d26866', magenta: '#e60076', moss: '#5a7d4a', ochre: '#c58b2a' },
      },
      fontFamily: {
        display: ['"Schibsted Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['"Schibsted Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
        hand: ['HandDigits', '"Architects Daughter"', 'cursive'],
      },
      borderRadius: { 2: '2px', 4: '4px' },
      letterSpacing: { tightish: '-0.02em', tighter2: '-0.03em', wide5: '0.05em' },
      transitionTimingFunction: {
        'joe-out': 'cubic-bezier(0.2, 0, 0.1, 1)',
        'joe-in': 'cubic-bezier(0.8, 0, 0.8, 0.5)',
        'joe-inout': 'cubic-bezier(0.333, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};
