// CommonJS on purpose: the project's package.json has no "type":"module" (the
// .js test harnesses use require()), so a `.js` PostCSS config with ESM
// `export default` makes Node emit MODULE_TYPELESS_PACKAGE_JSON while it guesses
// the module system. A `.cjs` file is unambiguous and silences that warning.
// Vite/postcss-load-config resolves .cjs configs natively.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
