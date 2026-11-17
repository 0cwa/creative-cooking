/** Browser fallback reports the actual copy result instead of assuming success. */
export async function copyText(text:string):Promise<boolean>{
 try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true}}catch{}
 let field:HTMLTextAreaElement|undefined;
 const previous=document.activeElement;
 try{
  field=document.createElement('textarea');field.value=text;field.readOnly=true;
  field.style.position='fixed';field.style.opacity='0';
  document.body.appendChild(field);field.select();
  return document.execCommand('copy')===true;
 }catch{return false}finally{field?.remove();if(previous instanceof HTMLElement)previous.focus({preventScroll:true})}
}
