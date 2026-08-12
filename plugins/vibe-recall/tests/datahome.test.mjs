import { resolveDataHome } from '../engine/datahome.mjs';

test('tier 1 wins when CLAUDE_PLUGIN_DATA is set', () => {
  const r = resolveDataHome({ CLAUDE_PLUGIN_DATA: '/tmp/pd', HOME: '/home/e' });
  expect(r).toEqual({ dir: '/tmp/pd', tier: 1 });
});

test('falls back to the legacy family location', () => {
  const r = resolveDataHome({ HOME: '/home/e' });
  expect(r.tier).toBe(2);
  expect(r.dir).toBe('/home/e/.claude/plugins/data/vibe-recall');
});

test('fails loud when neither tier resolves', () => {
  expect(() => resolveDataHome({})).toThrow(/no writable data home/);
});

test('normalizes backslash USERPROFILE when HOME is unset', () => {
  const r = resolveDataHome({ USERPROFILE: 'C:\\Users\\testuser' });
  expect(r.tier).toBe(2);
  expect(r.dir).toBe('C:/Users/testuser/.claude/plugins/data/vibe-recall');
});

test('normalizes backslash HOME with trailing separator', () => {
  const r = resolveDataHome({ HOME: 'C:\\Users\\testuser\\' });
  expect(r.tier).toBe(2);
  expect(r.dir).toBe('C:/Users/testuser/.claude/plugins/data/vibe-recall');
});

test('HOME wins over USERPROFILE when both are present', () => {
  const r = resolveDataHome({
    HOME: '/home/explicit',
    USERPROFILE: 'C:\\Users\\ignored'
  });
  expect(r.tier).toBe(2);
  expect(r.dir).toBe('/home/explicit/.claude/plugins/data/vibe-recall');
});

// --- Fix round 3: the UNC guard belongs here, not downstream ---------------
//
// A prior fix round put the UNC check in store.mjs, testing the *output* of
// resolveDataHome. That worked for tier 1 (CLAUDE_PLUGIN_DATA passes through
// this function unchanged) but not tier 2: the path.posix.join above already
// collapses a UNC path's doubled leading slash before returning `dir`, so a
// downstream check can never see the original signal for a UNC-rooted
// HOME/USERPROFILE -- and roaming-profile/redirected-home Windows
// environments put UNC paths in exactly those variables as a matter of
// course. The guard now lives here, applied to the raw input before any
// transformation, so every caller (store.mjs, and anything else that calls
// resolveDataHome) inherits it for free.

test('a UNC-style CLAUDE_PLUGIN_DATA (tier 1) is refused, naming CLAUDE_PLUGIN_DATA specifically', () => {
  expect(() => resolveDataHome({ CLAUDE_PLUGIN_DATA: '\\\\fileserver\\share\\vibe-data' }))
    .toThrow(/vibe-recall.*CLAUDE_PLUGIN_DATA.*UNC/i);
});

test('a UNC-style USERPROFILE (tier 2, HOME unset) is refused, naming USERPROFILE -- not a generic "home directory"', () => {
  expect(() => resolveDataHome({ USERPROFILE: '\\\\fileserver\\share\\vibe-data' }))
    .toThrow(/vibe-recall.*USERPROFILE.*UNC/i);
});

test('a UNC-style HOME (tier 2) is refused, naming HOME specifically', () => {
  expect(() => resolveDataHome({ HOME: '\\\\fileserver\\share\\vibe-data' }))
    .toThrow(/vibe-recall.*HOME.*UNC/i);
});

test('when both HOME and USERPROFILE are set and HOME is the UNC one, the error names HOME (the variable that actually won), not USERPROFILE', () => {
  expect(() => resolveDataHome({
    HOME: '\\\\fileserver\\share\\vibe-data',
    USERPROFILE: 'C:\\Users\\ignored'
  })).toThrow(/vibe-recall.*HOME.*UNC/i);
});

test('a forward-slash-form UNC HOME (//server/share/...) is refused the same way', () => {
  expect(() => resolveDataHome({ HOME: '//fileserver/share/vibe-data' }))
    .toThrow(/vibe-recall.*HOME.*UNC/i);
});

test('ordinary local paths on both tiers still resolve exactly as before -- the UNC check does not false-positive', () => {
  const t1 = resolveDataHome({ CLAUDE_PLUGIN_DATA: '/tmp/pd', HOME: '/home/e' });
  expect(t1).toEqual({ dir: '/tmp/pd', tier: 1 });
  const t2 = resolveDataHome({ HOME: 'C:\\Users\\testuser' });
  expect(t2.tier).toBe(2);
  expect(t2.dir).toBe('C:/Users/testuser/.claude/plugins/data/vibe-recall');
});
