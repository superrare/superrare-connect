import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const argumentsSchema = z.object({
  'sdk-bundle': z.string().min(1).optional(),
  port: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).default(5174),
});
const { values } = parseArgs({
  options: {
    'sdk-bundle': { type: 'string' },
    port: { type: 'string' },
  },
});
const configuration = argumentsSchema.parse(values);
const directory = fileURLToPath(new URL('.', import.meta.url));
const sdkBundle = configuration['sdk-bundle'] === undefined
  ? resolve(directory, '../../dist/superrare-connect.global.js')
  : resolve(configuration['sdk-bundle']);
// Fail before listening if the repository default or explicitly selected SDK artifact is absent.
await readFile(sdkBundle);
const targetEngine = resolve(directory, '../../dist/target-game/target-engine.js');
await readFile(targetEngine);

const files: Record<string, { path: string; contentType: string }> = {
  '/examples/target-game/': { path: resolve(directory, 'index.html'), contentType: 'text/html; charset=utf-8' },
  '/examples/target-game/index.html': { path: resolve(directory, 'index.html'), contentType: 'text/html; charset=utf-8' },
  '/examples/target-game/main.js': { path: resolve(directory, 'main.js'), contentType: 'text/javascript; charset=utf-8' },
  '/examples/target-game/credits.js': { path: resolve(directory, 'credits.js'), contentType: 'text/javascript; charset=utf-8' },
  '/examples/target-game/round.js': { path: resolve(directory, 'round.js'), contentType: 'text/javascript; charset=utf-8' },
  '/examples/target-game/target-engine.js': { path: targetEngine, contentType: 'text/javascript; charset=utf-8' },
  '/examples/target-game/hosted-flow.js': { path: resolve(directory, 'hosted-flow.js'), contentType: 'text/javascript; charset=utf-8' },
  '/examples/target-game/styles.css': { path: resolve(directory, 'styles.css'), contentType: 'text/css; charset=utf-8' },
  '/dist/superrare-connect.global.js': { path: sdkBundle, contentType: 'text/javascript; charset=utf-8' },
};

const server = createServer((request, response): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    response.writeHead(400);
    response.end('Invalid URL');
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(302, { Location: `/examples/target-game/${url.search}` });
    response.end();
    return;
  }
  const file = files[url.pathname];
  if (file === undefined) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  void readFile(file.path).then((content): void => {
    response.writeHead(200, { 'Content-Type': file.contentType });
    response.end(request.method === 'HEAD' ? undefined : content);
  }).catch((): void => {
    response.writeHead(500);
    response.end('Required local artifact could not be read');
  });
});
server.listen(configuration.port, '127.0.0.1', (): void => {
  console.log(`Target game: http://localhost:${configuration.port}/examples/target-game/`);
  console.log(`SDK artifact: ${sdkBundle}`);
});
