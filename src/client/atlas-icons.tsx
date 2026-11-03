import React from 'react';
export type AtlasIconName='climate'|'landform'|'minerals'|'plants'|'animals'|'bird'|'fish'|'insect'|'mammal';
const paths:Record<AtlasIconName,React.ReactNode>={
 climate:<><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c-5 5-5 11 0 16 5-5 5-11 0-16M6 7.5c4 2 8 2 12 0M6 16.5c4-2 8-2 12 0"/></>,
 landform:<><path d="m2 19 7-14 5 8 3-5 5 11H2Z"/><path d="m6 11 3 2 3-3m2 9 3-6 2 2M9 5l2 14"/></>,
 minerals:<><path d="m4 8 4-4h8l4 4-8 13L4 8Z"/><path d="M4 8h16M8 4l-1 4 5 13 5-13-1-4M7 8l5-4 5 4"/></>,
 plants:<><path d="M12 21V9m0 7C4 17 3 12 3 7c6 0 9 3 9 7m0-3c0-7 4-9 9-9 0 6-3 10-9 10M7 11l5 5m5-10-5 5"/></>,
 animals:<><path d="M6 18c0-3 3-6 6-6s6 3 6 6c0 3-4 1-6 1s-6 2-6-1Z"/><ellipse cx="5" cy="10" rx="2" ry="3" transform="rotate(-25 5 10)"/><ellipse cx="10" cy="6" rx="2" ry="3"/><ellipse cx="16" cy="6" rx="2" ry="3"/><ellipse cx="20" cy="11" rx="2" ry="3" transform="rotate(25 20 11)"/></>,
 bird:<><path d="M3 14c4 1 6-1 7-4L6 4c5 0 7 3 8 5 3-3 6-2 7 0l2 2-4 1c-1 6-8 8-16 2Z"/><path d="m9 18-1 3m6-4 1 3"/><circle cx="18" cy="9" r=".5"/></>,
 fish:<><path d="M4 12c5-8 11-8 16 0-5 8-11 8-16 0Zm0 0-3-4v8l3-4Z"/><path d="m10 6 3-3 2 4m-5 11 3 3 2-4m1-10c-2 3-2 5 0 8"/><circle cx="17" cy="11" r=".5"/></>,
 insect:<><ellipse cx="12" cy="14" rx="4" ry="7"/><path d="M12 7v14M8 11 3 7m5 7H2m7 3-5 4m12-10 5-4m-5 7h6m-7 3 5 4M10 7 8 3m6 4 2-4"/></>,
 mammal:<><path d="M5 10 3 3l7 4h4l7-4-2 7v5l-7 7-7-7v-5Z"/><path d="m8 12 1 1m7-1-1 1m-5 4h4l-2 2-2-2Z"/></>
};
export function AtlasIcon({name,size=24}:{name:AtlasIconName;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;}
export function recordIcon(kind:string,layer:string):AtlasIconName{if(layer==='minerals')return 'minerals';if(layer==='plants')return 'plants';return kind==='Aves'?'bird':kind==='Mammalia'?'mammal':kind==='Insecta'?'insect':kind==='Actinopterygii'?'fish':'animals';}
