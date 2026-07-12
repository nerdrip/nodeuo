// Compatibility module retained so external imports do not break. The
// canonical faction command is registered by `sigils.js` as `[sigils` with
// the hidden `[sigil` alias; keeping a second owner made load order decide
// which implementation won.
export default function register() {
  return () => {};
}
