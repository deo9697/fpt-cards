// Local-only report from a collection export; never connects to the database.
// node scripts/report-collection-alias-gaps.mjs path/to/collection.json
import { readFile } from 'node:fs/promises';
import { collectionAliasGaps } from '../js/collection-search.js';
const filename = process.argv[2];
if (!filename) throw Error('Pass a local collection JSON export (array or {mine:[...]})');
const data = JSON.parse(await readFile(filename,'utf8'));
const items = Array.isArray(data) ? data : data.mine;
if (!Array.isArray(items)) throw Error('Expected an array or collection.mine');
console.log(JSON.stringify(collectionAliasGaps(items),null,2));
