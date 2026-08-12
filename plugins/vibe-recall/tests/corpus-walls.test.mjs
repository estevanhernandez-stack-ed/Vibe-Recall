import { enumerateLocal } from '../engine/corpus.mjs';
import { makeEstate, cleanEstate } from './fixture-estate.mjs';

let estateRoot;
let config;

beforeAll(() => {
  estateRoot = makeEstate();
  config = { estateRoot, walls: ['Acme'], exclude: [] };
});

afterAll(() => {
  cleanEstate(estateRoot);
});

test('builds a non-empty fixture estate', () => {
  const results = enumerateLocal(config);
  expect(results.length).toBeGreaterThan(0);
  const names = results.map(r => r.name).sort();
  expect(names).toContain('GoodApp');
  expect(names).toContain('OtherApp');
});

test('finds the ordinary repos', () => {
  const names = enumerateLocal(config).map(r => r.name).sort();
  expect(names).toEqual(['GoodApp', 'OtherApp']);
});

test('a walled repo never appears, at any depth', () => {
  const results = enumerateLocal(config);
  expect(results.length).toBeGreaterThan(0);
  const all = JSON.stringify(results);
  expect(all).not.toMatch(/Acme/);
  expect(all).not.toMatch(/SecretWork/);
});

test('underscore-prefixed directories are excluded', () => {
  const results = enumerateLocal(config);
  expect(results.length).toBeGreaterThan(0);
  expect(results.some(r => r.name === 'Junk')).toBe(false);
});

test('repos with no remote have remoteReadFailed: false', () => {
  const results = enumerateLocal(config);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(r => r.remoteReadFailed === false)).toBe(true);
  expect(results.every(r => r.remote === null)).toBe(true);
});

test('wall comparison is case-insensitive: lowercase acme', () => {
  const configLower = { estateRoot, walls: ['acme'], exclude: [] };
  const results = enumerateLocal(configLower);
  expect(results.length).toBeGreaterThan(0);
  expect(results.map(r => r.name)).toContain('GoodApp');
  const all = JSON.stringify(results);
  expect(all).not.toMatch(/Acme/);
  expect(all).not.toMatch(/SecretWork/);
});

test('wall comparison is case-insensitive: uppercase ACME', () => {
  const configUpper = { estateRoot, walls: ['ACME'], exclude: [] };
  const results = enumerateLocal(configUpper);
  expect(results.length).toBeGreaterThan(0);
  expect(results.map(r => r.name)).toContain('GoodApp');
  const all = JSON.stringify(results);
  expect(all).not.toMatch(/Acme/);
  expect(all).not.toMatch(/SecretWork/);
});

test('wall comparison is case-insensitive: mixed case AcMe', () => {
  const configMixed = { estateRoot, walls: ['AcMe'], exclude: [] };
  const results = enumerateLocal(configMixed);
  expect(results.length).toBeGreaterThan(0);
  expect(results.map(r => r.name)).toContain('GoodApp');
  const all = JSON.stringify(results);
  expect(all).not.toMatch(/Acme/);
  expect(all).not.toMatch(/SecretWork/);
});
