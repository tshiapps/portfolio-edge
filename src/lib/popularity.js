// Flickr popularity score, tunable from Admin → Popularity.
//
//   score = (F × faves + V × views/100 + C × comments) ÷ (1 + years since upload) ^ D
//
// F, V, C weigh the three signals (comments default low — they attract spam); views are counted per 100
// so the numbers stay comparable. D is the time discount: older uploads have had longer to collect
// views and faves, so dividing by age^D compares photos on an even footing. D = 0 means no discount,
// D = 1 roughly means "per year". Age is from the Flickr upload date, when the counting started.
import { chunk, now } from './util.js';
import { setSetting } from './settings.js';

export const YEAR = 365.25 * 86400;

export function weights(s) {
  const n = (v, d) => (Number.isFinite(+v) ? +v : d);
  return { F: n(s.pop_faves, 3), V: n(s.pop_views, 2), C: n(s.pop_comments, 0.5), D: n(s.pop_decay, 0.7) };
}

export function score(p, w, t = now()) {
  const age = Math.max(0, (t - (p.date_upload || t)) / YEAR);
  const raw = w.F * (p.faves || 0) + w.V * (p.views || 0) / 100 + w.C * (p.comments || 0);
  return raw / Math.pow(1 + age, w.D);
}

// Full re-score (weights changed, or periodic refresh as counts and ages move). With onlyMissing, just
// scores photos that don't have one yet — cheap enough to run every sync tick during an import.
export async function recomputePopularity(env, s, { onlyMissing = false } = {}) {
  const w = weights(s);
  const t = now();
  const { results } = await env.DB.prepare(onlyMissing
    ? "SELECT id, faves, views, comments, date_upload FROM photos WHERE status != 'deleted' AND pop_score IS NULL LIMIT 2000"
    : "SELECT id, faves, views, comments, date_upload FROM photos WHERE status != 'deleted'"
  ).all();
  const stmts = results.map(p => env.DB.prepare('UPDATE photos SET pop_score = ?2 WHERE id = ?1')
    .bind(p.id, Math.round(score(p, w, t) * 1000) / 1000));
  for (const part of chunk(stmts, 100)) await env.DB.batch(part);
  if (!onlyMissing) await setSetting(env, 'pop_computed_at', t);
  return results.length;
}
