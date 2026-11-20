/** Only a verified sponsor or a mutable, unpaired workspace exposes these controls. */
export function adultRemovalWorkspaceAccess({adultRemoval,readOnly,installedSet}) {
 if(adultRemoval?.role==='sponsor')return 'sponsor';
 return !readOnly&&!installedSet?.paired?'mutable':null;
}
