// Inquiry form configuration: admin Settings (D1, secrets sealed) take precedence over wrangler vars/secrets.
import { unseal } from './crypto.js';
import { getSettings } from './settings.js';

const placeholder = v => !v || /^REPLACE_/.test(v);

export async function inquiryConfig(env, s) {
  s = s || await getSettings(env);
  const open = async v => { try { return v ? await unseal(env, v) : ''; } catch { return ''; } };
  const siteKey = s.turnstile_site_key || (placeholder(env.TURNSTILE_SITE_KEY) ? '' : env.TURNSTILE_SITE_KEY);
  return {
    siteKey,
    turnstileSecret: (await open(s.turnstile_secret)) || env.TURNSTILE_SECRET || '',
    resendKey: (await open(s.resend_api_key)) || env.RESEND_API_KEY || '',
    to: s.inquiry_to || (placeholder(env.INQUIRY_TO) ? '' : env.INQUIRY_TO),
    from: s.inquiry_from || env.INQUIRY_FROM || 'tonyshi.photos <no-reply@tonyshi.photos>',
  };
}

// "Ana Smith via tonyshi.photos <no-reply@tonyshi.photos>": the visitor's name in the sender line, but always our
// verified address (sending *as* their address would be refused by Resend and fail Gmail's spoofing checks).
export function fromVisitor(cfg, name) {
  const addr = (/<([^>]+)>/.exec(cfg.from) || [, cfg.from])[1].trim();
  const clean = String(name || '').replace(/[<>"\\\r\n,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean ? `"${clean} via tonyshi.photos" <${addr}>` : cfg.from;
}

export async function sendEmail(cfg, { subject, text, replyTo, from }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: from || cfg.from, to: [cfg.to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  const body = await res.text();
  if (!res.ok) {
    let msg = body; try { msg = JSON.parse(body).message || body; } catch {}
    throw new Error(`Resend ${res.status}: ${msg}`);
  }
  return JSON.parse(body);
}
