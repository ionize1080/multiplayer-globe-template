import React from 'react';
import {bioGroup,type BioGroup} from '../taxonomy';
export type AtlasIconName=BioGroup|'climate'|'landform'|'minerals'|'plants'|'animals'|'bird'|'fish'|'insect'|'mammal';
const paths:Record<AtlasIconName,React.ReactNode>={
 unknown:<><circle cx="12" cy="12" r="8"/><path d="m8 12 4-4 4 4-4 4Z"/></>,
 plant:<path d="M12 21V9m0 7C4 17 3 12 3 7c6 0 9 3 9 7m0-3c0-7 4-9 9-9 0 6-3 10-9 10"/>,
 flower:<><path d="M12 21v-8m0 5c4 0 6-2 6-4-4 0-6 2-6 4M10.2 6.2C8 2 16 2 13.8 6.2c3.4-3.2 6 3.5 1.2 3.2 4 2.5-2 6.6-3 2-1 4.6-7 .5-3-2-4.8.3-2.2-6.4 1.2-3.2Z"/><circle cx="12" cy="8.3" r="1.5"/></>,
 grass:<path d="M11 22V4m0 13L5 7m6 5 5-8m-5 16 9-8M7 4v4m-4 2 4 1m10-9-1 4m3 3-3 1"/>,
 conifer:<path d="m12 2-5 7h3l-6 7h5l-3 3h12l-3-3h5l-6-7h3L12 2Zm0 17v3"/>,
 fern:<path d="M7 22c3-5 8-12 7-17-1-5-7-2-4 1m2 5-6-1m4 5-6-1m4 5-5-1m11-9 5-3m-6 7 6-2m-8 6 6-2"/>,
 moss:<><path d="M3 21h18M7 21V9m0 7-4-3m4 0 3-3m3 11V5m0 9 4-4m-4-2-3-3m8 16v-6"/><ellipse cx="7" cy="6" rx="2" ry="3"/><circle cx="13" cy="3" r="2"/></>,
 algae:<path d="M5 22c8-6-4-9 2-19m5 19c-5-8 7-9 1-20m6 20c-6-5 6-10 1-17M2 22h20"/>,
 arachnid:<><ellipse cx="12" cy="14" rx="3" ry="5"/><circle cx="12" cy="7" r="2"/><path d="m9 10-4-5-3 1m7 6L3 9l-2 3m8 3-6 1-1 4m7-2-3 4m9-12 4-5 3 1m-7 6 6-3 2 3m-8 3 6 1 1 4m-7-2 3 4"/></>,
 reptile:<path d="M3 21c7 0 4-8 8-10l5-6 4-1 1 4-6 6c-4 2-2 6-6 7M9 13l-5-2-2 2m12-3-1-5 2-2m-3 13 5 2 3-2"/>,
 amphibian:<><ellipse cx="12" cy="13" rx="5" ry="6"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="6" r="2"/><path d="m7 12-5 4 4 4-4 1m15-9 5 4-4 4 4 1M9 11h6"/></>,
 mollusc:<path d="M3 18c3 3 12 3 17 0l1-7m-2 4 3-3M4 17a7 7 0 1 1 12-4c-2 5-8 5-9 0-1-3 4-5 5-2 1 2-2 3-3 1"/>,
 crustacean:<><ellipse cx="12" cy="15" rx="6" ry="4"/><path d="M6 14 3 9m15 5 3-5M6 16l-4 2m16-2 4 2M7 18l-3 3m13-3 3 3M3 9C-1 7 2 2 4 3L3 6l4-3c2 4 0 7-4 6m18 0c4-2 1-7-1-6l1 3-4-3c-2 4 0 7 4 6M10 11V9m4 2V9"/></>,
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
export function recordIcon(kind:string,layer:string,group?:BioGroup):AtlasIconName{return layer==='minerals'?'minerals':group||bioGroup({class:kind},layer);}
