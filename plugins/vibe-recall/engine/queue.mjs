export function deepenQueue(cards) {
  return cards
    .filter(c => c.depth !== 'deep')
    .sort((a, b) =>
      (b.recallHits || 0) - (a.recallHits || 0) ||
      (b.lastCommit || 0) - (a.lastCommit || 0));
}
