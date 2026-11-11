#!/usr/bin/env node
// Minimal backend for the example app: creates a Mux direct upload and replies
// { url }. Mux credentials stay here, never in the app.
//
//   MUX_TOKEN_ID=... MUX_TOKEN_SECRET=... node example/backend/mux-upload-url.mjs
//
// Then set UPLOAD_URL_BACKEND in example/src/config.ts to
// http://<this machine>:3000/uploads. Requires Node >= 22.
import { createServer } from 'node:http';

const { MUX_TOKEN_ID, MUX_TOKEN_SECRET, PORT = '3000' } = process.env;
if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
  console.error('Set MUX_TOKEN_ID and MUX_TOKEN_SECRET');
  process.exit(1);
}
const auth = Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString(
  'base64'
);

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/uploads') {
    res.writeHead(404).end();
    return;
  }
  try {
    const mux = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cors_origin: '*',
        // Must exceed the longest recording plus the time to upload what's
        // left after it stops (spec §5.3). Mux default: 3600 s.
        timeout: 4 * 3600,
        new_asset_settings: { playback_policy: ['public'] },
      }),
    });
    const body = await mux.json();
    if (!mux.ok)
      throw new Error(`Mux HTTP ${mux.status}: ${JSON.stringify(body)}`);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: body.data.url }));
  } catch (e) {
    console.error(e);
    res.writeHead(502).end();
  }
}).listen(Number(PORT), () => console.log(`listening on :${PORT}`));
