// Ranking compatibility API is kept in its own module so the active history
// endpoint does not couple its source to the archived 100k-row implementation.
export { loadRanking } from './history-legacy.mjs';
