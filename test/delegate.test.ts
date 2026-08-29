import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { indexStamp, reindex } from '../src/index/indexer.ts';
import { delegatedIndex } from '../src/cli/delegate.ts';

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'projector-delegate-'));
  writeFileSync(join(root, 'one.md'), '# One\n\ndelegated body\n', 'utf8');
  return root;
}

/** A stub standing in for the server's /api/cli/stamp, on an ephemeral port. */
function stub(answer: (vaultHeader: string | undefined) => { status: number; body: unknown }): Promise<{
  server: Server;
  port: number;
  calls: () => number;
}> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    const { status, body } = answer(req.headers['x-projector-vault'] as string | undefined);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, calls: () => n });
    });
  });
}

test('a live server vouching the true stamp answers without a walk', async () => {
  const root = vault();
  reindex(root).db.close(); // persist the payload the delegation will hydrate
  const { stamp } = indexStamp(root);

  const { server, port } = await stub(() => ({ status: 200, body: { stamp } }));
  process.env.PROJECTOR_PORT = String(port);
  try {
    const res = await delegatedIndex(root);
    assert.ok(res, 'a matching stamp hydrates');
    assert.equal(res.cached, true);
    assert.equal(res.notes.get('one')?.title, 'One');
    assert.match(res.notes.get('one')?.body ?? '', /delegated body/, 'lazy bodies still parse');
    res.db.close();
  } finally {
    delete process.env.PROJECTOR_PORT;
    server.close();
  }
});

test('a stamp the payload was not built from falls back to the walk', async () => {
  const root = vault();
  reindex(root).db.close();

  const { server, port } = await stub(() => ({ status: 200, body: { stamp: 'v2:not:the:one:0' } }));
  process.env.PROJECTOR_PORT = String(port);
  try {
    assert.equal(await delegatedIndex(root), null, 'disagreement is a fallback, not an answer');
  } finally {
    delete process.env.PROJECTOR_PORT;
    server.close();
  }
});

test('no server, or delegation disabled, is a quiet null', async () => {
  const root = vault();
  reindex(root).db.close();

  // nothing listens here — the connection refusal must be swallowed
  process.env.PROJECTOR_PORT = '1'; // reserved port: nothing to talk to
  try {
    assert.equal(await delegatedIndex(root), null);
  } finally {
    delete process.env.PROJECTOR_PORT;
  }

  const { server, port, calls } = await stub(() => ({ status: 200, body: { stamp: 'irrelevant' } }));
  process.env.PROJECTOR_PORT = String(port);
  process.env.PROJECTOR_NO_DELEGATE = '1';
  try {
    assert.equal(await delegatedIndex(root), null);
    assert.equal(calls(), 0, 'disabled means the server is never asked');
  } finally {
    delete process.env.PROJECTOR_NO_DELEGATE;
    delete process.env.PROJECTOR_PORT;
    server.close();
  }
});
