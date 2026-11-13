#!/usr/bin/env node
// Prints the UDID of an available iPhone simulator on the newest iOS runtime.
// Used by CI (and handy locally) to run XCTest without hard-coding a device:
//   xcodebuild test ... -destination "id=$(node scripts/ios-simulator-udid.js)"
const { execFileSync } = require('node:child_process');

const { devices } = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
        encoding: 'utf8',
    })
);

const version = (runtime) =>
    (runtime.match(/iOS-([\d-]+)$/)?.[1] ?? '0').split('-').map(Number);
const newerFirst = (a, b) => {
    const [va, vb] = [version(a), version(b)];
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const diff = (vb[i] ?? 0) - (va[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
};

for (const runtime of Object.keys(devices)
    .filter((r) => r.includes('SimRuntime.iOS-'))
    .sort(newerFirst)) {
    const iphone = devices[runtime].find((d) => d.name.startsWith('iPhone'));
    if (iphone) {
        console.log(iphone.udid);
        process.exit(0);
    }
}

console.error('No available iPhone simulator found');
process.exit(1);
