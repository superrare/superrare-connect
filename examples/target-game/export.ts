import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';

const executeFile = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configurationSchema = z.object({
  appId: z.string().uuid(),
  groupId: z.string().uuid(),
  studioUrl: z.string().url(),
  apiUrl: z.string().url(),
  connectUrl: z.string().url(),
  appOrigin: z.string().url(),
  display: z.enum(['embed', 'popup']),
});

const scriptArguments = process.argv.slice(2);
const forwardedArguments = scriptArguments[0] === '--' ? scriptArguments.slice(1) : scriptArguments;
const options = parseArgs({
  args: forwardedArguments,
  options: {
    config: { type: 'string' },
    output: { type: 'string' },
    'sdk-bundle': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
  strict: true,
}).values;

function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function replaceOnce(source: string, search: string, replacement: string, label: string): string {
  const occurrences = source.split(search).length - 1;
  if (occurrences !== 1) throw new Error(`Expected exactly one ${label} reference; found ${occurrences}.`);
  return source.replace(search, replacement);
}

function assertHttpsOrigin(value: string, label: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS service origin without a path, credentials, query, or fragment.`);
  }
}


async function main(): Promise<void> {
  if (!options.config) throw new Error('Pass --config with your approved Studio app, credit group, services, origin, and display configuration.');

  const configPath = resolve(options.config);
  const outputPath = resolve(options.output ?? join(repositoryRoot, 'dist/target-game-static.zip'));
  const sdkBundlePath = resolve(options['sdk-bundle'] ?? join(repositoryRoot, 'dist/superrare-connect.global.js'));
  let outputExists = false;
  try {
    await access(outputPath);
    outputExists = true;
  } catch {
    outputExists = false;
  }
  if (outputExists && !options.force) {
    throw new Error(`Output already exists: ${outputPath}. Choose another path or pass --force to replace it.`);
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read JSON configuration at ${configPath}.`, { cause: error });
  }
  const configuration = configurationSchema.parse(parsedConfig);
  assertHttpsOrigin(configuration.studioUrl, 'studioUrl');
  assertHttpsOrigin(configuration.apiUrl, 'apiUrl');
  assertHttpsOrigin(configuration.connectUrl, 'connectUrl');
  const appOrigin = new URL(configuration.appOrigin);
  if (appOrigin.origin !== configuration.appOrigin || appOrigin.protocol !== 'https:' || appOrigin.username || appOrigin.password) {
    throw new Error('appOrigin must be the exact HTTPS origin approved for this Studio app.');
  }

  const gitResult = await executeFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
  const sdkCommit = gitResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sdkCommit)) throw new Error('Could not resolve the checked-out source commit.');

  const sdkBundle = await readFile(sdkBundlePath);
  const targetEngine = await readFile(join(repositoryRoot, 'dist/target-game/target-engine.js'), 'utf8');
  const serverVerifier = await readFile(join(repositoryRoot, 'dist/target-game/server-verifier.js'));
  if (serverVerifier.byteLength > 256_000) throw new Error('The server verifier exceeds the Studio 256 KB module limit.');
  const scoringConfiguration = await readFile(join(repositoryRoot, 'examples/target-game/scoring-config.json'));
  const sourcePaths = ['main.js', 'credits.js', 'hosted-flow.js', 'round.js', 'styles.css'] as const;
  const sourceFiles: Array<{ name: string; content: string }> = [
    ...await Promise.all(sourcePaths.map(async (name) => ({
      name,
      content: await readFile(join(repositoryRoot, 'examples/target-game', name), 'utf8'),
    }))),
    { name: 'target-engine.js', content: targetEngine },
  ];
  const sourceContent = new Map(sourceFiles.map(({ name, content }) => [name, content]));
  const stylesSource = sourceContent.get('styles.css');
  if (stylesSource === undefined) throw new Error('The target-game stylesheet is missing.');
  const assetHashes = new Map<string, string>([
    ['connect-sdk.js', contentHash(sdkBundle)],
    ['styles.css', contentHash(stylesSource)],
  ]);
  const packagedModuleContent = new Map<string, string>();
  const moduleOrder = ['target-engine.js', 'hosted-flow.js', 'round.js', 'credits.js', 'main.js'];
  for (const name of moduleOrder) {
    let moduleSource = sourceContent.get(name);
    if (moduleSource === undefined) throw new Error(`The target-game module ${name} is missing.`);
    for (const dependency of moduleOrder) {
      const reference = `'./${dependency}'`;
      if (!moduleSource.includes(reference)) continue;
      const dependencyHash = assetHashes.get(dependency);
      if (!dependencyHash) throw new Error(`Module ${name} depends on ${dependency} before its content hash is available.`);
      moduleSource = replaceOnce(
        moduleSource,
        reference,
        `'./${dependency}?v=${dependencyHash}'`,
        `${dependency} module`,
      );
    }
    packagedModuleContent.set(name, moduleSource);
    assetHashes.set(name, contentHash(moduleSource));
  }
  const packagedSources = sourceFiles.map(({ name, content }) => ({
    name,
    content: packagedModuleContent.get(name) ?? content,
  }));

  let index = await readFile(join(repositoryRoot, 'examples/target-game/index.html'), 'utf8');
  index = replaceOnce(index, 'href="./styles.css"', `href="./styles.css?v=${assetHashes.get('styles.css')}"`, 'stylesheet');
  index = replaceOnce(index, 'src="../../dist/superrare-connect.global.js"', `src="./connect-sdk.js?v=${assetHashes.get('connect-sdk.js')}"`, 'SDK bundle');
  index = replaceOnce(index, 'src="./main.js"', `src="./main.js?v=${assetHashes.get('main.js')}"`, 'application module');
  index = replaceOnce(
    index,
    '<head>',
    `<head>\n    <meta name="play-factory-game-id" content="${configuration.appId}">\n    <link data-rare-app-metadata="true" rel="canonical" href="${configuration.appOrigin}/">`,
    'head element',
  );

  const packagedConfiguration = {
    ...configuration,
    sdkCommit,
  };
  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const stageDirectory = await mkdtemp(join(tmpdir(), 'target-game-export-'));
  let temporaryOutputDirectory: string | undefined;
  try {
    temporaryOutputDirectory = await mkdtemp(join(outputDirectory, '.target-game-export-'));
    const temporaryArchive = join(temporaryOutputDirectory, basename(outputPath));
    await writeFile(join(stageDirectory, 'index.html'), index);
    await writeFile(join(stageDirectory, 'config.json'), `${JSON.stringify(packagedConfiguration, null, 2)}\n`);
    await writeFile(join(stageDirectory, 'connect-sdk.js'), sdkBundle);
    await writeFile(join(stageDirectory, 'server-verifier.js'), serverVerifier);
    await writeFile(join(stageDirectory, 'scoring-config.json'), scoringConfiguration);
    for (const { name, content } of packagedSources) {
      await writeFile(join(stageDirectory, name), content);
    }

    const entries = ['index.html', 'config.json', 'connect-sdk.js', 'server-verifier.js', 'scoring-config.json', ...sourceFiles.map(({ name }) => name)];
    if (entries.length > 500) throw new Error('The static archive exceeds the Studio 500-file limit.');
    await executeFile('zip', ['-X', '-q', temporaryArchive, ...entries], { cwd: stageDirectory });
    const archiveEntries = (await executeFile('unzip', ['-Z1', temporaryArchive])).stdout.trim().split('\n');
    if (archiveEntries.length !== entries.length || archiveEntries.some((entry) => !entries.includes(entry))) {
      throw new Error('The generated archive does not contain the expected root static files.');
    }
    const archiveStats = await stat(temporaryArchive);
    if (archiveStats.size > 50_000_000) throw new Error('The static archive exceeds the Studio 50 MB limit.');
    await rename(temporaryArchive, outputPath);
    process.stdout.write(`Static target-game archive: ${outputPath}\n`);
    process.stdout.write(`SDK source commit: ${sdkCommit}\n`);
    process.stdout.write(`Archive SHA-256: ${contentHash(await readFile(outputPath))}\n`);
    process.stdout.write(`Archive size: ${archiveStats.size} bytes; root files: ${entries.length}\n`);
  } finally {
    const cleanup = [rm(stageDirectory, { recursive: true, force: true })];
    if (temporaryOutputDirectory) cleanup.push(rm(temporaryOutputDirectory, { recursive: true, force: true }));
    await Promise.all(cleanup);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Target-game export failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
