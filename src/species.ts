export type SpeciesPhoto={url:string;source:string;credit:string;license:string;reference:boolean};
export type SpeciesDetails={chineseName:string;nameSource:string;scientificName:string;taxonomy:{label:string;value:string}[];facts:{label:string;value:string}[];photos:SpeciesPhoto[];links:{label:string;url:string}[];partial:boolean};
export const textValue=(v:unknown,max=300)=>typeof v==='string'?v.slice(0,max):'';
export function safeHttps(v:unknown){try{const u=new URL(textValue(v,2000));return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
export function chineseName(v:unknown){const s=textValue(v);return /[\u3400-\u9fff]/u.test(s)?s:'';}
// Only the documented iNaturalist photo service supports these size variants.
// Preserve the original URL for provenance and as a fallback; never rewrite other providers.
export function speciesPreviewUrl(value:string){
 const safe=safeHttps(value);if(!safe)return value;
 const url=new URL(safe);
 if(url.port||url.search||!['static.inaturalist.org','inaturalist-open-data.s3.amazonaws.com'].includes(url.hostname))return value;
 if(!/^\/photos\/\d+\/(original|large)\.(jpe?g|png|webp)$/i.test(url.pathname))return value;
 url.pathname=url.pathname.replace(/\/(original|large)\./i,'/medium.');return url.href;
}
// Only reuse photos with an explicit Creative Commons licence; retain original attribution.
export function photoLicense(v:unknown){const s=textValue(v).toLowerCase();const m=s.match(/^https?:\/\/creativecommons\.org\/(licenses\/(by(?:-nc)?(?:-sa|-nd)?)|publicdomain\/(zero))\/([\d.]+)\/?$/);if(m)return m[3]?'CC0':`CC ${m[2].toUpperCase()} ${m[4]}`;return /^(cc0|cc-by(?:-nc)?(?:-sa|-nd)?)$/.test(s)?s.toUpperCase():'';}
