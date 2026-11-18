// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side adapter only: every operation is scoped to an authenticated owner.
export function createPracticeStore(admin){
  const value=result=>{if(result.error)throw result.error;return result.data;};
  return{
    async get(teamId,owner){return value(await admin.from('yugioh_practice_sessions').select('*').eq('team_id',teamId).eq('owner_slug',owner).maybeSingle());},
    async insert(row){const result=await admin.from('yugioh_practice_sessions').insert(row).select('*').maybeSingle();if(result.error?.code==='23505')return null;return value(result);},
    async update(id,version,teamId,owner,patch){return value(await admin.from('yugioh_practice_sessions').update(patch).eq('id',id).eq('team_id',teamId).eq('owner_slug',owner).eq('version',version).select('id,version,updated_at').maybeSingle());}
  };
}
