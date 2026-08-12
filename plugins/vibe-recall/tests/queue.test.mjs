import { deepenQueue } from '../engine/queue.mjs';

const c = (repo, depth, recallHits, lastCommit) =>
  ({ repo, depth, recallHits, lastCommit });

test('deep cards are not queued', () => {
  const q = deepenQueue([c('Done', 'deep', 99, 5), c('Todo', 'shallow', 1, 5)]);
  expect(q.map(x => x.repo)).toEqual(['Todo']);
});

test('most-recalled shallow card comes first', () => {
  const q = deepenQueue([c('Rare', 'shallow', 1, 5), c('Hot', 'shallow', 12, 5)]);
  expect(q.map(x => x.repo)).toEqual(['Hot', 'Rare']);
});

test('ties break on recency', () => {
  const q = deepenQueue([c('Old', 'shallow', 3, 1), c('New', 'shallow', 3, 9)]);
  expect(q.map(x => x.repo)).toEqual(['New', 'Old']);
});
