// Test helper: read {"captures": [...], "collector_id": ..., "start_sequence": n} on stdin, print the
// ingest entries projection.js builds for them. Used by services/api/tests/test_cloud_extension_contract.py.
const P = require('../extensions/browser-cloud/projection.js');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const {captures, collector_id: collectorId, start_sequence: start = 1} = JSON.parse(input);
  const out = [];
  for (const [i, capture] of captures.entries()) {
    try {
      const envelope = await P.projectCapture(capture, {collectorId, collectorSequence: start + i});
      out.push({entry: await P.ingestEntry(envelope), canonical: P.canonicalJSON(envelope),
                capture_id: await P.sha256Hex(P.fingerprintText(capture))});
    } catch (error) {
      out.push({error: String(error.message || error)});
    }
  }
  process.stdout.write(JSON.stringify(out));
});
