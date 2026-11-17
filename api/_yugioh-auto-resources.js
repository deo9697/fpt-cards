// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side immutable resources. This module does not fetch or execute remote
// content, nor does it expose card scripts/database rows to duel participants.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

export const AUTO_RESOURCE_VERSION='ignis-14f3b8905ff9-babel-6e21009855ed';
const directory=new URL('./yugioh-auto-data/',import.meta.url);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let pending;
async function checkedAsset(manifest,name){
  const entry=manifest.artifacts.find(item=>item.file===name);if(!entry||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>20000000||!/^[a-f0-9]{64}$/.test(entry.sha256)||!/^[a-f0-9]{64}$/.test(entry.decodedSha256))throw new Error('Automatic resource manifest is invalid.');
  const compressed=await readFile(new URL(name,directory));
  if(compressed.length!==entry.bytes||digest(compressed)!==entry.sha256)throw new Error(`Automatic resource integrity failure: ${name}`);
  const raw=gunzipSync(compressed,{maxOutputLength:90000000});
  if(raw.length!==entry.decodedBytes||digest(raw)!==entry.decodedSha256)throw new Error(`Automatic decoded resource integrity failure: ${name}`);
  const payload=JSON.parse(raw.toString('utf8'));
  if(payload.schema!==1||payload.version!==AUTO_RESOURCE_VERSION)throw new Error('Automatic resource versions do not match.');
  return payload;
}
async function readResources(){
  const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
  if(manifest.schema!==1||manifest.version!==AUTO_RESOURCE_VERSION||!Array.isArray(manifest.artifacts))throw new Error('Automatic resources are unavailable or incompatible.');
  const [cardPayload,scriptPayload]=await Promise.all([checkedAsset(manifest,'cards.json.gz'),checkedAsset(manifest,'scripts.json.gz')]);
  if(!Array.isArray(cardPayload.cards)||!Array.isArray(scriptPayload.scripts))throw new Error('Automatic resource payload is invalid.');
  const cards=new Map(),strings=new Map(),scripts=new Map();
  for(const row of cardPayload.cards){
    if(!Number.isSafeInteger(row.code)||row.code<1||cards.has(row.code)||!Array.isArray(row.setcodes)||typeof row.race!=='string'||!/^\d{1,20}$/.test(row.race))throw new Error('Automatic card database is invalid.');
    const card={...row,race:BigInt(row.race),setcodes:Object.freeze([...row.setcodes])};
    cards.set(row.code,Object.freeze(card));
    for(let index=0;index<16;index++){const text=row[`str${index+1}`];if(text)strings.set(row.code*16+index,text);}
  }
  for(const entry of scriptPayload.scripts){
    if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||typeof entry[1]!=='string'||!entry[0].endsWith('.lua')||entry[0].split('/').includes('..')||scripts.has(entry[0]))throw new Error('Automatic script collection is invalid.');
    scripts.set(entry[0],entry[1]);
  }
  // ocgcore asks for c<passcode>.lua; retain the original upstream path too.
  // Prefer released scripts if an upstream pre-release variant shares a name.
  for(const directory of ['official/','pre-release/'])for(const[name,script]of [...scripts])if(name.startsWith(directory)&&!scripts.has(name.slice(directory.length)))scripts.set(name.slice(directory.length),script);
  if(cards.size!==manifest.counts.cards||scriptPayload.scripts.length!==manifest.counts.scripts)throw new Error('Automatic resource counts do not match the manifest.');
  return Object.freeze({cards,scripts,strings,version:AUTO_RESOURCE_VERSION});
}
export async function loadAutoResources(){return pending??=readResources();}
