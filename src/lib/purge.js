// Private photos (anything not public on Flickr — private, friends or family only) are not kept:
// sync skips them, and any already stored are removed with their files. If one is made public later,
// the next sync picks it up like a new photo.
import { chunk } from './util.js';

export async function purgePhotos(env, ids) {
  if (!ids.length) return 0;
  for (const part of chunk(ids, 100)) {
    const keys = part.flatMap(id => [`m/${id}.jpg`, `t/${id}.webp`, `s/${id}.webp`, `r/${id}.jpg`, `p/${id}.jpg`, `p/${id}.webp`, `p/${id}.r.jpg`]);
    await env.BUCKET.delete(keys);
    const sel = JSON.stringify(part), q = 'IN (SELECT value FROM json_each(?1))';
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photo_tags WHERE photo_id ${q}`).bind(sel),
      env.DB.prepare(`DELETE FROM album_photos WHERE photo_id ${q}`).bind(sel),
      env.DB.prepare(`DELETE FROM media_clips WHERE kind = 'photo' AND photo_id ${q}`).bind(sel),
      env.DB.prepare(`DELETE FROM photos WHERE id ${q}`).bind(sel),
    ]);
  }
  return ids.length;
}

// already-synced private photos: a batch per sync run until none are left
export async function purgePrivate(env, limit = 300) {
  const { results } = await env.DB.prepare('SELECT id FROM photos WHERE is_public = 0 LIMIT ?1').bind(limit).all();
  return purgePhotos(env, results.map(r => r.id));
}
