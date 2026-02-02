import { Actor, log } from 'apify';
import { ActorSourceType } from 'apify-client';
import { type ActorRunRequest, Orchestrator } from 'apify-orchestrator';

import { fetchManifest } from '@apify/actor-templates';

import { downloadZipTemplate } from './download-template.js';

interface Input {
    dependenciesJson: Record<string, string>;
    memoryConfigs: string[];
    bundleWithNcc: boolean;
    iterationsPerConfig: number;
    // Mark which dependencies should be imported dynamically at runtime with await import()
    dynamicDependencies?: string[];
}

await Actor.init();

// Create a new Actor using packages and importing them at start to measure startup latency
const { dependenciesJson, memoryConfigs, bundleWithNcc, iterationsPerConfig, dynamicDependencies } = (await Actor.getInput<Input>())!;

const state = await Actor.useState<{ actorId?: string, versionNumber?: string, buildNumber?: string }>()

console.dir(state)

if (!state.actorId) {
    // Give Actor random name so different runs don't clash
    const actorName = Math.random().toString(16).substring(2, 10)
    const { id } = await Actor.apifyClient.actors().create({
        name: `temp-startup-latency-${actorName}`
    });

    log.info(`Created temporary Actor with ID ${id} to test startup latency`);

    state.actorId = id;
}

// Fetch latest cheerio template as a base for our test Actor
const manifest = await fetchManifest();
const template = manifest.templates.find((temp) => temp.id === 'ts-crawlee-cheerio');

if (!template) {
    throw new Error('ts-crawlee-cheerio template not found in templates. This Actor must be updated.');
}

if (!state.versionNumber) {
    const fileMap = await downloadZipTemplate(template.archiveUrl);

    const packageJson = JSON.parse(fileMap['package.json']);
    packageJson.dependencies = dependenciesJson;
    if (bundleWithNcc) {
        packageJson.devDependencies = packageJson.devDependencies || {};
        packageJson.devDependencies['@vercel/ncc'] = '0.38.4';
        packageJson.scripts = packageJson.scripts || {};
        packageJson.scripts.build = 'ncc build src/main.ts -m -o dist';

        fileMap.Dockerfile = fileMap.Dockerfile!.replace('dist/main.js', 'dist/index.js');
    }

    fileMap['package.json'] = JSON.stringify(packageJson, null, 2);

    fileMap['src/main.ts'] = `${Object.keys(dependenciesJson).filter((pkg) => !dynamicDependencies?.includes(pkg)).map((pkg) => `import '${pkg}';`).join('\n')
         }\n` + `import { performance } from "perf_hooks";\n`
        + `console.log("startup:", performance.now());\n`
    
    if (dynamicDependencies && dynamicDependencies.length > 0) {
        fileMap['src/main.ts'] += `${dynamicDependencies.map((pkg) => `await import('${pkg}');`).join('\n    ')};\n`;
        fileMap['src/main.ts'] += `console.log("dynamic imports done:", performance.now());\n`;
    }

    const sourceFiles = Object.entries(fileMap).map(([path, content]) => ({ name: path, content, format: 'TEXT' as const }));

    const version = await Actor.apifyClient.actor(state.actorId!).version('0.0').update({
        sourceType: ActorSourceType.SourceFiles,
        sourceFiles,
    })

    state.versionNumber = version.versionNumber;

    log.info(`Created Actor version ${state.versionNumber} for Actor ID ${state.actorId}`);
}

if (!state.buildNumber) {
    log.info(`Starting build for Actor ID ${state.actorId} version ${state.versionNumber}...`);
    const build = await Actor.apifyClient.actor(state.actorId!).build(state.versionNumber!);
    await Actor.apifyClient.build(build.id).waitForFinish();

    state.buildNumber = build.buildNumber;

    log.info(`Finished build ${state.buildNumber} for Actor ID ${state.actorId} version ${state.versionNumber}`);
}

const orchestrator = new Orchestrator({
    enableLogs: true,
    persistenceSupport: 'kvs',
    persistencePrefix: 'ORCHESTRATOR-',
    abortAllRunsOnGracefulAbort: true,
    retryOnInsufficientResources: true,
});

const client = await orchestrator.apifyClient({ name: 'MY-CLIENT' });

// Run each memory configuration 50 times to get mean, median, min, max startup latencies
for (const memoryMbs of memoryConfigs) {
    log.info(`Running batch of Actors with ${memoryMbs} MB memory...`);
    // These are special objects for orchestrator, assigns a name to each run
    const runRequests: ActorRunRequest[] = [...Array(iterationsPerConfig).keys()].map((i) => ({
        runName: `mem-${memoryMbs}-run-${i + 1}`,
        input: {},
        options: {
            memory: Number(memoryMbs),
        },
    }));
    const runsRecord = await client.actor(state.actorId!).callRuns(...runRequests);
    log.info(`Batch of Actors with ${memoryMbs} MB memory finished.`);

    const runs = Object.values(runsRecord);

    const startupTimes: number[] = [];
    const dynamicImportTimes: number[] = [];
    for (const run of runs) {
        const runLog = await Actor.apifyClient.run(run.id).log().get()
        const startupLog = runLog?.split('\n').find((line) => line.includes('startup:'));
        if (!startupLog) throw new Error(`Startup log not found in run ${run.id}`);
        const match = startupLog.match(/startup:\s*(\d+(\.\d+)?)/);
        if (!match) throw new Error(`Startup time not found in log line: ${startupLog}`);
        startupTimes.push(Number(match[1]));

        const dynamicImportLog = runLog?.split('\n').find((line) => line.includes('dynamic imports done:'));
        if (dynamicImportLog) {
            const dynamicMatch = dynamicImportLog.match(/dynamic imports done:\s*(\d+(\.\d+)?)/);
            if (dynamicMatch) {
                dynamicImportTimes.push(Number(dynamicMatch[1]));
            }
        }
    }

    const mean = startupTimes.reduce((a, b) => a + b, 0) / startupTimes.length;
    const sorted = startupTimes.slice().sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
    const min = Math.min(...startupTimes);
    const max = Math.max(...startupTimes);

    log.info(`Startup latency for memory ${memoryMbs} MB: Mean=${mean.toFixed(2)} ms, Median=${median.toFixed(2)} ms, Min=${min.toFixed(2)} ms, Max=${max.toFixed(2)} ms`);

    const dynamicImportBreakdown: Record<string, number> = {};

    // Include dynamic import times if applicable
    if (dynamicImportTimes.length > 0) {
        dynamicImportBreakdown.dynMean = dynamicImportTimes.reduce((a, b) => a + b, 0) / dynamicImportTimes.length;
        const dynSorted = dynamicImportTimes.slice().sort((a, b) => a - b);
        dynamicImportBreakdown.dynMedian = dynSorted.length % 2 === 0
            ? (dynSorted[dynSorted.length / 2 - 1] + dynSorted[dynSorted.length / 2]) / 2
            : dynSorted[Math.floor(dynSorted.length / 2)];
        dynamicImportBreakdown.dynMin = Math.min(...dynamicImportTimes);
        dynamicImportBreakdown.dynMax = Math.max(...dynamicImportTimes);

        log.info(`Dynamic import time for memory ${memoryMbs} MB: Mean=${dynamicImportBreakdown.dynMean.toFixed(2)} ms, Median=${dynamicImportBreakdown.dynMedian.toFixed(2)} ms, Min=${dynamicImportBreakdown.dynMin.toFixed(2)} ms, Max=${dynamicImportBreakdown.dynMax.toFixed(2)} ms`);
    }

    await Actor.pushData({
        median,
        mean,
        min,
        max,
        memoryMbs,
        iterations: iterationsPerConfig,
        allStartupTimes: startupTimes,
        dependenciesJson,
        ...dynamicImportBreakdown,
    })
}

await Actor.apifyClient.actor(state.actorId!).delete()

await Actor.exit();
