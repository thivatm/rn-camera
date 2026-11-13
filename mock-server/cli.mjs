#!/usr/bin/env node
// Runs the mock resumable server on a port. Usage:
//   node mock-server/cli.mjs [--port 8787] [--host 127.0.0.1]
// Prints "listening on <baseUrl>" once ready. Requires Node >= 22.18
// (TypeScript type stripping) to load server.ts.
import { parseArgs } from 'node:util';
import { startMockResumableServer } from './server.ts';

const { values } = parseArgs({
    options: {
        port: { type: 'string', default: '8787' },
        host: { type: 'string', default: '127.0.0.1' },
    },
});

startMockResumableServer({
    port: Number(values.port),
    host: values.host,
}).then((server) => {
    console.log(`listening on ${server.url}`);
    const shutdown = () => server.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
});
