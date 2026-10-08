import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { existsSync } from '../config.ts';
import { listVaults } from '../vault.ts';
import { loadViewFiles } from '../server/views.ts';
import { TOOLS, type Tool, type Vault } from './tools.ts';

/**
 * `pj mcp`: the vault as an MCP server, over stdio.
 *
 * So the vault is usable from a client that cannot run `pj` — Claude Desktop, a
 * chat — and not only from a shell. The protocol is a handful of JSON-RPC
 * methods over newline-delimited stdio, so it is spoken here directly rather
 * than through an SDK: the whole of it is the `handle` switch below, and a
 * dependency would be most of this app's MCP surface for a few dozen lines.
 *
 * **Read-only, and that is the design rather than a first version's gap.** The
 * vault's rule is that nothing is written without its owner's approval; a tool
 * call is a model's decision, so no tool writes a note. `propose` is the bridge —
 * it prints the `pj` command and stops. See `tools.ts`.
 *
 * **The vault is named, never found.** `pj` resolves a vault from the
 * environment, the working directory or a lone registry entry, which is right
 * for a command that answers and exits. A server outlives the shell that started
 * it and is started by a client config nobody rereads, so `pj mcp` refuses to run
 * without `--vault`. A call may name another *registered* vault; a path is
 * refused there, since a read rebuilds `.projector/index.db` under whatever
 * folder it is pointed at.
 */

/**
 * Newest first. A client asking for one of these gets it back; anything else
 * gets the newest, which is what the protocol says a server does when it cannot
 * agree — the client decides whether to carry on.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Where a view or a note lives in resource space. */
const VIEW_URI = 'projector://view/';
const NOTE_URI = 'projector://note/';

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Response =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

/** A JSON-RPC failure — the request was malformed, not the tool unhappy. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function version(): string {
  // Read rather than written down, so it cannot fall behind; absent from a
  // compiled binary, which is no reason to refuse to start.
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** A tool's input as JSON Schema, with the `vault` parameter every tool takes. */
function inputSchema(tool: Tool): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      vault: {
        type: 'string',
        description: 'A registered vault name. Omit for the vault this server was started with.',
      },
    },
  };
}

function describeTool(tool: Tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema(tool),
    annotations: {
      title: tool.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: tool.openWorld ?? false,
    },
  };
}

/** The vault a call names, from the registry only — see the file comment. */
function vaultFor(given: unknown, home: Vault): Vault {
  if (given === undefined || given === null || given === '') return home;
  if (typeof given !== 'string') throw new Error('vault is a registered vault name');
  const registered = listVaults().filter((v) => v.exists);
  const hit = registered.find((v) => v.name === given);
  if (!hit) {
    throw new Error(
      `"${given}" is not a registered vault` +
        (registered.length ? `. Registered: ${registered.map((v) => v.name).join(', ')}` : ''),
    );
  }
  return { root: hit.path, name: hit.name };
}

function text(body: string, isError = false) {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

/**
 * A request in, a response out — or nothing, for a notification.
 *
 * Separate from the transport so the tests drive it without a pipe, and so
 * the stdio loop below is only framing.
 */
export function createHandler(home: Vault): (msg: Request) => Promise<Response | null> {
  // The views are read off the vault rather than named here: which questions a
  // vault saves is that vault's own vocabulary, the same as its facets.
  const saved = loadViewFiles(home.root)
    .filter(({ spec }) => !spec.unlisted)
    .map(({ name, spec }) => `${name} (${spec.title ?? name})`);
  const instructions =
    `Read-only access to the projector vault "${home.name ?? home.root}": markdown notes, each carrying facets. ` +
    (saved.length ? `Its saved views — the questions its owner asks it — are ${saved.join(', ')}; ls answers any of them. ` : '') +
    `search finds a note and context tells everything about one. ` +
    `No tool writes: propose drafts a pj command for the owner to run, and a change is not made until they do.`;

  async function call(params: Record<string, unknown>) {
    const name = params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new RpcError(-32602, `unknown tool "${String(name)}"`);
    const { vault, ...args } = (params.arguments ?? {}) as Record<string, unknown>;
    // A tool that fails says so in its result, where the model can read it and
    // try again — a JSON-RPC error is for a request the server could not parse.
    try {
      return text(await tool.run(args, vaultFor(vault, home)));
    } catch (err) {
      return text(err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message, true);
    }
  }

  function resources() {
    return loadViewFiles(home.root).map(({ name, spec }) => ({
      uri: VIEW_URI + encodeURIComponent(name),
      name,
      title: spec.title ?? name,
      description: `The saved view "${name}", listed as \`pj ls --view ${name}\` prints it`,
      mimeType: 'text/plain',
    }));
  }

  async function read(uri: string) {
    const [tool, args] = uri.startsWith(VIEW_URI)
      ? ['ls', { view: decodeURIComponent(uri.slice(VIEW_URI.length)) }]
      : uri.startsWith(NOTE_URI)
        ? ['context', { id: decodeURIComponent(uri.slice(NOTE_URI.length)) }]
        : [null, null];
    if (!tool) throw new RpcError(-32602, `unknown resource ${uri}`);
    let body: string;
    try {
      body = await TOOLS.find((t) => t.name === tool)!.run(args!, home);
    } catch (err) {
      // A resource has no error flag to carry a tool's refusal, so it is one.
      throw new RpcError(-32002, (err as Error).message);
    }
    return { contents: [{ uri, mimeType: 'text/plain', text: body }] };
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: { name: 'projector', title: 'Projector', version: version() },
          instructions,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS.map(describeTool) };
      case 'tools/call':
        return call(params);
      case 'resources/list':
        return { resources: resources() };
      case 'resources/templates/list':
        return {
          resourceTemplates: [
            {
              uriTemplate: `${NOTE_URI}{id}`,
              name: 'note',
              title: 'Note context',
              description: 'Everything known about one note, as `pj context <id>` prints it',
              mimeType: 'text/plain',
            },
          ],
        };
      case 'resources/read':
        return read(String(params.uri ?? ''));
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  return async (msg) => {
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') {
      return isRequest ? { jsonrpc: '2.0', id: msg.id!, error: { code: -32600, message: 'invalid request' } } : null;
    }
    // Notifications — `initialized`, `cancelled` — want no answer, and a request
    // here is never slow enough for a cancellation to have anything to stop.
    if (!isRequest) return null;
    try {
      return { jsonrpc: '2.0', id: msg.id!, result: await dispatch(msg.method, msg.params ?? {}) };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      return { jsonrpc: '2.0', id: msg.id!, error: { code, message: (err as Error).message } };
    }
  };
}

/**
 * Serve `root` on stdin/stdout until stdin closes.
 *
 * Requests are answered one at a time, in order. The index memo hands out a
 * database handle that must be read without suspending in between (see
 * `index/cache.ts`), and a person's chat is not a workload that needs more.
 */
export async function serveMcp(root: string): Promise<void> {
  if (!existsSync(root)) throw new Error(`no vault at ${root}`);
  const home: Vault = { root, name: listVaults().find((v) => v.path === root)?.name ?? null };
  const handle = createHandler(home);

  // stdout *is* the protocol, so nothing else may print there. Library code
  // logs through `console` in a few places; those lines go to stderr, which a
  // client shows as the server's log, instead of corrupting the next message.
  console.log = console.info = console.debug = console.error;

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  let queue = Promise.resolve();
  let buffered = '';

  const take = (line: string) => {
    if (!line.trim()) return;
    let parsed: Request | Request[];
    try {
      parsed = JSON.parse(line) as Request | Request[];
    } catch {
      // Through the queue, so it answers in the order the line arrived.
      queue = queue.then(() => void send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    queue = queue.then(async () => {
      // A batch is an array of requests answered by an array; an older client may send one.
      if (Array.isArray(parsed)) {
        const out: Response[] = [];
        for (const msg of parsed) {
          const r = await handle(msg);
          if (r) out.push(r);
        }
        if (out.length) send(out);
      } else {
        const out = await handle(parsed);
        if (out) send(out);
      }
    });
  };

  process.stdin.setEncoding('utf8');
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        take(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
      }
    });
    process.stdin.on('end', () => {
      take(buffered);
      void queue.then(resolve);
    });
  });
}
