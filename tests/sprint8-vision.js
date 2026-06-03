const assert = require('assert');
const S = require('../server.js');
let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log('✓', name);}catch(e){ fail++; console.log('✗', name, '—', e.message);} }

// validateBbox
t('validateBbox accepts valid box', () => {
  assert.deepStrictEqual(S.validateBbox([10, 20, 800, 900]), [10, 20, 800, 900]);
});
t('validateBbox rejects out-of-range', () => {
  assert.strictEqual(S.validateBbox([0, 0, 1001, 500]), null);
});
t('validateBbox rejects inverted (ymin>=ymax)', () => {
  assert.strictEqual(S.validateBbox([900, 0, 100, 500]), null);
});
t('validateBbox rejects non-array / wrong length', () => {
  assert.strictEqual(S.validateBbox([1,2,3]), null);
  assert.strictEqual(S.validateBbox('nope'), null);
  assert.strictEqual(S.validateBbox(null), null);
});

// detectVisualPages
t('detectVisualPages flags scanned (no text layer)', () => {
  const r = S.detectVisualPages([{page:1,hasTextLayer:false,hasImages:false}]);
  assert.deepStrictEqual(r, [1]);
});
t('detectVisualPages flags pages with images', () => {
  const r = S.detectVisualPages([{page:2,hasTextLayer:true,hasImages:true}]);
  assert.deepStrictEqual(r, [2]);
});
t('detectVisualPages skips clean text pages', () => {
  const r = S.detectVisualPages([{page:3,hasTextLayer:true,hasImages:false}]);
  assert.deepStrictEqual(r, []);
});
t('detectVisualPages handles missing/empty meta', () => {
  assert.deepStrictEqual(S.detectVisualPages(null), []);
  assert.deepStrictEqual(S.detectVisualPages([]), []);
});

t('step4_schema passes through valid bbox', () => {
  const out = S.step4_schema([{ t:'סדק', ds:'סדק בקיר', s:'high', p:'5', bbox:[10,10,500,500], area:'סלון' }]);
  assert.deepStrictEqual(out[0].bbox, [10,10,500,500]);
});
t('step4_schema nullifies invalid bbox', () => {
  const out = S.step4_schema([{ t:'סדק', ds:'x', s:'high', p:'5', bbox:[1,1,2000,2], area:'סלון' }]);
  assert.strictEqual(out[0].bbox, null);
});
t('step4_schema defaults bbox to null when absent', () => {
  const out = S.step4_schema([{ t:'סדק', ds:'x', s:'high', p:'5', area:'סלון' }]);
  assert.strictEqual(out[0].bbox, null);
});

console.log(`\n${pass}/${pass+fail} PASS`);
process.exit(fail ? 1 : 0);
