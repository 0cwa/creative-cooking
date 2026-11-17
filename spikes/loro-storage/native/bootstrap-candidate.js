// Candidate key-catalog stage for a native workspace bootstrap. Workspace authority,
// routing and recovery UI still need a separately integrated bootstrap.
export async function provisionNativeCatalog({storage,master,sodium,masterId,identities}) {
 if(!storage || !master || !sodium || typeof masterId!=='string' || !Array.isArray(identities))throw Error('MALFORMED');
 const keys=storage.localKeys(master,sodium);
 await keys.provision(masterId);
 const publicKeys=[];
 for(const {operationId,identity} of identities) publicKeys.push(await keys.generate(operationId,identity));
 await keys.unlock();
 return {keys,publicKeys};
}
