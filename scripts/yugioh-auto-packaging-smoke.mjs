// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests the raw worker/files supplied by includeFiles outside the repository.
// This checks runtime assets/resolution; it is not a Vercel build/deploy test.
import assert from 'node:assert/strict';
import {readFile, readdir, mkdir, copyFile, mkdtemp, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const workspace = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const config = JSON.parse(await readFile(path.join(workspace, 'vercel.json'), 'utf8'));
const rootPackage = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
const include = config.functions?.['api/yugioh-duel.js']?.includeFiles;
assert.equal(typeof include, 'string', 'Standalone function needs explicit runtime file inclusion.');
assert.equal(rootPackage.type, 'module', 'The raw .js worker requires its project ESM package scope.');
assert.equal(rootPackage.dependencies['ocgcore-wasm'], '0.1.6');
// The configuration intentionally uses one brace union of simple paths/globs.
// Reject future syntax we cannot model rather than silently mis-copy a bundle.
const alternatives = include.startsWith('{') && include.endsWith('}') ? include.slice(1, -1).split(',') : [include];
assert(alternatives.every(pattern => /^[a-zA-Z0-9_./*\-]+$/.test(pattern) && !pattern.split('/').includes('..')));
function globRegex(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') { expression += '.*'; index++; }
    else if (char === '*') expression += '[^/]*';
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`);
}
const patterns = alternatives.map(globRegex);
const candidates = [];
async function collect(directory) {
  for (const entry of await readdir(path.join(workspace, directory), {withFileTypes: true})) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(relative);
    else if (entry.isFile()) candidates.push(relative);
    else assert.fail(`Unexpected link/special file in function resources: ${relative}`);
  }
}
// Only enumerate the three directories that can contribute dynamic resources.
await collect('api');
await collect('node_modules/ocgcore-wasm');
const selected = candidates.filter(file => patterns.some(pattern => pattern.test(file)));
for (const required of ['api/_yugioh-auto-worker.js', 'api/_yugioh-auto-executor.js', 'api/_yugioh-auto-core.js', 'api/_yugioh-auto-resources.js', 'api/_yugioh-auto-prompts.js', 'api/_yugioh-auto-deck-rules.js', 'api/yugioh-auto-data/manifest.json', 'api/yugioh-auto-data/cards.json.gz', 'api/yugioh-auto-data/scripts.json.gz', 'node_modules/ocgcore-wasm/package.json', 'node_modules/ocgcore-wasm/dist/index.js']) assert(selected.includes(required), `includeFiles omits ${required}`);

const tempParent = await realpath(tmpdir());
const temporary = await mkdtemp(path.join(tempParent, 'fpt-yugioh-packaging-'));
const resolvedTemporary = await realpath(temporary);
assert.equal(path.dirname(resolvedTemporary), tempParent);
assert(path.basename(resolvedTemporary).startsWith('fpt-yugioh-packaging-'));
assert(!path.relative(workspace, resolvedTemporary).startsWith(`..${path.sep}`) || path.dirname(resolvedTemporary) === tempParent);
let bytes = 0;
try {
  // The function builder traces package.json for native ESM; copy the same
  // scope. All worker implementation/data files come from the actual glob.
  for (const file of ['package.json', ...selected]) {
    const destination = path.resolve(resolvedTemporary, file);
    const relative = path.relative(resolvedTemporary, destination);
    assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(path.join(workspace, file), destination);
    bytes += (await stat(destination)).size;
  }
  assert(bytes < 250 * 1024 * 1024, 'Worker resources exceed the standard function bundle limit.');
  const runner = `
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readdir} from 'node:fs/promises';
import {runAutoOperation,projectAutoStateSafe} from './api/_yugioh-auto-executor.js';
import {loadAutoResources} from './api/_yugioh-auto-resources.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const resolved=fileURLToPath(import.meta.resolve('ocgcore-wasm'));
assert(resolved.startsWith(path.join(root,'node_modules','ocgcore-wasm')+path.sep));
assert.deepEqual(await readdir(path.join(root,'node_modules')),['ocgcore-wasm']);
const resources=await loadAutoResources();
assert(resources.cards.size>14000&&resources.scripts.size>14000);
const main=[...resources.cards.values()].filter(card=>card.ot===3&&card.type===17&&!card.alias&&card.level<=4).slice(0,40).map(card=>card.code);
const setup={decks:[{main},{main}],names:['Packaged A','Packaged B'],seed:'123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0'};
const initial=await runAutoOperation('create',setup);
const prompt=initial.publicViews[0].auto.prompt||initial.publicViews[1].auto.prompt;
assert.equal(prompt.kind,'idle');
assert(prompt.options.some(option=>option.id==='to_ep'));
const input={state:initial,viewer:prompt.player,promptId:prompt.id,choice:{optionId:'to_ep'}};
const advanced=await runAutoOperation('apply',input);
const replay=await runAutoOperation('apply',JSON.parse(JSON.stringify(input)));
assert.deepEqual(advanced,replay);
assert.equal(advanced.inputs.length,1);
const practice=await runAutoOperation('createPractice',setup);
assert.equal(practice.passivePolicy,'passive-v1');
assert.equal(practice.publicViews[0].auto.prompt.player,0);
const publicView=projectAutoStateSafe(advanced,0);
for(const key of ['seed','initialDecks','inputs','pendingMessage','publicViews'])assert.equal(Object.hasOwn(publicView,key),false);
assert(publicView.players[1].hand.every(card=>card.hidden&&!card.code));
console.log(JSON.stringify({ok:true,engine:initial.engineVersion||initial.engine,cardCount:resources.cards.size,scriptCount:resources.scripts.size,inputs:advanced.inputs.length}));
`;
  await writeFile(path.join(resolvedTemporary, 'packaged-check.mjs'), runner);
  const environment = {...process.env, NODE_PATH: ''};
  delete environment.NODE_OPTIONS;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-global-search-paths', '--no-experimental-detect-module', 'packaged-check.mjs'], {cwd: resolvedTemporary, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated packaging check timed out.')); }, 55000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`Isolated worker failed (${code}): ${stderr || stdout}`)); });
  });
  assert.equal(JSON.parse(output).ok, true);
  console.log(`Yu-Gi-Oh automatic packaging smoke: ${selected.length} included resources, ${(bytes / 1024 / 1024).toFixed(2)} MiB; isolated worker create/apply/replay passed.`);
} finally {
  // Never recursively remove a computed path without proving it is the unique
  // direct child created by this test in the verified OS temporary directory.
  const finalPath = await realpath(resolvedTemporary);
  assert.equal(finalPath, resolvedTemporary);
  assert.equal(path.dirname(finalPath), tempParent);
  assert(path.basename(finalPath).startsWith('fpt-yugioh-packaging-'));
  await rm(finalPath, {recursive: true, force: true});
}
