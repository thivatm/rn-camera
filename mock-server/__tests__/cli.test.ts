/**
 * @jest-environment node
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const CLI = path.join(__dirname, '..', 'cli.mjs');

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
});

function request(method: string, url: string, headers = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('CLI starts on the given port and prints its base URL', async () => {
  child = spawn(process.execPath, [CLI, '--port', '0']);
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    child!.stdout!.on('data', (c) => {
      out += c;
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (m) resolve(m[1]!);
    });
    child!.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });

  const created = await request('POST', `${baseUrl}/__control/uploads`);
  expect(created.status).toBe(201);
  const { url } = JSON.parse(created.body);
  const reply = await request('PUT', url, {
    'Content-Range': 'bytes */*',
    'Content-Length': 0,
  });
  expect(reply.status).toBe(308);
});
