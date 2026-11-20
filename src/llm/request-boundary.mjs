/** A provider hands its final serialized body to the optional per-request gate.
 * Credentials stay in the closure and never enter the review record. */
export async function dispatchProviderRequest({endpoint,model,body,headers,signal,dispatch,fetcher=fetch}) {
 if(typeof endpoint!=='string'||typeof model!=='string'||typeof body!=='string'||!headers)throw Error('MALFORMED_REQUEST');
 const request=Object.freeze({endpoint,model,body});let dispatched=false;
 const send=()=>{if(dispatched)throw Error('REQUEST_ALREADY_DISPATCHED');dispatched=true;return fetcher(endpoint,{method:'POST',headers,signal,body,...(dispatch?{redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'}:{})})};
 return dispatch?dispatch(request,send):send();
}
