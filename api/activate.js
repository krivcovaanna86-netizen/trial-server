import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { hwid, license_key, app_id, fingerprint } = req.body || {};

  if (!hwid || !license_key) {
    return res.status(400).json({ error: 'HWID and license_key are required' });
  }

  const appId = app_id || 'default';

  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] || 'unknown';

    // Find the license key
    const { data: licenseData, error: findError } = await supabase
      .from('licenses')
      .select('*')
      .eq('license_key', license_key)
      .eq('app_id', appId)
      .maybeSingle();

    if (findError) throw findError;

    if (!licenseData) {
      return res.status(404).json({ error: 'Invalid license key', status: 'invalid_key' });
    }

    if (licenseData.status === 'banned') {
      return res.status(403).json({ error: 'This license key has been banned', status: 'banned' });
    }

    // Check if key is already activated with a different HWID
    if (licenseData.hwid && licenseData.hwid !== hwid) {
      return res.status(409).json({
        error: 'License key already activated on another device',
        status: 'already_activated',
      });
    }

    // Activate: bind HWID, set status = active, convert key → user (single record)
    const { error: updateError } = await supabase
      .from('licenses')
      .update({
        hwid,
        status: 'active',
        record_type: 'user',
        activated_at: new Date().toISOString(),
        last_check: new Date().toISOString(),
        ip_address: ip,
        fingerprint: fingerprint || null,
      })
      .eq('id', licenseData.id);

    if (updateError) throw updateError;

    return res.status(200).json({
      status: 'active',
      message: 'License activated successfully',
      activated_at: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Activation error:', error);
    return res.status(500).json({ error: error.message });
  }
}
