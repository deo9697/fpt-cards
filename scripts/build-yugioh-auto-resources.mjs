// SPDX-License-Identifier: AGPL-3.0-or-later
// Build once from pinned, public upstream resources. Runtime never downloads Lua.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const destination=path.join(root,'api','yugioh-auto-data');
const pins={scripts:'14f3b8905ff95a8f869fd6891aec4d6b580db1e1',cards:'6e21009855ed5f3b5966a24545bd0db393d44697'};
const version=`ignis-${pins.scripts.slice(0,12)}-babel-${pins.cards.slice(0,12)}`;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const lexical=(a,b)=>a<b?-1:a>b?1:0;
async function download(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(90000),headers:{'User-Agent':'FPT-Cards-resource-builder'}});
  if(!response.ok)throw new Error(`Resource download failed (${response.status}): ${url}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>40000000)throw new Error('Upstream archive exceeds the resource build limit.');
  return bytes;
}
function tarFiles(archive){
  const bytes=gunzipSync(archive,{maxOutputLength:150000000}),files=new Map();
  let longName=null;
  for(let offset=0;offset+512<=bytes.length;){
    const header=bytes.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
    const string=(start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
    const size=parseInt(string(124,12).trim()||'0',8),type=string(156,1),prefix=string(345,155);
    const name=longName||(prefix?`${prefix}/`:'')+string(0,100);longName=null;
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>bytes.length)throw new Error('Invalid upstream tar entry.');
    const body=bytes.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;
    if(type==='L'){longName=body.toString('utf8').replace(/\0.*$/s,'');continue;}
    if(type!=='0'&&type!=='')continue;
    const relative=name.split('/').slice(1).join('/');
    if(!relative||relative.split('/').some(segment=>segment==='..')||relative.startsWith('/'))throw new Error('Unsafe resource archive path.');
    files.set(relative,body);
  }
  return files;
}
const number=value=>Number(value??0n);
function decodeCard(data,text){
  const type=number(data.type),level=BigInt.asUintN(32,data.level??0n),link=Boolean(type&0x4000000);
  let packed=BigInt.asUintN(64,data.setcode??0n);const setcodes=[];
  while(packed){const code=Number(packed&0xffffn);if(code)setcodes.push(code);packed>>=16n;}
  const card={code:number(data.id),alias:number(data.alias),setcodes,type,level:Number(level&255n),attribute:number(data.attribute),race:BigInt.asUintN(64,data.race??0n).toString(),attack:number(data.atk),defense:link?0:number(data.def),lscale:Number((level>>24n)&255n),rscale:Number((level>>16n)&255n),link_marker:link?number(data.def):0,ot:number(data.ot),name:String(text?.name||''),desc:String(text?.desc||'')};
  for(let index=1;index<=16;index++)card[`str${index}`]=String(text?.[`str${index}`]||'');
  return card;
}
async function writeAsset(name,payload){
  const raw=Buffer.from(JSON.stringify(payload)),compressed=gzipSync(raw,{level:9});
  await fs.writeFile(path.join(destination,name),compressed);
  return{file:name,bytes:compressed.length,sha256:sha256(compressed),decodedBytes:raw.length,decodedSha256:sha256(raw)};
}

const sources=[
  {kind:'scripts',repository:'https://github.com/ProjectIgnis/CardScripts',commit:pins.scripts,url:`https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/${pins.scripts}`},
  {kind:'cards',repository:'https://github.com/ProjectIgnis/BabelCDB',commit:pins.cards,url:`https://codeload.github.com/ProjectIgnis/BabelCDB/tar.gz/${pins.cards}`}
];
const downloads=await Promise.all(sources.map(async source=>{const bytes=await download(source.url);return{...source,bytes:bytes.length,sha256:sha256(bytes),files:tarFiles(bytes)};}));
const scriptFiles=downloads[0].files,cardFiles=downloads[1].files;
const scripts=[...scriptFiles.entries()].filter(([name])=>name.endsWith('.lua')&&(!name.includes('/')||name.startsWith('official/')||name.startsWith('pre-release/'))).sort(([a],[b])=>lexical(a,b)).map(([name,bytes])=>[name,bytes.toString('utf8')]);
for(const required of ['constant.lua','utility.lua','official/c12580477.lua','official/c83764718.lua'])if(!scripts.some(([name])=>name===required))throw new Error(`Missing required script: ${required}`);
const databases=[...cardFiles.keys()].filter(name=>!name.includes('/')&&(name==='cards.cdb'||/^(?:release|prerelease)-.*\.cdb$/.test(name))&&!/rush|skill|unofficial/.test(name)).sort((a,b)=>a==='cards.cdb'?-1:b==='cards.cdb'?1:lexical(a,b));
const cards=new Map(),databaseManifest=[];
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'fpt-auto-card-build-'));
try{
  for(const [index,name]of databases.entries()){
    const bytes=cardFiles.get(name),file=path.join(temporary,`${index}.cdb`);await fs.writeFile(file,bytes);
    const database=new DatabaseSync(file,{readOnly:true});
    try{
      const dataStatement=database.prepare('SELECT * FROM datas ORDER BY id');dataStatement.setReadBigInts(true);
      const textStatement=database.prepare('SELECT * FROM texts ORDER BY id');textStatement.setReadBigInts(true);
      const texts=new Map(textStatement.all().map(row=>[number(row.id),row]));
      const rows=dataStatement.all();for(const row of rows)cards.set(number(row.id),decodeCard(row,texts.get(number(row.id))));
      databaseManifest.push({file:name,bytes:bytes.length,sha256:sha256(bytes),cards:rows.length});
    }finally{database.close();}
    await fs.unlink(file);
  }
}finally{
  // Every temporary file is an explicit file created above; never remove a
  // computed directory recursively or touch a user's resource checkout.
  for(const name of await fs.readdir(temporary))if(/^\d+\.cdb$/.test(name))await fs.unlink(path.join(temporary,name));
  await fs.rmdir(temporary);
}
const cardRows=[...cards.values()].sort((a,b)=>a.code-b.code);
for(const code of [89631139,12580477,83764718,5318639])if(!cards.has(code))throw new Error(`Missing baseline card: ${code}`);
await fs.mkdir(destination,{recursive:true});
const artifacts=await Promise.all([writeAsset('cards.json.gz',{schema:1,version,cards:cardRows}),writeAsset('scripts.json.gz',{schema:1,version,scripts})]);
const manifest={schema:1,version,sources:downloads.map(({files,...source})=>source),databases:databaseManifest,counts:{cards:cards.size,scripts:scripts.length},artifacts};
await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(path.join(destination,'COPYING.CardScripts'),scriptFiles.get('COPYING'));
await fs.writeFile(path.join(destination,'NOTICE.md'),`# Automatic duel resource notices\n\nThis directory is generated by \`scripts/build-yugioh-auto-resources.mjs\`. Do not edit generated archives. The manifest records pinned upstream commits and SHA-256 checksums; runtime loads only these checked local resources. No artwork is included.\n\n## Card scripts\n\nCanonical Project Ignis card scripts and support Lua files, copyright Project Ignis contributors and the authors credited in each script. Source: https://github.com/ProjectIgnis/CardScripts/tree/${pins.scripts}\n\nLicense: GNU Affero General Public License version 3 or later. The unmodified license text is included in \`COPYING.CardScripts\`. Original author notices remain inside every script. Corresponding pinned source archive: https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/${pins.scripts}\n\n## Card database\n\nMachine-readable card metadata and text come from Project Ignis BabelCDB at ${pins.cards}. Source: https://github.com/ProjectIgnis/BabelCDB/tree/${pins.cards}\n\nThe upstream repository does not include an explicit software license for its database content; this notice does not relicense that content as MIT or AGPL. Card names, text and game properties remain attributable to their respective rights holders. No permission for artwork is implied or granted.\n\n## Engine\n\nThe runtime wrapper and its underlying duel engine are separate dependencies. The wrapper's package license does not override the upstream core or card-script licenses. See the application's dependency notices and source links.\n`);
console.log(JSON.stringify({version,counts:manifest.counts,artifacts:artifacts.map(({file,bytes,sha256})=>({file,bytes,sha256}))},null,2));
