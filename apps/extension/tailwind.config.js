export default {
  content: [
    './popup.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f8fafc',
          100: '#f1f5f9',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          900: '#0f172a',
        }
      }
    },
  },
  plugins: [],
}
